/**
 * Shared helpers for the PDF extraction pipeline.
 * Canonical implementations extracted from chunk/route.ts (S-067 consolidation).
 */
import Anthropic from '@anthropic-ai/sdk'
import {
  getColumnMappingReviewPrompt,
  getPostExtractionReviewPrompt,
  getQuantityCheckPrompt,
  getDeepExtractionPrompt,
} from '@/lib/punchy-prompts'
import type {
  DoorEntry,
  ExtractedHardwareItem,
  HardwareSet,
  PdfplumberFlaggedDoor,
  PunchyColumnReview,
  PunchyCorrections,
  PunchyQuantityCheck,
} from '@/lib/types'
import { extractJSON } from '@/lib/extractJSON'
import { HARDWARE_TAXONOMY, type InstallScope } from '@/lib/hardware-taxonomy'
import { createAdminSupabaseClient } from '@/lib/supabase/server'

// --- Punchy observation logging (fire-and-forget) ---

/**
 * Log a Punchy checkpoint call to the `punchy_logs` table for observability.
 * Fire-and-forget — never awaited, never throws, never blocks the parse flow.
 */
function logPunchyCall(opts: {
  projectId?: string
  extractionRunId?: string
  checkpoint: 1 | 2 | 3
  inputSnapshot: Record<string, unknown>
  response: unknown
  parseOk: boolean
  inputTokens?: number
  outputTokens?: number
  latencyMs: number
}): void {
  try {
    const supabase = createAdminSupabaseClient()
    supabase
      .from('punchy_logs')
      .insert({
        project_id: opts.projectId ?? null,
        extraction_run_id: opts.extractionRunId ?? null,
        checkpoint: opts.checkpoint,
        input_snapshot: opts.inputSnapshot,
        response: opts.response as Record<string, unknown>,
        parse_ok: opts.parseOk,
        input_tokens: opts.inputTokens ?? null,
        output_tokens: opts.outputTokens ?? null,
        latency_ms: opts.latencyMs,
      })
      .then(({ error }) => {
        if (error) console.warn('Punchy log insert failed:', error.message)
      })
      .catch((err: unknown) => {
        console.warn('Punchy log insert error:', err instanceof Error ? err.message : String(err))
      })
  } catch (err) {
    // createAdminSupabaseClient can fail if env vars are missing (e.g. in tests)
    console.warn('Punchy log skipped (no admin client):', err instanceof Error ? err.message : String(err))
  }
}

// --- Category classification for quantity normalization ---

/** Compiled regex cache for hardware taxonomy name patterns. */
const _taxonomyRegexCache: Array<{ id: string; install_scope: InstallScope; patterns: RegExp[] }> =
  HARDWARE_TAXONOMY.map(cat => ({
    id: cat.id,
    install_scope: cat.install_scope,
    patterns: cat.name_patterns.map(p => new RegExp(p, 'i')),
  }))

/**
 * Classify a hardware item name into a taxonomy category.
 * Returns the install_scope for the matched category, or null if unrecognized.
 * Mirrors Python's _classify_hardware_item() at extract-tables.py:173.
 */
export function classifyItemScope(name: string): InstallScope | null {
  for (const cat of _taxonomyRegexCache) {
    for (const rx of cat.patterns) {
      if (rx.test(name)) return cat.install_scope
    }
  }
  return null
}

/**
 * Terminal `qty_source` values that must NOT be re-normalized.
 *
 * Every normalization entry point (`normalizeQuantities` here, save/route.ts,
 * apply-revision/route.ts) must check this set before dividing a qty. Values
 * in this set represent a qty that is already per-opening / per-leaf / final
 * for one of these reasons:
 *
 *   - 'divided' / 'flagged' / 'capped' — produced by a prior normalization
 *     pass. Re-dividing would compound the division.
 *   - 'llm_override' — Punchy explicitly corrected the qty. Punchy's prompt
 *     at punchy-prompts.ts:187 tells it the values it sees are already
 *     per-opening, so its returned values are final.
 *   - 'auto_corrected' — PunchyReview.tsx auto-applied a Punchy correction.
 *     Same rationale as 'llm_override'.
 *   - 'deep_extract' / 'region_extract' — pulled from a targeted region of
 *     the PDF with Claude's vision model. Returned values are per-opening.
 *   - 'propagated' — apply-to-all copy of an already-normalized qty.
 *   - 'reverted' — user manually reverted an auto-correction. The user chose
 *     this exact value; do not silently change it.
 *   - 'manual_placeholder' — triage-time placeholder the user will edit.
 */
export const NEVER_RENORMALIZE: ReadonlySet<string> = new Set([
  'divided',
  'flagged',
  'capped',
  'llm_override',
  'auto_corrected',
  'deep_extract',
  'region_extract',
  'propagated',
  'reverted',
  'manual_placeholder',
])

/**
 * Leaf attribution values persisted on `hardware_items.leaf_side`.
 *
 * - 'active'   — active leaf only (lockset, exit device on most pairs)
 * - 'inactive' — inactive leaf only (flush bolts)
 * - 'shared'   — one per opening, not per leaf (coordinator, threshold,
 *   astragal, gaskets, thresholds)
 * - 'both'     — present on each leaf with its own row (hinges, closers
 *   when the user has split them per-leaf via the triage UI)
 *
 * `null` means "unset — fall back to render-time classification in
 * `classify-leaf-items.ts::groupItemsByLeaf`." See migration 013.
 */
export type LeafSide = 'active' | 'inactive' | 'shared' | 'both'

/**
 * Compute the unambiguous `leaf_side` for a hardware item at save time.
 *
 * Returns a definite value for structural rows (Door / Frame) and for
 * items whose taxonomy scope is per_pair or per_frame (those items only
 * ever exist once per opening regardless of leaf count). For per_leaf
 * and per_opening items on pair doors, the choice between 'active',
 * 'inactive', and 'both' depends on installation details we can't infer
 * from the name alone, so we return `null` and let render-time logic
 * handle it — users will eventually override via the triage UI.
 *
 * Note: caller should pass `leafCount` from the opening row so we can
 * correctly handle single-leaf openings (where there's no inactive leaf
 * and a bare "Door" is implicitly active).
 */
export function computeLeafSide(
  itemName: string,
  leafCount: number,
): LeafSide | null {
  // Structural items — fixed by name.
  if (itemName === 'Door (Active Leaf)') return 'active'
  if (itemName === 'Door (Inactive Leaf)') return 'inactive'
  if (itemName === 'Frame') return 'shared'
  // A bare 'Door' row exists only on single-leaf openings; the render
  // code routes it to leaf 1 which is the implicit active leaf.
  if (itemName === 'Door') return leafCount <= 1 ? 'active' : null

  // Hardware items — scope drives unambiguous attribution.
  const scope = classifyItemScope(itemName)
  if (scope === 'per_pair' || scope === 'per_frame') return 'shared'

  // per_leaf / per_opening / unknown on pair doors: ambiguous, defer.
  return null
}

