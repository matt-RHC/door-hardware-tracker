import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { fetchProjectPdfBase64 } from '@/lib/pdf-storage'
import { createAnthropicClient } from '@/lib/parse-pdf-helpers'
import type Anthropic from '@anthropic-ai/sdk'

// Bump to 800s — large door lists (100+) with Sonnet can take several minutes
export const maxDuration = 800

// --- Types ---

interface TriageCandidate {
  door_number: string
  hw_set: string | null
  door_type: string | null
  frame_type: string | null
  fire_rating: string | null
  hand: string | null
  location: string | null
  page_number: number | null
}

interface TriageClassification {
  door_number: string
  class: 'door' | 'by_others' | 'reject'
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

interface TriageResponse {
  classifications: TriageClassification[]
  stats: {
    total: number
    doors: number
    by_others: number
    rejected: number
  }
  triage_error?: boolean
  triage_error_message?: string
  retryable?: boolean
}

// --- System prompt ---

const TRIAGE_SYSTEM_PROMPT = `You are a subject matter expert in commercial door hardware, architectural door/frame/hardware (DHI) specification packages, and construction submittal documents.

You understand:
- Door numbering conventions: floor-room (09-02A), compound (1.01.A.01A), stairwell codes (ST-1A), sequential (101, 102, 103), Comsense-style (DH1, DCB2)
- Product model numbers: Schlage L-series (L9175, L9460), Von Duprin (98/9948-EO, PT200EZ, 6211WF), LCN (4040XP, 4111), Hager (1860S, 5BB1, 780-112, 4500, 5600, 6300, 6311), Ives, Sargent, Corbin Russwin
- Finish codes: 626 (satin chrome), 630 (stainless), 652, 622 (dark bronze)
- BHMA product function codes and manufacturer model patterns
- How hardware submittal PDFs are structured:
  - Opening List = tabular grid of doors with set assignments (source of truth)
  - Hardware Schedule = one block per set with itemized hardware
  - Reference Tables = manufacturer/finish/option code lookups
  - Cut Sheets = manufacturer product data pages (specs, dimensions, diagrams)
- That cut sheet pages contain product model numbers, dimensions, weights, and catalog codes that look superficially like door numbers but are NOT
- That "B/O'S", "BY OTHERS", "N/A", "NH" mean hardware is by others

CRITICAL: Product codes can be 3-7 characters, alphanumeric, with or without dashes. They appear as standalone values in cut sheet tables that pdfplumber detects as "door schedule" tables. These are NOT door numbers.

YOUR TASK: Given a list of candidate door entries extracted from a PDF, classify each as:
- "door" — a real door opening in the project
- "by_others" — a real door but hardware is by others (GLASS, ALBO, NH, B/O, etc.)
- "reject" — a product code, model number, finish code, or extraction artifact

Return JSON only. No explanation outside the JSON.`

// --- Retry helpers ---

/** Check if an error is retryable (overloaded or rate-limited). */
function isRetryableError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    // Anthropic SDK errors have a status property
    const status = (err as Record<string, unknown>).status
    if (status === 429 || status === 529) return true
    // Check error type/message for overloaded_error
    const message = (err as Record<string, unknown>).message
    if (typeof message === 'string' && (
      message.includes('overloaded') || message.includes('rate_limit') || message.includes('529')
    )) return true
    // Check nested error object (Anthropic SDK wraps errors)
    const errorObj = (err as Record<string, unknown>).error
    if (errorObj && typeof errorObj === 'object') {
      const errorType = (errorObj as Record<string, unknown>).type
      if (errorType === 'overloaded_error') return true
    }
  }
  return false
}

/** Extract a clean, user-facing error message from an Anthropic SDK error. */
function cleanTriageErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const status = (err as Record<string, unknown>).status
    const errorObj = (err as Record<string, unknown>).error
    const errorType = errorObj && typeof errorObj === 'object'
      ? (errorObj as Record<string, unknown>).type
      : undefined

    if (status === 529 || errorType === 'overloaded_error') {
      return 'The AI classification service is temporarily busy. All doors have been accepted for manual review.'
    }
    if (status === 429) {
      return 'Rate limit reached. All doors have been accepted for manual review.'
    }
  }
  return 'Classification encountered an error. All doors have been accepted for manual review.'
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Application-level retry delays (seconds) AFTER the SDK's internal retries (4x) exhaust.
const APP_RETRY_DELAYS_MS = [30_000, 60_000] // 30s, then 60s

// --- POST handler ---

