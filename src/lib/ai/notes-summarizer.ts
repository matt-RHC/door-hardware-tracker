/**
 * AI summarization for the punch-notes feature.
 *
 * Two entry points:
 *   - summarizeOpeningNotes()  — single opening, takes its item/leaf/opening
 *     scope notes plus the door label + item names, returns markdown.
 *   - summarizeProjectPunchNotes() — whole project, takes the per-opening
 *     summaries the caller has already computed plus the project-scope notes,
 *     returns a project-level rollup.
 *
 * Both functions follow the issue-parser.ts pattern:
 *   - createAnthropicClient() (maxRetries:2, timeout:290s)
 *   - tool_use for structured output (single field `summary_markdown`)
 *   - throws on infrastructure errors so the calling route can surface a
 *     classified Sentry alert (matches the CP1/CP2/CP3 pattern in
 *     parse-pdf-helpers.ts but with a notes-specific fingerprint).
 *
 * The chunking strategy (opening summaries → project summary) is by design,
 * not a workaround: it keeps prompts under the model's effective context
 * window even for projects with thousands of notes, and lets the project-
 * level prompt focus on patterns/themes across openings rather than verbatim
 * note text.
 */

import * as Sentry from '@sentry/nextjs'
import type Anthropic from '@anthropic-ai/sdk'
import {
  createAnthropicClient,
  classifyDarrinInfrastructureError,
} from '@/lib/parse-pdf-helpers'
import type { Note } from '@/lib/types/notes'

/** Model used for both opening-level and project-level summarization.
 *  Sonnet (not Haiku) because the task involves multi-paragraph synthesis
 *  with implicit categorization — Haiku produces visibly worse rollups in
 *  spot tests. Cost is acceptable: a typical opening summary is ~1k input
 *  tokens, a project rollup ~5-10k. */
const MODEL = 'claude-sonnet-4-5-20250929'

const MAX_OUTPUT_TOKENS = 1500

export interface SummarizerResult {
  /** Markdown the UI renders verbatim. Bounded by MAX_OUTPUT_TOKENS but
   *  the model is asked to keep summaries concise (~3-8 paragraphs for
   *  openings, ~5-15 for projects). */
  summary: string
  tokenUsage: {
    input_tokens: number
    output_tokens: number
  }
}

const SUMMARY_TOOL: Anthropic.Messages.Tool = {
  name: 'write_summary',
  description: 'Write the markdown summary of the notes provided.',
  input_schema: {
    type: 'object' as const,
    properties: {
      summary_markdown: {
        type: 'string',
        description:
          'Markdown summary suitable for direct display. Use bullet lists, ' +
          'short paragraphs, and **bold** for the most important findings. ' +
          'No headings deeper than ## (h2). No code blocks. No HTML.',
      },
    },
    required: ['summary_markdown'],
  },
}

const OPENING_SYSTEM_PROMPT = `You are a punch-list assistant for a door hardware project.

You're given the raw notes a foreman, project manager, or installer left on a single opening (one door or door pair) in a construction project. Notes can be at the item level (a specific hardware item like hinges or a closer), the leaf level (active vs inactive vs shared sides of a pair-leaf opening), or the opening level (the door as a whole).

Your job is to synthesize these notes into a short markdown summary that a project manager could scan to understand the punch-list state of this opening.

Guidelines:
- Group by theme (e.g. damage, missing parts, finish issues, ADA/code concerns) — not by who wrote what.
- Lead with anything safety-critical or fire-rated.
- If multiple notes contradict each other, mention the contradiction; don't pick a side.
- Use the door number and item names provided in the user message — do NOT invent names.
- Keep it short. Most openings need 3-8 paragraphs / bullet points total.
- If there are no real issues — just observations or completed work — say so plainly. Don't pad.
- Use **bold** sparingly, only for the most important finding(s).
- Do NOT mention dates, authors, or note ids — those are visible elsewhere in the UI.`