// --- Shared types ---

export interface PdfplumberResult {
  success: boolean
  openings: DoorEntry[]
  hardware_sets: Array<{
    set_id: string
    generic_set_id?: string
    heading: string
    heading_door_count?: number
    heading_leaf_count?: number
    /** Specific door numbers listed under this sub-heading. Populated by
     *  api/extract-tables.py via extract_heading_door_numbers(). Used by
     *  the TS layer to route doors to specific sub-sets (DH4A.0 vs
     *  DH4A.1) instead of collapsing them by generic_set_id. */
    heading_doors?: string[]
    items: Array<{
      qty: number
      qty_total?: number
      qty_door_count?: number
      qty_source?: string
      name: string
      manufacturer: string
      model: string
      finish: string
    }>
  }>
  reference_codes?: Array<{
    code_type: string
    code: string
    full_name: string
  }>
  flagged_doors?: PdfplumberFlaggedDoor[]
  expected_door_count: number
  tables_found: number
  hw_sets_found: number
  method: string
  error: string
  confidence?: string
  extraction_notes?: string[]
}

// --- Pipeline helpers ---

export async function callPdfplumber(
  base64: string,
  userColumnMapping?: Record<string, number> | null,
): Promise<PdfplumberResult> {
  // PYTHON_API_URL allows pointing to a standalone Python server in local dev
  const baseUrl = process.env.PYTHON_API_URL || process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000')

  const payload: Record<string, unknown> = { pdf_base64: base64 }
  if (userColumnMapping) {
    payload.user_column_mapping = userColumnMapping
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 280_000)

  const internalToken = process.env.PYTHON_INTERNAL_SECRET ?? ''

  try {
    const response = await fetch(`${baseUrl}/api/extract-tables`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(internalToken ? { 'X-Internal-Token': internalToken } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    if (!response.ok) {
      const rawText = await response.text()
      console.error('[callPdfplumber] Non-OK response:', response.status, rawText.slice(0, 500))
      throw new Error(`Pdfplumber extraction failed: ${response.status} ${response.statusText}`)
    }

    return response.json()
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Python endpoint timed out after 280s')
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

export async function callPunchyColumnReview(
  client: Anthropic,
  base64: string,
  columnMapping: Record<string, number> | null | undefined,
  opts?: { projectId?: string; extractionRunId?: string },
): Promise<PunchyColumnReview> {
  const systemPrompt = getColumnMappingReviewPrompt()

  const mappingSummary = columnMapping
    ? JSON.stringify(columnMapping, null, 2)
    : 'No column mapping provided (auto-detection will be used)'

  const startMs = Date.now()
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 },
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: `Here is the user's column mapping for the opening list table:\n\n${mappingSummary}\n\nReview the PDF and check if any expected fields are unmapped or incorrectly mapped. Return corrections as JSON.`,
            },
          ],
        },
      ],
    })
    const latencyMs = Date.now() - startMs

    const textBlock = response.content.find((b: { type: string }) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      logPunchyCall({
        projectId: opts?.projectId, extractionRunId: opts?.extractionRunId,
        checkpoint: 1, inputSnapshot: { columnMapping }, response: null,
        parseOk: false, inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens, latencyMs,
      })
      return { unmapped_fields: [], mapping_issues: [], notes: 'Punchy returned no text' }
    }

    const text = textBlock.text.trim()
    const parsed = extractJSON(text)

    logPunchyCall({
      projectId: opts?.projectId, extractionRunId: opts?.extractionRunId,
      checkpoint: 1, inputSnapshot: { columnMapping },
      response: parsed ?? { raw_text: text.substring(0, 2000) },
      parseOk: !!parsed, inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens, latencyMs,
    })

    if (!parsed) {
      console.warn('Punchy column review returned unparseable response:', text.substring(0, 300))
      return { unmapped_fields: [], mapping_issues: [], notes: 'Punchy returned unparseable response' }
    }

    return parsed as PunchyColumnReview
  } catch (err) {
    logPunchyCall({
      projectId: opts?.projectId, extractionRunId: opts?.extractionRunId,
      checkpoint: 1, inputSnapshot: { columnMapping }, response: { error: err instanceof Error ? err.message : String(err) },
      parseOk: false, latencyMs: Date.now() - startMs,
    })
    console.error('Punchy column review failed:', err instanceof Error ? err.message : String(err))
    return { unmapped_fields: [], mapping_issues: [], notes: `Punchy column review failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export async function callPunchyPostExtraction(
  client: Anthropic,
  base64: string,
  pdfplumberResult: PdfplumberResult,
  knownSetIds?: string[],
  opts?: {
    projectId?: string
    extractionRunId?: string
    goldenSample?: {
      set_id: string
      items: Array<{ qty: number; name: string; manufacturer?: string; model?: string; finish?: string }>
    }
  },
): Promise<PunchyCorrections> {
  const systemPrompt = getPostExtractionReviewPrompt(opts?.goldenSample)

  const allOpenings = pdfplumberResult?.openings ?? []
  const extractedSummary = JSON.stringify({
    hardware_sets: (pdfplumberResult?.hardware_sets ?? []).map(s => ({
      set_id: s.set_id,
      heading: s.heading,
      item_count: s.items?.length ?? 0,
      items: s.items ?? [],
    })),
    // Compact full door list: every door_number + hw_set (~2KB for 200 doors)
    // so Punchy can detect missing doors and wrong assignments across the full project.
    all_doors: allOpenings.map(d => ({
      door_number: d.door_number,
      hw_set: d.hw_set,
      fire_rating: d.fire_rating ?? '',
    })),
    // Rich sample for detailed field review (first 10 with all fields)
    doors_sample: allOpenings.slice(0, 10),
    total_doors: allOpenings.length,
    known_set_ids: knownSetIds ?? [],
  }, null, 2)

  // Snapshot for logging (exclude full items to keep log rows reasonable)
  const inputSnapshot = {
    hw_sets_count: pdfplumberResult?.hardware_sets?.length ?? 0,
    doors_count: pdfplumberResult?.openings?.length ?? 0,
    known_set_ids: knownSetIds ?? [],
  }

  const startMs = Date.now()
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 },
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: `Here is the automated extraction result. Review it against the PDF and return corrections as JSON:\n\n${extractedSummary}`,
            },
          ],
        },
      ],
    })
    const latencyMs = Date.now() - startMs

    const textBlock = response.content.find((b: { type: string }) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      logPunchyCall({
        projectId: opts?.projectId, extractionRunId: opts?.extractionRunId,
        checkpoint: 2, inputSnapshot, response: null,
        parseOk: false, inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens, latencyMs,
      })
      return { notes: 'Punchy returned no text' }
    }

    const text = textBlock.text.trim()
    const parsed = extractJSON(text)

    logPunchyCall({
      projectId: opts?.projectId, extractionRunId: opts?.extractionRunId,
      checkpoint: 2, inputSnapshot,
      response: parsed ?? { raw_text: text.substring(0, 2000) },
      parseOk: !!parsed, inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens, latencyMs,
    })

    if (!parsed) {
      console.warn('Punchy post-extraction review returned unparseable response:', text.substring(0, 300))
      return { notes: 'Punchy returned unparseable response' }
    }

    return parsed as PunchyCorrections
  } catch (err) {
    logPunchyCall({
      projectId: opts?.projectId, extractionRunId: opts?.extractionRunId,
      checkpoint: 2, inputSnapshot, response: { error: err instanceof Error ? err.message : String(err) },
      parseOk: false, latencyMs: Date.now() - startMs,
    })
    console.error('Punchy post-extraction review failed:', err instanceof Error ? err.message : String(err))
    return { notes: `Punchy review failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export async function callPunchyQuantityCheck(
  client: Anthropic,
  base64: string,
  hardwareSets: HardwareSet[],
  doors: DoorEntry[],
  goldenSample?: {
    set_id: string
    items: Array<{ qty: number; name: string; manufacturer?: string; model?: string; finish?: string }>
  } | null,
  opts?: { projectId?: string; extractionRunId?: string },
): Promise<PunchyQuantityCheck> {
  const systemPrompt = getQuantityCheckPrompt(goldenSample ?? undefined)

  const dataSummary = JSON.stringify({
    hardware_sets: hardwareSets.map(s => ({
      set_id: s.set_id,
      heading: s.heading,
      heading_door_count: s.heading_door_count,
      heading_leaf_count: s.heading_leaf_count,
      items: (s.items ?? []).map(i => ({
        name: i.name,
        qty: i.qty,
        qty_total: i.qty_total,
        qty_source: i.qty_source,
        manufacturer: i.manufacturer,
        model: i.model,
        finish: i.finish,
      })),
    })),
    doors: doors.slice(0, 20).map(d => ({
      door_number: d.door_number,
      hw_set: d.hw_set,
      fire_rating: d.fire_rating,
      door_type: d.door_type,
      hand: d.hand,
      leaf_count: d.leaf_count ?? 1,
    })),
    // Compact full door list for pair-door compliance checks across all openings
    all_doors_compact: doors.map(d => ({
      door_number: d.door_number,
      hw_set: d.hw_set,
      fire_rating: d.fire_rating ?? '',
      leaf_count: d.leaf_count ?? 1,
    })),
    total_doors: doors.length,
  }, null, 2)

  // Snapshot for logging (summary, not full data)
  const inputSnapshot = {
    hw_sets_count: hardwareSets.length,
    total_doors: doors.length,
    has_golden_sample: !!goldenSample,
  }

  const startMs = Date.now()
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 },
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: `Review the normalized hardware quantities and door assignments. Return auto_corrections for high-confidence fixes, questions for ambiguous cases, and flags/compliance_issues for other observations:\n\n${dataSummary}`,
            },
          ],
        },
      ],
    })
    const latencyMs = Date.now() - startMs

    const textBlock = response.content.find((b: { type: string }) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      logPunchyCall({
        projectId: opts?.projectId, extractionRunId: opts?.extractionRunId,
        checkpoint: 3, inputSnapshot, response: null,
        parseOk: false, inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens, latencyMs,
      })
      return { flags: [], compliance_issues: [], notes: 'Punchy returned no text' }
    }

    const text = textBlock.text.trim()
    const parsed = extractJSON(text)

    logPunchyCall({
      projectId: opts?.projectId, extractionRunId: opts?.extractionRunId,
      checkpoint: 3, inputSnapshot,
      response: parsed ?? { raw_text: text.substring(0, 2000) },
      parseOk: !!parsed, inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens, latencyMs,
    })

    if (!parsed) {
      console.warn('Punchy quantity check returned unparseable response:', text.substring(0, 300))
      return { flags: [], compliance_issues: [], notes: 'Punchy returned unparseable response' }
    }

    // Ensure backward compat: default missing arrays
    const typed = parsed as PunchyQuantityCheck
    return {
      auto_corrections: typed.auto_corrections ?? [],
      questions: typed.questions ?? [],
      flags: typed.flags ?? [],
      compliance_issues: typed.compliance_issues ?? [],
      notes: typed.notes,
    }
  } catch (err) {
    logPunchyCall({
      projectId: opts?.projectId, extractionRunId: opts?.extractionRunId,
      checkpoint: 3, inputSnapshot, response: { error: err instanceof Error ? err.message : String(err) },
      parseOk: false, latencyMs: Date.now() - startMs,
    })
    console.error('Punchy quantity check failed:', err instanceof Error ? err.message : String(err))
    return { flags: [], compliance_issues: [], notes: `Punchy quantity check failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// --- Deep Extraction: LLM-based item extraction for empty sets ---

export interface DeepExtractResult {
  set_id: string
  items: ExtractedHardwareItem[]
}

/**
 * Outcome of a deep-extraction call.
 *
 * - `ok: true` — the LLM responded successfully. `results` may still be an
 *   empty array if the model legitimately found no items.
 * - `ok: false` — the call failed (network, LLM error, parse error, empty
 *   response, etc.). `error` carries the reason so callers can surface it
 *   to the user instead of silently rendering "0 items".
 */
export type DeepExtractOutcome =
  | { ok: true; results: DeepExtractResult[] }
  | { ok: false; error: string }

export async function callDeepExtraction(
  client: Anthropic,
  base64: string,
  emptySets: Array<{ set_id: string; heading: string }>,
  goldenSample?: { set_id: string; items: ExtractedHardwareItem[] } | null,
  userHint?: string,
): Promise<DeepExtractOutcome> {
  const systemPrompt = getDeepExtractionPrompt(userHint)

  const setsDescription = emptySets
    .map(s => `- Set "${s.set_id}" (${s.heading || 'no heading'})`)
    .join('\n')

  // Build the user message — include golden sample as few-shot if available
  let userText = ''
  if (goldenSample && (goldenSample.items?.length ?? 0) > 0) {
    const sampleItems = goldenSample.items.map(i => ({
      qty: i.qty, name: i.name, manufacturer: i.manufacturer, model: i.model, finish: i.finish,
    }))
    userText += `Here is a VERIFIED example from this same submittal. Set "${goldenSample.set_id}" was confirmed by the user:\n\n`
    userText += JSON.stringify(sampleItems, null, 2)
    userText += '\n\nUse the same format, level of detail, and naming conventions for the remaining sets.\n\n'
  }
  userText += `The following hardware sets were identified in this PDF but our automated reader could not extract their items. Please read the items directly from the PDF for each set:\n\n${setsDescription}\n\nReturn a JSON array of objects with set_id and items.`

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 },
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: userText,
            },
          ],
        },
      ],
    })

    const textBlock = response.content.find((b: { type: string }) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      console.error('Deep extraction returned no text content from LLM')
      return { ok: false, error: 'LLM response had no text content' }
    }

    const text = textBlock.text.trim()
    const parsed = extractJSON(text)
    if (!parsed) {
      console.error('Deep extraction JSON parse failed. Raw text:', text.slice(0, 500))
      return { ok: false, error: 'Could not parse LLM response as JSON' }
    }

    // Handle both array and { sets: [...] } response shapes
    const results: DeepExtractResult[] = Array.isArray(parsed)
      ? parsed
      : (parsed as { sets?: DeepExtractResult[] })?.sets ?? []

    // Normalize items: ensure qty is a number, default to 1
    for (const result of results) {
      for (const item of result.items ?? []) {
        if (typeof item.qty !== 'number' || item.qty < 1) item.qty = 1
        item.name = item.name ?? ''
        item.manufacturer = item.manufacturer ?? ''
        item.model = item.model ?? ''
        item.finish = item.finish ?? ''
        item.qty_source = 'deep_extract'
      }
    }

    // Log cache usage
    const usage = response.usage as unknown as Record<string, unknown>
    if (usage?.cache_creation_input_tokens || usage?.cache_read_input_tokens) {
      console.debug(
        `Deep extract cache: created=${usage.cache_creation_input_tokens ?? 0}, ` +
        `read=${usage.cache_read_input_tokens ?? 0}`
      )
    }

    console.debug(
      `Deep extraction: ${results.length} sets returned, ` +
      `${results.reduce((sum, r) => sum + (r.items?.length ?? 0), 0)} total items`
    )

    return { ok: true, results }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Deep extraction failed:', message)
    return { ok: false, error: message }
  }
}

/**
 * Name matcher used when applying Punchy corrections to extracted items.
 *
 * Matching tiers (first hit wins):
 *   1. Exact string match
 *   2. Case-insensitive match
 *
 * Substring matching used to be a third tier, but it silently cross-matched
 * variants like "Hinge" → "Spring Hinge" / "Heavy-Duty Hinge", flipping the
 * wrong item. Case-insensitive parity with pdfplumber's extracted name is the
 * right contract: Punchy's CP2 prompt echoes the extraction back, so it has
 * no reason to diverge beyond casing. When Punchy returns a novel name we now
 * warn loudly instead of guessing.
 */
export function findItemFuzzy(
  items: ExtractedHardwareItem[],
  name: string,
  context: string,
): ExtractedHardwareItem | undefined {
  // 1. Exact match
  const exact = items.find(i => i.name === name)
  if (exact) return exact

  // 2. Case-insensitive match
  const lower = name.toLowerCase()
  const ci = items.find(i => i.name.toLowerCase() === lower)
  if (ci) {
    console.debug(`Punchy correction fuzzy match (case): "${name}" → "${ci.name}" [${context}]`)
    return ci
  }

  console.warn(`Punchy correction could not match item "${name}" [${context}]`)
  return undefined
}

/**
 * Resolve a Punchy-supplied set_id to the concrete `HardwareSet` objects it
 * should apply to.
 *
 *   - Prefer an exact `set_id` hit (one target).
 *   - Otherwise treat the id as a `generic_set_id` and apply to every
 *     sub-variant (e.g., Punchy says "DH4A" when the extraction has
 *     "DH4A.0" and "DH4A.1").
 *   - Empty result → correction is dropped and we log a warning so the
 *     miss is observable.
 */
function resolveSetsForCorrection(
  hardwareSets: HardwareSet[],
  correctionSetId: string,
  context: string,
): HardwareSet[] {
  const exact = hardwareSets.find(s => s.set_id === correctionSetId)
  if (exact) return [exact]

  const byGeneric = hardwareSets.filter(s => s.generic_set_id === correctionSetId)
  if (byGeneric.length > 0) {
    console.debug(
      `Punchy correction resolved via generic_set_id: "${correctionSetId}" → ${byGeneric
        .map(s => s.set_id)
        .join(', ')} [${context}]`,
    )
    return byGeneric
  }

  console.warn(`Punchy correction could not match set_id "${correctionSetId}" [${context}]`)
  return []
}

export function applyCorrections(
  hardwareSets: HardwareSet[],
  doors: DoorEntry[],
  corrections: PunchyCorrections
): { hardwareSets: HardwareSet[]; doors: DoorEntry[] } {
  // Apply hardware set corrections
  if (corrections.hardware_sets_corrections) {
    for (const corr of corrections.hardware_sets_corrections) {
      const targets = resolveSetsForCorrection(hardwareSets, corr.set_id, 'hw_sets_corrections')
      if (targets.length === 0) continue

      for (const set of targets) {
        if (corr.heading) set.heading = corr.heading

        // Remove items (exact + case-insensitive only, never substring)
        if (corr.items_to_remove) {
          const removeLower = new Set(corr.items_to_remove.map(n => n.toLowerCase()))
          set.items = (set.items ?? []).filter(
            item => !removeLower.has(item.name.toLowerCase()),
          )
        }

        // Fix items (exact + case-insensitive)
        if (corr.items_to_fix) {
          for (const fix of corr.items_to_fix) {
            const item = findItemFuzzy(
              set.items ?? [],
              fix.name,
              `set ${set.set_id} fix ${fix.field}`,
            )
            if (item && fix.field in item) {
              const val = fix.new_value
              if (fix.field === 'qty') {
                (item as any)[fix.field] = parseInt(val, 10) || 1
                // Mark as llm_override so downstream normalization (NEVER_RENORMALIZE)
                // preserves Punchy's correction — Punchy sees per-opening values and
                // returns per-opening values; re-dividing would clobber the fix.
                ;(item as any).qty_source = 'llm_override'
              } else {
                (item as any)[fix.field] = val
              }
            }
          }
        }

        // Add missing items (exact + case-insensitive duplicate check)
        if (corr.items_to_add) {
          for (const newItem of corr.items_to_add) {
            const existing = findItemFuzzy(
              set.items ?? [],
              newItem.name,
              `set ${set.set_id} add`,
            )
            if (!existing) {
              if (!set.items) set.items = []
              set.items.push(newItem)
            }
          }
        }
      }
    }
  }

  // Add missing sets — also check generic_set_id to avoid duplicating a set
  // when Punchy suggests the generic ID (e.g., "DH4A") while we already have
  // its sub-headings (DH4A.0, DH4A.1) extracted.
  if (corrections.missing_sets) {
    for (const newSet of corrections.missing_sets) {
      const alreadyPresent = hardwareSets.some(
        s => s.set_id === newSet.set_id
          || s.generic_set_id === newSet.set_id
          || (newSet.generic_set_id !== undefined
            && (s.set_id === newSet.generic_set_id
              || s.generic_set_id === newSet.generic_set_id)),
      )
      if (!alreadyPresent) {
        // Forward heading metadata so downstream normalization can divide
        // quantities correctly. Previously all three fields were dropped,
        // which put normalizeQuantities in the "leafCount<=1 && doorCount<=1"
        // skip path — silently bypassing the per-leaf division safety net.
        hardwareSets.push({
          set_id: newSet.set_id,
          generic_set_id: newSet.generic_set_id,
          heading: newSet.heading,
          heading_door_count: newSet.heading_door_count ?? 0,
          heading_leaf_count: newSet.heading_leaf_count ?? 0,
          heading_doors: [],
          items: newSet.items ?? [],
        })
      }
    }
  }

  // Apply door corrections.
  //
  // Match by normalized door_number (uppercase + whitespace-collapsed) so
  // Punchy's raw-PDF door numbers (e.g. "110 02A") match our canonical
  // storage form ("11002A"). Exact-string matching used to silently drop
  // every correction where formatting drifted between pdfplumber's extraction
  // and the PDF text Punchy reads.
  if (corrections.doors_corrections) {
    for (const corr of corrections.doors_corrections) {
      const target = normalizeDoorNumber(corr.door_number)
      const door = doors.find(d => normalizeDoorNumber(d.door_number) === target)
      if (!door) {
        console.warn(
          `Punchy doors_corrections could not match door_number "${corr.door_number}"`,
        )
        continue
      }
      if (corr.field in door) {
        (door as any)[corr.field] = corr.new_value
      }
    }
  }

  // Add missing doors (also normalized — same rationale as above).
  if (corrections.missing_doors) {
    for (const newDoor of corrections.missing_doors) {
      const target = normalizeDoorNumber(newDoor.door_number)
      if (!doors.some(d => normalizeDoorNumber(d.door_number) === target)) {
        doors.push(newDoor)
      }
    }
  }

  return { hardwareSets, doors }
}

/**
 * Post-Punchy quantity re-normalization (category-aware).
 *
 * Punchy may revert normalized quantities back to PDF totals.
 * This re-divides them using the Opening List door counts as ground truth,
 * with division strategy based on hardware taxonomy install_scope:
 *
 *   per_leaf    → divide by leafCount first (hinges, pivots)
 *   per_opening → divide by doorCount only (closers, locksets)
 *   per_pair    → never divide (coordinators, astragals)
 *   per_frame   → never divide (thresholds, seals)
 *   unknown     → legacy behavior: try leaf then door (backward compat)
 *
 * Mirrors Python's normalize_quantities() DIVISION_PREFERENCE logic
 * at extract-tables.py:127-147.
 */
export function normalizeQuantities(
  hardwareSets: HardwareSet[],
  doors: DoorEntry[],
): void {
  const doorsPerSet = new Map<string, number>()
  for (const door of doors) {
    if (door.hw_set) {
      doorsPerSet.set(door.hw_set.toUpperCase(), (doorsPerSet.get(door.hw_set.toUpperCase()) ?? 0) + 1)
    }
  }

  // Pre-compute generic set totals for sub-heading normalization.
  // When multiple sub-headings (e.g., DH3.0, DH3.1) share a generic_set_id,
  // item quantities may be set-level totals that should be divided by the
  // TOTAL door count, not just the sub-heading's count.
  const genericTotals = new Map<string, { doors: number; leaves: number }>()
  for (const set of hardwareSets) {
    const gid = (set.generic_set_id ?? set.set_id).toUpperCase()
    const prev = genericTotals.get(gid) ?? { doors: 0, leaves: 0 }
    genericTotals.set(gid, {
      doors: prev.doors + (set.heading_door_count ?? 0),
      leaves: prev.leaves + (set.heading_leaf_count ?? 0),
    })
  }
  // Fill in from opening list when heading counts are 0
  for (const [gid, totals] of genericTotals) {
    if (totals.doors === 0) {
      const olCount = doorsPerSet.get(gid) ?? 0
      if (olCount > 0) {
        genericTotals.set(gid, { doors: olCount, leaves: olCount })
      }
    }
  }

  // Max expected per-opening quantities (mirrors Python EXPECTED_QTY_RANGES)
  const MAX_QTY: Record<string, number> = {
    per_leaf: 5, per_opening: 2, per_pair: 1, per_frame: 1,
  }

  for (const set of hardwareSets) {
    const leafCount = (set.heading_leaf_count ?? 0) > 1 ? (set.heading_leaf_count ?? 0) : 0
    const doorCount = (set.heading_door_count ?? 0) > 1
      ? (set.heading_door_count ?? 0)
      : (doorsPerSet.get((set.generic_set_id ?? set.set_id).toUpperCase()) ?? 0)

    // Check if this is a sub-heading within a larger generic group
    const gid = (set.generic_set_id ?? set.set_id).toUpperCase()
    const genericTotal = genericTotals.get(gid) ?? { doors: 0, leaves: 0 }
    const isSubHeading = (
      set.generic_set_id
      && set.generic_set_id !== set.set_id
      && genericTotal.doors > doorCount
    )

    console.debug(
      `[qty-norm] set=${set.set_id} generic=${set.generic_set_id ?? '?'} ` +
      `headingDoorCount=${set.heading_door_count ?? 0} headingLeafCount=${set.heading_leaf_count ?? 0} ` +
      `resolvedLeafCount=${leafCount} resolvedDoorCount=${doorCount}` +
      (isSubHeading ? ` (sub-heading: generic=${genericTotal.doors}d/${genericTotal.leaves}l)` : '')
    )
    if (leafCount <= 1 && doorCount <= 1) continue

    for (const item of set.items ?? []) {
      if (NEVER_RENORMALIZE.has(item.qty_source ?? '')) {
        continue
      }

      const scope = classifyItemScope(item.name)
      const maxPerOpening = MAX_QTY[scope ?? 'per_opening'] ?? 2

      // Safety: if qty is already within per-opening range, it's almost certainly
      // already normalized. Dividing a 3-hinge qty by a 3-door count would
      // incorrectly yield 1. Skip division when qty <= maxPerOpening.
      if (item.qty <= maxPerOpening) {
        continue
      }

      // per_pair / per_frame → never divide (one per opening/frame regardless of leaf count)
      if (scope === 'per_pair' || scope === 'per_frame') {
        continue
      }

      // per_opening → divide by doorCount only (skip leafCount)
      if (scope === 'per_opening') {
        if (doorCount > 1 && item.qty >= doorCount) {
          const perOpening = item.qty / doorCount
          if (Number.isInteger(perOpening)) {
            item.qty_total = item.qty
            item.qty_door_count = doorCount
            item.qty = perOpening
            item.qty_source = 'divided'
          }
        }
        continue
      }

      // per_leaf items must divide by leafCount when leafCount is known.
      //
      // Historical bug: the old code required Number.isInteger(qty/leafCount)
      // and otherwise fell back to dividing by doorCount. For pair-door sets
      // with mixed hinge rows (e.g., 42 standard + 6 electric across 12
      // leaves), 42/12=3.5 is NOT an integer, so the code fell back to
      // 42/6=7 per opening. That number happens to be an integer and looks
      // plausible but is silently wrong — the correct answer is ~4 per leaf.
      //
      // Fix: if leafCount > 1, ALWAYS divide by leafCount for per_leaf items.
      // Use Math.round for non-integer results and flag the item so Punchy's
      // quantity check and the UI can surface it for verification. Only fall
      // back to doorCount when leafCount is missing (single-door sets where
      // Python couldn't compute a leaf count).
      if (scope === 'per_leaf') {
        if (leafCount > 1 && item.qty >= leafCount) {
          const perLeaf = item.qty / leafCount
          item.qty_total = item.qty
          item.qty_door_count = leafCount
          if (Number.isInteger(perLeaf)) {
            item.qty = perLeaf
            item.qty_source = 'divided'
          } else {
            // Non-integer per-leaf. Could be mixed configurations (some
            // leaves get 4 hinges, some 3) or a different count elsewhere
            // in the set. Round to nearest and flag for review.
            item.qty = Math.round(perLeaf)
            item.qty_source = 'flagged'
          }
        } else if (doorCount > 1 && item.qty >= doorCount) {
          // Leaf count unknown — fall back to doorCount.
          const perOpening = item.qty / doorCount
          if (Number.isInteger(perOpening)) {
            item.qty_total = item.qty
            item.qty_door_count = doorCount
            item.qty = perOpening
            item.qty_source = 'divided'
          }
        }
        continue
      }

      // Unknown scope → legacy behavior: try leafCount first, then doorCount.
      // This is the conservative fallback for items we can't classify.
      let divided = false
      if (leafCount > 1 && item.qty >= leafCount) {
        const perLeaf = item.qty / leafCount
        if (Number.isInteger(perLeaf)) {
          item.qty_total = item.qty
          item.qty_door_count = leafCount
          item.qty = perLeaf
          item.qty_source = 'divided'
          divided = true
        }
      }
      if (!divided && doorCount > 1 && doorCount !== leafCount && item.qty >= doorCount) {
        const perOpening = item.qty / doorCount
        if (Number.isInteger(perOpening)) {
          item.qty_total = item.qty
          item.qty_door_count = doorCount
          item.qty = perOpening
          item.qty_source = 'divided'
        }
      }
    }

    // Post-division sanity check: if divided qty exceeds category max,
    // try the generic set total for sub-headings.
    if (isSubHeading) {
      for (const item of set.items ?? []) {
        if (item.qty_source !== 'divided' && item.qty_source !== 'flagged') continue
        const scope = classifyItemScope(item.name)
        const maxQty = MAX_QTY[scope ?? 'per_opening'] ?? 4
        if (item.qty > maxQty) {
          const raw = item.qty_total ?? item.qty
          const altDivisor = scope === 'per_leaf' && genericTotal.leaves > 1
            ? genericTotal.leaves
            : genericTotal.doors
          if (altDivisor > 1) {
            const altPerUnit = raw / altDivisor
            if (Number.isInteger(altPerUnit) && altPerUnit <= maxQty) {
              console.debug(
                `[qty-norm] ${set.set_id}: "${item.name}" re-divided by generic total: ` +
                `${raw} ÷ ${altDivisor} = ${altPerUnit} (sub-heading gave ${item.qty}, max=${maxQty})`
              )
              item.qty = altPerUnit
              item.qty_door_count = altDivisor
              item.qty_source = 'divided'
            } else if (altDivisor > 0) {
              const rounded = Math.round(raw / altDivisor)
              if (rounded <= maxQty) {
                console.debug(
                  `[qty-norm] ${set.set_id}: "${item.name}" re-divided (rounded) by generic total: ` +
                  `${raw} ÷ ${altDivisor} ≈ ${rounded} (sub-heading gave ${item.qty}, max=${maxQty})`
                )
                item.qty = rounded
                item.qty_door_count = altDivisor
                item.qty_source = 'flagged'
              }
            }
          }
        }
      }
    }
  }
}

// --- Save-path validation helpers ---

/**
 * Build the set of all hardware-set IDs that a door's `hw_set` field may
 * legitimately match against. Includes BOTH the specific `set_id` (e.g.,
 * "DH4A.0") AND the `generic_set_id` (e.g., "DH4A") for every set, so
 * that doors whose opening-list entry references the generic parent id
 * still match when the set is stored under a specific sub-heading id.
 *
 * Used by the save-path validation in StepConfirm and in the
 * `/api/parse-pdf/save` route. Previously the client-side validation
 * only used `set.set_id`, which blocked the Save button for any project
 * whose opening list references the parent id of a multi-heading set
 * (the exact Radius DC DH4A case from 2026-04-11).
 */
export function buildDefinedSetIds(hardwareSets: HardwareSet[]): Set<string> {
  const ids = new Set<string>()
  for (const set of hardwareSets) {
    if (set.set_id) ids.add(set.set_id)
    if (set.generic_set_id && set.generic_set_id !== set.set_id) {
      ids.add(set.generic_set_id)
    }
  }
  return ids
}

/**
 * Return the subset of doors whose `hw_set` references a hardware set
 * that doesn't exist in `definedSetIds`. This is the save-blocking
 * validation used by StepConfirm and the save route.
 *
 * Doors with `by_others === true` are EXCLUDED from this check — they
 * are intentionally unassigned (hardware is provided by a different
 * contractor) and their `hw_set` is typically "N/A" or similar sentinel
 * text that will never match a real set. Including them in the
 * unmatched list was the second half of the "Cannot save: 6 Door(s)
 * reference hardware sets that don't exist" bug from 2026-04-11.
 */
export function findDoorsWithUnmatchedSets(
  doors: DoorEntry[],
  definedSetIds: Set<string>,
): DoorEntry[] {
  return doors.filter(
    d => !d.by_others && d.hw_set && !definedSetIds.has(d.hw_set),
  )
}

// --- Door number normalization + doorToSetMap ---

/**
 * Normalize a door number for matching across Opening List and Hardware
 * Schedule extraction. Both sources should produce the same format, but
 * whitespace and case differences are possible.
 *
 * Examples:
 *   "110-02A"   → "110-02A"
 *   " 110-02a " → "110-02A"
 *   "110 02A"   → "11002A"  (spaces collapsed)
 */
export function normalizeDoorNumber(s: string): string {
  return (s ?? '').trim().toUpperCase().replace(/\s+/g, '')
}

// --- Opening size + pair detection ---
//
// Opening size conventions in DFH (Door & Frame Hardware) industry:
//
//   "3070"          → 3'0" × 7'0" (compressed: first 2 digits = feet+inches
//                     for WIDTH, next 2 = feet+inches for HEIGHT)
//   "3068"          → 3'0" × 6'8"
//   "6080"          → 6'0" × 8'0"  (pair — width > 48")
//   "3'0\" x 7'0\"" → explicit feet/inches with spaces and quotes
//   "3'-0\" × 7'-0\""→ dash-separator variant (common in architectural drawings)
//   "36 x 84"       → pure inches (36" wide × 84" tall)
//   "36\" × 84\""   → pure inches with quotes
//   "914 x 2134"    → metric millimeters (international / ISO)
//   "3-0 x 7-0"     → dash-and-zero variant
//
// Pair vs single detection by width (rule of thumb):
//   Width ≥ 5'0" (60" / 152 cm / 1524 mm) → pair (HIGH confidence)
//   Width ≥ 4'0" (48")                    → possibly pair (could be wide
//                                            single; need corroborating
//                                            signal like heading_leaf_count)
//   Width 2'6"–4'0"                       → single (HIGH confidence)
//   Width < 2'6"                          → unusual (sidelite, access panel)
//
// Common pair widths: 5'0", 5'4", 5'8", 6'0" (most common), 6'8", 7'0", 8'0".
// Each leaf in a pair is typically 3'0", 3'4", or 4'0" wide.

const _PAIR_MIN_WIDTH_IN = 48 // 4'0" — below this, it's a single for sure

/**
 * Parse an opening size label into width/height in inches. Returns null if
 * the label doesn't match any recognized format. Used as a secondary pair
 * detection signal when heading_leaf_count is missing.
 *
 * Handles the common DFH format variants listed in the comment block above.
 * Metric millimeters are converted to inches (1 in = 25.4 mm).
 */
export function parseOpeningSize(
  text: string | null | undefined,
): { widthIn: number; heightIn: number } | null {
  if (!text) return null
  const t = text.trim()
  if (t.length === 0) return null

  // Helper: feet + inches → total inches
  const ftIn = (ft: number, inches: number) => ft * 12 + inches

  // --- Format 1: "3'0\" x 7'0\"" or "3'-0\" x 7'-0\"" or "3' 0\" × 7' 0\""
  //   Matches feet/inches with optional dash/space, optional inch marks,
  //   and any of x, ×, X, * as separator.
  //   Groups: (fW)(iW) (fH)(iH)
  const explicitFtIn =
    /(\d+)\s*'\s*[-\s]?\s*(\d{1,2})?\s*"?\s*[x×X*]\s*(\d+)\s*'\s*[-\s]?\s*(\d{1,2})?\s*"?/
  const m1 = t.match(explicitFtIn)
  if (m1) {
    const fW = parseInt(m1[1], 10)
    const iW = m1[2] ? parseInt(m1[2], 10) : 0
    const fH = parseInt(m1[3], 10)
    const iH = m1[4] ? parseInt(m1[4], 10) : 0
    if (!Number.isNaN(fW) && !Number.isNaN(fH)) {
      return { widthIn: ftIn(fW, iW), heightIn: ftIn(fH, iH) }
    }
  }

  // --- Format 2: "3070" or "3068" compressed 4-digit (feet+inches per dim)
  //   2 digits for width (feet tens × 10 + inches ones), 2 digits for height.
  //   Only accept if the implied dimensions are plausible (width 20"–96",
  //   height 60"–144") — else it's probably a door_number or other code.
  const compressed = /^(\d{4,5})$/
  const m2 = t.match(compressed)
  if (m2) {
    const digits = m2[1]
    // Split into width / height halves. For 4 digits: first 2 = width,
    // last 2 = height. For 5 digits: first 2 or 3 = width, last 2 = height.
    const widthStr = digits.length === 5 ? digits.slice(0, 3) : digits.slice(0, 2)
    const heightStr = digits.slice(-2)
    // "30" = 3'0" = 36"; "34" = 3'4" = 40"; "36" = 3'6" = 42"
    // "70" = 7'0" = 84"; "80" = 8'0" = 96"
    const parseFtInPair = (s: string): number | null => {
      if (s.length === 2) {
        const ft = parseInt(s[0], 10)
        const inches = parseInt(s[1], 10)
        if (Number.isNaN(ft) || Number.isNaN(inches)) return null
        return ftIn(ft, inches)
      }
      if (s.length === 3) {
        const ft = parseInt(s.slice(0, 2), 10)
        const inches = parseInt(s[2], 10)
        if (Number.isNaN(ft) || Number.isNaN(inches)) return null
        return ftIn(ft, inches)
      }
      return null
    }
    const widthIn = parseFtInPair(widthStr)
    const heightIn = parseFtInPair(heightStr)
    if (
      widthIn != null &&
      heightIn != null &&
      widthIn >= 20 &&
      widthIn <= 120 &&
      heightIn >= 60 &&
      heightIn <= 144
    ) {
      return { widthIn, heightIn }
    }
  }

  // --- Format 3: "36 x 84" or "36\" × 84\"" pure inches, OR metric mm
  //   Must be standalone (not trailing text), and within plausible ranges.
  //   Allow 2-4 digits so metric millimeters (e.g., 914 × 2134) parse.
  const inchesOnly = /^(\d{2,4})\s*"?\s*[x×X*]\s*(\d{2,4})\s*"?$/
  const m3 = t.match(inchesOnly)
  if (m3) {
    const w = parseInt(m3[1], 10)
    const h = parseInt(m3[2], 10)
    // Plausibility: width 20–144", height 60–144". If both are ≥ 300, treat
    // as metric mm (e.g., "914 x 2134").
    if (w >= 300 && h >= 300) {
      const widthIn = Math.round((w / 25.4) * 10) / 10
      const heightIn = Math.round((h / 25.4) * 10) / 10
      return { widthIn, heightIn }
    }
    if (w >= 20 && w <= 144 && h >= 60 && h <= 144) {
      return { widthIn: w, heightIn: h }
    }
  }

  return null
}

/**
 * Detect whether an opening is a pair door based on the hardware set and
 * door info. Uses a layered signal strategy so the detection is robust
 * across different PDF formats:
 *
 *   1. PRIMARY — `heading_leaf_count > heading_door_count`. If Python's
 *      extractor captured the "N Pair Doors" lines correctly, the leaf
 *      count exceeds the opening count and we have a definitive answer.
 *   2. SECONDARY — Parse the opening size from door_type or the heading
 *      text. If width ≥ 48" (4'0"), treat as pair. This catches PDFs
 *      where the heading parser missed the leaf count but the size is
 *      available in the door schedule.
 *   3. TERTIARY — Keyword scan of heading/door_type for "pair", "double",
 *      "pr" (the legacy behavior). This is the weakest signal but catches
 *      edge cases where neither structured signal is present.
 *
 * Previously only the tertiary signal was used, which failed silently for
 * the Radius DC PDF format (heading text "Heading #DH4A.1", door_type "A")
 * and left pair doors with the wrong per-leaf → per-opening math.
 */
export function detectIsPair(
  hwSet: HardwareSet | undefined,
  doorInfo: { door_type?: string | null; location?: string | null } | undefined,
): boolean {
  // --- Primary: leaf count exceeds door count in the extracted set ---
  const leafCount = hwSet?.heading_leaf_count ?? 0
  const doorCount = hwSet?.heading_door_count ?? 0
  if (doorCount >= 1 && leafCount > doorCount) {
    return true
  }

  // --- Secondary: parse opening size from door_type or heading text ---
  const sizeSources: Array<string | null | undefined> = [
    doorInfo?.door_type,
    doorInfo?.location,
    hwSet?.heading,
  ]
  for (const src of sizeSources) {
    const parsed = parseOpeningSize(src)
    if (parsed && parsed.widthIn >= _PAIR_MIN_WIDTH_IN) {
      return true
    }
  }

  // --- Tertiary: keyword scan (legacy fallback) ---
  const heading = (hwSet?.heading ?? '').toLowerCase()
  const doorType = (doorInfo?.door_type ?? '').toLowerCase()
  if (
    heading.includes('pair') ||
    heading.includes('double') ||
    doorType.includes('pr') ||
    doorType.includes('pair')
  ) {
    return true
  }

  return false
}

/**
 * Build a door-number → specific-sub-set lookup map.
 *
 * Handles the multi-heading case where one generic_set_id (e.g., "DH4A")
 * has multiple sub-headings (DH4A.0, DH4A.1) with different item lists.
 * Each door is assigned to the sub-set whose heading block lists it.
 *
 * First-wins semantics: if a door appears in multiple heading_doors lists
 * (shouldn't happen but possible with PDF parser bugs), the earliest one wins.
 */
export function buildDoorToSetMap(
  hardwareSets: HardwareSet[],
): Map<string, HardwareSet> {
  const map = new Map<string, HardwareSet>()
  for (const set of hardwareSets) {
    for (const doorNum of set.heading_doors ?? []) {
      const key = normalizeDoorNumber(doorNum)
      if (key && !map.has(key)) {
        map.set(key, set)
      }
    }
  }
  return map
}

// --- Hardware item builder (Phase 3) ---

/**
 * Build per-opening hardware item rows (Door/Frame + set items).
 * Used by save/route.ts and apply-revision/route.ts.
 *
 * Resolves the correct sub-set for each opening in this order:
 *  1. doorToSetMap lookup by specific door_number (handles multi-heading)
 *  2. Legacy setMap lookup by opening.hw_set (handles single-heading + fallback)
 */
export function buildPerOpeningItems(
  openings: Array<{ id: string; door_number: string; hw_set: string | null }>,
  doorInfoMap: Map<string, { door_type: string; frame_type: string }>,
  setMap: Map<string, HardwareSet>,
  doorToSetMap: Map<string, HardwareSet>,
  fkColumn: 'opening_id' | 'staging_opening_id' = 'opening_id',
  extraFields?: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []

  for (const opening of openings) {
    let sortOrder = 0
    const doorInfo = doorInfoMap.get(opening.door_number)
    const base = { [fkColumn]: opening.id, ...extraFields }

    // Resolve the specific sub-set: door-number lookup takes priority over
    // hw_set lookup, so multi-heading sub-sets (DH4A.0 vs DH4A.1) correctly
    // route their items to the right openings.
    const doorKey = normalizeDoorNumber(opening.door_number)
    const hwSet = doorToSetMap.get(doorKey) ?? setMap.get(opening.hw_set ?? '')

    // Pair detection uses detectIsPair which layers three signals:
    //   1. hwSet.heading_leaf_count > heading_door_count (primary)
    //   2. parseOpeningSize → width >= 48" (secondary)
    //   3. keyword scan of heading / door_type (tertiary)
    //
    // This replaces an earlier inline keyword-only check that silently
    // returned false for Radius DC format (heading "Heading #DH4A.1",
    // door_type "A" — no "pair" keyword in either). The result was that
    // pair openings got only 1 Door row and per-leaf item quantities
    // were stored without being doubled.
    const isPair = detectIsPair(hwSet, doorInfo)
    const leafCount = isPair ? 2 : 1

    // Add door(s) only when door_type is known. Stamp leaf_side on each
    // structural row so the DB carries the attribution (see migration 013).
    const doorModel = doorInfo?.door_type?.trim() || null
    if (doorModel) {
      if (isPair) {
        rows.push({ ...base, name: 'Door (Active Leaf)', qty: 1, manufacturer: null, model: doorModel, finish: null, sort_order: sortOrder++, leaf_side: 'active' })
        rows.push({ ...base, name: 'Door (Inactive Leaf)', qty: 1, manufacturer: null, model: doorModel, finish: null, sort_order: sortOrder++, leaf_side: 'inactive' })
      } else {
        rows.push({ ...base, name: 'Door', qty: 1, manufacturer: null, model: doorModel, finish: null, sort_order: sortOrder++, leaf_side: 'active' })
      }
    }

    // Frame — only when frame_type is known. One frame per opening
    // regardless of pair vs single (pair doors share one doubled frame).
    const frameModel = doorInfo?.frame_type?.trim() || null
    if (frameModel) {
      rows.push({ ...base, name: 'Frame', qty: 1, manufacturer: null, model: frameModel, finish: null, sort_order: sortOrder++, leaf_side: 'shared' })
    }

    // Hardware set items — store per-leaf quantities as-is.
    // Phase 2 reverted Phase 1's doubling: the UI now renders
    // Shared / Leaf 1 / Leaf 2 sections, so per-leaf items (hinges,
    // closers, etc.) are stored at their per-leaf value and the UI
    // displays them on each leaf section.
    //
    // Phase 3: attach a leaf_side hint via computeLeafSide() — unambiguous
    // for per_pair / per_frame items (→ 'shared') and left NULL for
    // per_leaf / per_opening items on pairs, where render-time logic still
    // decides (triage UI in a follow-up will let users set these).
    if ((hwSet?.items?.length ?? 0) > 0) {
      for (const item of hwSet?.items ?? []) {
        const leafSide = computeLeafSide(item.name, leafCount)
        rows.push({
          ...base,
          name: item.name,
          qty: item.qty || 1,
          manufacturer: item.manufacturer || null,
          model: item.model || null,
          finish: item.finish || null,
          sort_order: sortOrder++,
          leaf_side: leafSide,
        })
      }
    }
  }

  return rows
}