export async function POST(request: NextRequest) {
  try {
    // Auth check
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
    }

    const body = await request.json()
    const { candidates, userHints } = body as {
      candidates: TriageCandidate[]
      filteredPdfBase64?: string
      projectId?: string
      userHints?: Array<{ question_id: string; question_text: string; answer: string }>
    }

    // Resolve filtered PDF: prefer client-sent filtered pages, fallback to full PDF from storage
    let filteredPdfBase64: string | undefined = body.filteredPdfBase64
    if (!filteredPdfBase64 && body.projectId) {
      try {
        filteredPdfBase64 = await fetchProjectPdfBase64(body.projectId)
      } catch (err) {
        console.error('Failed to fetch PDF from storage for triage:', err instanceof Error ? err.message : String(err))
      }
    }

    if (!candidates || candidates.length === 0) {
      return NextResponse.json({ error: 'No candidates provided' }, { status: 400 })
    }

    // Build the candidate summary for Claude
    const candidateSummary = JSON.stringify(
      candidates.map((c) => ({
        door_number: c.door_number,
        hw_set: c.hw_set ?? '',
        door_type: c.door_type ?? '',
        frame_type: c.frame_type ?? '',
        fire_rating: c.fire_rating ?? '',
        hand: c.hand ?? '',
        location: c.location ?? '',
      })),
      null,
      2
    )

    // Build user hints section if the operator answered validation questions
    let hintsSection = ''
    if (userHints && userHints.length > 0) {
      const lines = userHints.map((h) => `- ${h.question_text}: ${h.answer}`)
      hintsSection = `\n\nThe user (a door hardware professional) provided the following ground-truth answers during validation. Treat these as authoritative:\n${lines.join('\n')}\n`
    }

    const userPrompt = `Classify each candidate as "door", "by_others", or "reject". Return a JSON array of objects with: door_number, class, confidence ("high"/"medium"/"low"), reason (brief).${hintsSection}

Candidates:
${candidateSummary}`

    // Build message content — include filtered PDF if available
    const contentBlocks: Anthropic.Messages.ContentBlockParam[] = []

    if (filteredPdfBase64) {
      contentBlocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: filteredPdfBase64 },
        cache_control: { type: 'ephemeral' },
      } as Anthropic.Messages.ContentBlockParam)
    }

    contentBlocks.push({
      type: 'text',
      text: userPrompt,
    })

    // Call Claude with streaming + application-level retry for transient errors.
    // The SDK already retries 4x internally with backoff. If that's not enough
    // (overloaded_error / 529), we wait 30s then 60s between additional attempts.
    const client = createAnthropicClient()
    let classifications: TriageClassification[] = []

    let lastError: unknown = null
    const maxAttempts = 1 + APP_RETRY_DELAYS_MS.length // 1 initial + 2 retries

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const stream = client.messages.stream({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 8192,
          system: [{ type: 'text', text: TRIAGE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: contentBlocks }],
        })

        const finalMessage = await stream.finalMessage()
        const textBlock = finalMessage.content.find((b) => b.type === 'text')

        if (textBlock?.type === 'text') {
          let text = textBlock.text.trim()
          // Strip markdown code fences if present
          if (text.startsWith('```')) {
            text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
          }

          const parsed = JSON.parse(text)
          // Handle both array and { classifications: [...] } response formats
          classifications = Array.isArray(parsed) ? parsed : (parsed?.classifications ?? [])
        }

        // Log cache usage if available
        const usage = finalMessage.usage as unknown as Record<string, unknown>
        if (usage?.cache_creation_input_tokens || usage?.cache_read_input_tokens) {
          console.debug(`Triage cache: created=${usage.cache_creation_input_tokens ?? 0}, read=${usage.cache_read_input_tokens ?? 0}`)
        }

        // Success — break out of retry loop
        lastError = null
        break
      } catch (llmError) {
        lastError = llmError

        // Only retry on transient errors (overloaded / rate limit)
        if (!isRetryableError(llmError) || attempt >= maxAttempts - 1) {
          break
        }

        const delayMs = APP_RETRY_DELAYS_MS[attempt]
        console.warn(
          `Triage LLM attempt ${attempt + 1}/${maxAttempts} failed (retryable), ` +
          `waiting ${delayMs / 1000}s before retry:`,
          llmError instanceof Error ? llmError.message : String(llmError)
        )
        await sleep(delayMs)
      }
    }

    if (lastError) {
      // All attempts exhausted — fail-open: return all candidates as 'door'
      // but signal the error so the frontend can warn the user
      console.error('Triage LLM call failed after all retries, returning all as door:', lastError)
      classifications = candidates.map((c) => ({
        door_number: c.door_number,
        class: 'door' as const,
        confidence: 'low' as const,
        reason: 'triage_failed',
      }))

      const errorStats = {
        total: candidates.length,
        doors: candidates.length,
        by_others: 0,
        rejected: 0,
      }
      const errorResponse: TriageResponse & { retryable: boolean } = {
        classifications,
        stats: errorStats,
        triage_error: true,
        triage_error_message: cleanTriageErrorMessage(lastError),
        retryable: isRetryableError(lastError),
      }
      return NextResponse.json(errorResponse)
    }

    // Ensure every candidate has a classification (fill gaps with 'door')
    const classifiedDoors = new Set(classifications.map((c) => c.door_number))
    for (const candidate of candidates) {
      if (!classifiedDoors.has(candidate.door_number)) {
        classifications.push({
          door_number: candidate.door_number,
          class: 'door',
          confidence: 'low',
          reason: 'not_classified_by_llm',
        })
      }
    }

    // Compute stats
    const stats = {
      total: classifications.length,
      doors: classifications.filter((c) => c.class === 'door').length,
      by_others: classifications.filter((c) => c.class === 'by_others').length,
      rejected: classifications.filter((c) => c.class === 'reject').length,
    }

    console.debug(`Triage complete: ${stats.total} candidates → ${stats.doors} doors, ${stats.by_others} by_others, ${stats.rejected} rejected`)

    const response: TriageResponse = { classifications, stats }
    return NextResponse.json(response)
  } catch (error) {
    console.error('Triage endpoint error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Triage failed' },
      { status: 500 }
    )
  }
}