const PROJECT_SYSTEM_PROMPT = `You are a punch-list assistant assembling a project-level rollup.

You're given two inputs:
1. A list of per-opening AI summaries (one per door/opening that has notes).
2. The raw project-scope notes (notes attached to the project as a whole, not a specific opening).

Your job is to write a project-level markdown summary that a GC, client, or executive could read to understand the state of the punch-list across the entire project. Think of this as the executive summary that sits above the per-opening details in the punch-list document.

Guidelines:
- Surface patterns and themes that span multiple openings. (e.g. "Closers on 12 doors are reporting low-cycle damage" is more valuable than enumerating each opening.)
- Lead with anything safety-critical, fire-rated, or that would block project closeout.
- Reference specific door numbers when calling out individual openings — but use them sparingly. The reader will see per-opening detail below.
- Project-scope notes typically describe site-wide concerns (a delivery problem, a spec change, a GC instruction). Weave them in where relevant rather than listing them separately.
- Keep it short — most projects need 5-15 paragraphs / bullet points total. This sits at the top of a longer document; conciseness here is the value.
- Use ## (h2) for section headers if grouping by theme is helpful.
- Use **bold** for the highest-priority items.
- Do NOT mention dates, authors, or counts of notes — those are visible elsewhere.`

/**
 * Summarize the notes for a single opening.
 *
 * @param doorNumber  Display label for the opening, e.g. "110-02C". Passed
 *                    through into the prompt so the model has a stable name
 *                    to refer to.
 * @param notes       Item, leaf, and opening-scope notes for this opening,
 *                    in any order. The function groups them in the prompt.
 * @param itemNames   Map of hardware_item_id → display name, used to
 *                    annotate item-scope notes ("Hinges: …" instead of
 *                    "uuid: …").
 *
 * @throws Error      If the Anthropic call fails. Infrastructure errors
 *                    (credit balance, rate limit, context length, auth)
 *                    are also fired as Sentry messages with a notes-specific
 *                    fingerprint so they group separately from extraction
 *                    failures. Calling routes should surface a friendly
 *                    error message.
 */
export async function summarizeOpeningNotes(
  doorNumber: string,
  notes: Note[],
  itemNames: Record<string, string | null>,
): Promise<SummarizerResult> {
  if (notes.length === 0) {
    // No notes → no summary. Empty string is the unambiguous signal.
    return { summary: '', tokenUsage: { input_tokens: 0, output_tokens: 0 } }
  }

  const userPrompt = buildOpeningPrompt(doorNumber, notes, itemNames)

  try {
    const client = createAnthropicClient()
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: OPENING_SYSTEM_PROMPT,
      tools: [SUMMARY_TOOL],
      tool_choice: { type: 'tool', name: 'write_summary' },
      messages: [{ role: 'user', content: userPrompt }],
    })
    return extractSummaryResult(response)
  } catch (err) {
    captureNotesInfrastructureError('opening', err, { doorNumber })
    throw err
  }
}

/**
 * Assemble a project-level summary from per-opening summaries + project-scope
 * notes. The caller is responsible for ensuring opening summaries are fresh
 * (the route that calls this one regenerates stale opening summaries first).
 *
 * @param projectName            Display name for the project.
 * @param openingSummaries       Per-opening summaries, keyed by door_number.
 *                                Pass only openings that actually have notes.
 * @param projectScopeNotes      Notes whose scope is 'project' (no opening
 *                                or item attached).
 *
 * @throws Error                  Same Sentry-classified infra error semantics
 *                                as summarizeOpeningNotes.
 */
export async function summarizeProjectPunchNotes(
  projectName: string,
  openingSummaries: Array<{ door_number: string; summary: string }>,
  projectScopeNotes: Note[],
): Promise<SummarizerResult> {
  if (openingSummaries.length === 0 && projectScopeNotes.length === 0) {
    return { summary: '', tokenUsage: { input_tokens: 0, output_tokens: 0 } }
  }

  const userPrompt = buildProjectPrompt(projectName, openingSummaries, projectScopeNotes)

  try {
    const client = createAnthropicClient()
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: PROJECT_SYSTEM_PROMPT,
      tools: [SUMMARY_TOOL],
      tool_choice: { type: 'tool', name: 'write_summary' },
      messages: [{ role: 'user', content: userPrompt }],
    })
    return extractSummaryResult(response)
  } catch (err) {
    captureNotesInfrastructureError('project', err, { projectName })
    throw err
  }
}

// ── prompt builders ──────────────────────────────────────────────────────

/** Group notes by scope and render a structured prompt the model can parse. */
function buildOpeningPrompt(
  doorNumber: string,
  notes: Note[],
  itemNames: Record<string, string | null>,
): string {
  const openingScope = notes.filter(n => n.scope === 'opening')
  const leafScope = notes.filter(n => n.scope === 'leaf')
  const itemScope = notes.filter(n => n.scope === 'item')

  const lines: string[] = [`Door: ${doorNumber}`, '']

  if (openingScope.length > 0) {
    lines.push('## Opening-level notes')
    for (const n of openingScope) {
      lines.push(`- ${n.original_text.trim()}`)
    }
    lines.push('')
  }

  if (leafScope.length > 0) {
    lines.push('## Leaf-level notes')
    // Sub-group by leaf_side for readability.
    for (const side of ['active', 'inactive', 'shared'] as const) {
      const sideNotes = leafScope.filter(n => n.scope === 'leaf' && n.leaf_side === side)
      if (sideNotes.length === 0) continue
      lines.push(`### ${side} leaf`)
      for (const n of sideNotes) {
        lines.push(`- ${n.original_text.trim()}`)
      }
    }
    lines.push('')
  }

  if (itemScope.length > 0) {
    lines.push('## Item-level notes')
    // Group by item so all notes on the same item appear together.
    const byItem = new Map<string, Note[]>()
    for (const n of itemScope) {
      if (n.scope !== 'item' || !n.hardware_item_id) continue
      const arr = byItem.get(n.hardware_item_id) ?? []
      arr.push(n)
      byItem.set(n.hardware_item_id, arr)
    }
    for (const [itemId, itemNotes] of byItem) {
      const label = itemNames[itemId] ?? '(unknown item)'
      lines.push(`### ${label}`)
      for (const n of itemNotes) {
        lines.push(`- ${n.original_text.trim()}`)
      }
    }
    lines.push('')
  }

  lines.push('Write a markdown summary of the punch-list state of this opening.')
  return lines.join('\n')
}

function buildProjectPrompt(
  projectName: string,
  openingSummaries: Array<{ door_number: string; summary: string }>,
  projectScopeNotes: Note[],
): string {
  const lines: string[] = [`Project: ${projectName}`, '']

  if (openingSummaries.length > 0) {
    lines.push('## Per-opening summaries')
    for (const { door_number, summary } of openingSummaries) {
      lines.push(`### Door ${door_number}`)
      lines.push(summary.trim())
      lines.push('')
    }
  }

  if (projectScopeNotes.length > 0) {
    lines.push('## Project-scope notes')
    for (const n of projectScopeNotes) {
      lines.push(`- ${n.original_text.trim()}`)
    }
    lines.push('')
  }

  lines.push(
    'Write the project-level executive summary that sits above the per-opening detail.',
  )
  return lines.join('\n')
}

// ── response handling ────────────────────────────────────────────────────

function extractSummaryResult(response: Anthropic.Messages.Message): SummarizerResult {
  const tokenUsage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  }

  const toolBlock = response.content.find(
    (block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use',
  )
  if (!toolBlock) {
    // Model didn't follow the tool — surface as parse failure, not infra.
    throw new Error('notes-summarizer: model did not return a tool_use block')
  }

  const parsed = toolBlock.input as { summary_markdown?: unknown }
  const summary = typeof parsed.summary_markdown === 'string' ? parsed.summary_markdown.trim() : ''
  if (!summary) {
    throw new Error('notes-summarizer: tool input missing summary_markdown')
  }
  return { summary, tokenUsage }
}

// ── Sentry capture for infrastructure errors ─────────────────────────────

/** Distinct fingerprint per surface so opening-level and project-level
 *  failures group separately in Sentry — different remediation paths. */
type SummarizerSurface = 'opening' | 'project'

function captureNotesInfrastructureError(
  surface: SummarizerSurface,
  err: unknown,
  extra: Record<string, unknown>,
): void {
  const message = err instanceof Error ? err.message : String(err)
  const category = classifyDarrinInfrastructureError(message)
  if (!category) return // ordinary error — let the route's logger handle it

  try {
    const level = category === 'credit_balance' || category === 'auth' ? 'fatal' : 'error'
    Sentry.captureMessage(`Notes-summarizer ${category} error (${surface})`, {
      level,
      fingerprint: ['notes-summarizer-infra', category, surface],
      tags: {
        'notes_summarizer.surface': surface,
        'notes_summarizer.error_category': category,
      },
      extra: {
        ...extra,
        category,
        messageSnippet: message.substring(0, 500),
      },
    })
  } catch {
    // Sentry hiccup must never break the user's request beyond the
    // already-thrown summarizer error.
  }
}
