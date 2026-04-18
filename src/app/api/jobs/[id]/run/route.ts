import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import {
  filterAllItemsByOpeningHand,
  type OpeningHandRecord,
} from '@/lib/hardware-handing-filter'
import { logActivity } from '@/lib/activity-log'
import { ACTIVITY_ACTIONS } from '@/lib/constants/activity-actions'
import { fetchProjectPdf } from '@/lib/pdf-storage'
import { extractFireRatings } from '@/lib/fire-rating'
import { scoreExtraction } from '@/lib/confidence-scoring'
import { findPageForSet } from '@/lib/punch-cards'
import {
  createExtractionRun,
  updateExtractionRun,
  writeStagingData,
  type StagingOpening,
} from '@/lib/extraction-staging'
import { toDarrinConfidence, type DarrinConfidence } from '@/lib/types'
import {
  callPdfplumber,
  callDarrinColumnReview,
  callDarrinPostExtraction,
  callDarrinQuantityCheck,
  applyCorrections,
  normalizeQuantities,
  calculateExtractionConfidence,
  callVisionExtraction,
  filterSchedulePages,
  createAnthropicClient,
  buildPerOpeningItems,
  buildDoorToSetMap,
  detectIsPair,
  detectIsPairWithTrace,
  normalizeDoorNumber,
  type PdfplumberResult,
  type VisionExtractionResult,
} from '@/lib/parse-pdf-helpers'
import type { ExtractionConfidence } from '@/lib/types/confidence'
import { shouldAutoTriggerDeepExtraction } from '@/lib/types/confidence'
import { reconcileExtractions } from '@/lib/reconciliation'
import type { ReconciliationResult } from '@/lib/types/reconciliation'
import {
  splitPDFByPages,
  splitPDFFixed,
  mergeHardwareSets,
  mergeDoors,
  CHUNK_SIZE_THRESHOLD,
  FALLBACK_PAGES_PER_CHUNK,
} from '@/lib/pdf-utils'
import type {
  DoorEntry,
  HardwareSet,
  DarrinQuantityCheck,
  PageClassification,
} from '@/lib/types'
import {
  applyClassifyOverrides,
  ClassifyUserOverridesSchema,
  type ClassifyPageDetail,
  type ClassifyPageType,
  type ClassifyUserOverrides,
} from '@/lib/schemas/classify'
import type Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 800

// ── Pipeline deadline ─────────────────────────────────────────────
// Vercel hard-kills at 800s. We stop at 700s to leave buffer for
// writing the failure status to the DB so the user sees "failed"
// instead of an infinite spinner.
const PIPELINE_DEADLINE_MS = 700_000

class PipelineDeadlineError extends Error {
  phase: string
  constructor(phase: string, elapsedMs: number) {
    super(`Pipeline deadline exceeded in '${phase}' after ${Math.round(elapsedMs / 1000)}s (limit: ${PIPELINE_DEADLINE_MS / 1000}s)`)
    this.name = 'PipelineDeadlineError'
    this.phase = phase
  }
}

// ── Triage system prompt (same as triage route) ──────────────────

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

// ── Types ─────────────────────────────────────────────────────────

interface TriageClassification {
  door_number: string
  class: 'door' | 'by_others' | 'reject'
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

// ── Helpers ───────────────────────────────────────────────────────

function getPythonApiBaseUrl(): string {
  return process.env.PYTHON_API_URL
    || process.env.NEXT_PUBLIC_APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
}

async function callClassifyPages(pdfBase64: string): Promise<Record<string, unknown>> {
  const baseUrl = getPythonApiBaseUrl()
  const internalToken = process.env.PYTHON_INTERNAL_SECRET ?? ''
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)

  try {
    const response = await fetch(`${baseUrl}/api/classify-pages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(internalToken ? { 'X-Internal-Token': internalToken } : {}),
      },
      body: JSON.stringify({ pdf_base64: pdfBase64 }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`classify-pages failed (${response.status}): ${text.slice(0, 200)}`)
    }

    return await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function callDetectMapping(pdfBase64: string): Promise<Record<string, unknown>> {
  const baseUrl = getPythonApiBaseUrl()
  const internalToken = process.env.PYTHON_INTERNAL_SECRET ?? ''
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)

  try {
    const response = await fetch(`${baseUrl}/api/detect-mapping`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(internalToken ? { 'X-Internal-Token': internalToken } : {}),
      },
      body: JSON.stringify({ pdf_base64: pdfBase64 }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`detect-mapping failed (${response.status}): ${text.slice(0, 200)}`)
    }

    return await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

// --- Retry helpers ---

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function isRetryableError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const status = (err as Record<string, unknown>).status
    if (status === 429 || status === 529) return true
    const message = (err as Record<string, unknown>).message
    if (typeof message === 'string' && (
      message.includes('overloaded') || message.includes('rate_limit') || message.includes('529')
    )) return true
    const errorObj = (err as Record<string, unknown>).error
    if (errorObj && typeof errorObj === 'object') {
      const errorType = (errorObj as Record<string, unknown>).type
      if (errorType === 'overloaded_error') return true
    }
  }
  return false
}

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

const APP_RETRY_DELAYS_MS = [30_000, 60_000]

async function runTriage(
  client: Anthropic,
  doors: DoorEntry[],
  filteredPdfBase64: string | undefined,
  userHints: Array<{ question_id: string; question_text: string; answer: string }>,
  onStatusUpdate?: (message: string) => Promise<void>,
): Promise<{ classifications: TriageClassification[]; stats: Record<string, number>; triage_error?: boolean; triage_error_message?: string }> {
  const candidates = doors.map(d => ({
    door_number: d.door_number,
    hw_set: d.hw_set ?? '',
    door_type: d.door_type ?? '',
    frame_type: d.frame_type ?? '',
    fire_rating: d.fire_rating ?? '',
    hand: d.hand ?? '',
    location: d.location ?? '',
  }))

  const candidateSummary = JSON.stringify(candidates, null, 2)

  let hintsSection = ''
  if (userHints.length > 0) {
    const lines = userHints.map(h => `- ${h.question_text}: ${h.answer}`)
    hintsSection = `\n\nThe user (a door hardware professional) provided the following ground-truth answers during validation. Treat these as authoritative:\n${lines.join('\n')}\n`
  }

  const userPrompt = `Classify each candidate as "door", "by_others", or "reject". Return a JSON array of objects with: door_number, class, confidence ("high"/"medium"/"low"), reason (brief).${hintsSection}

Candidates:
${candidateSummary}`

  const contentBlocks: Anthropic.Messages.ContentBlockParam[] = []

  if (filteredPdfBase64) {
    contentBlocks.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: filteredPdfBase64 },
      cache_control: { type: 'ephemeral' },
    } as Anthropic.Messages.ContentBlockParam)
  }

  contentBlocks.push({ type: 'text', text: userPrompt })

  let classifications: TriageClassification[] = []
  let lastError: unknown = null
  const maxAttempts = 1 + APP_RETRY_DELAYS_MS.length

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const stream = client.messages.stream({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        system: [{ type: 'text', text: TRIAGE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: contentBlocks }],
      })

      const finalMessage = await stream.finalMessage()
      const textBlock = finalMessage.content.find(b => b.type === 'text')

      if (textBlock?.type === 'text') {
        let text = textBlock.text.trim()
        if (text.startsWith('```')) {
          text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
        }
        const parsed = JSON.parse(text)
        const raw = Array.isArray(parsed) ? parsed : parsed?.classifications
        classifications = Array.isArray(raw) ? raw : []
      }

      lastError = null
      break
    } catch (llmError) {
      lastError = llmError

      if (!isRetryableError(llmError) || attempt >= maxAttempts - 1) {
        break
      }

      const delayMs = APP_RETRY_DELAYS_MS[attempt]
      console.warn(
        `[job-orchestrator] Triage attempt ${attempt + 1}/${maxAttempts} failed (retryable), ` +
        `waiting ${delayMs / 1000}s before retry:`,
        llmError instanceof Error ? llmError.message : String(llmError)
      )

      if (onStatusUpdate) {
        await onStatusUpdate(`Triaging (retrying after ${delayMs / 1000}s wait...)`)
      }

      await sleep(delayMs)
    }
  }

  if (lastError) {
    console.error('[job-orchestrator] Triage LLM failed after all retries, returning all as door:', lastError)
    classifications = candidates.map(c => ({
      door_number: c.door_number,
      class: 'door' as const,
      confidence: 'low' as const,
      reason: 'triage_failed',
    }))

    const stats = { total: candidates.length, doors: candidates.length, by_others: 0, rejected: 0 }
    return {
      classifications,
      stats,
      triage_error: true,
      triage_error_message: cleanTriageErrorMessage(lastError),
    }
  }

  // Ensure every candidate has a classification
  const classifiedDoors = new Set(classifications.map(c => c.door_number))
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

  const stats = {
    total: classifications.length,
    doors: classifications.filter(c => c.class === 'door').length,
    by_others: classifications.filter(c => c.class === 'by_others').length,
    rejected: classifications.filter(c => c.class === 'reject').length,
  }

  return { classifications, stats }
}

// ── Job Status Updater ────────────────────────────────────────────

type JobStatus = 'queued' | 'classifying' | 'detecting_columns' | 'extracting' | 'triaging' | 'validating' | 'writing_staging' | 'completed' | 'failed' | 'cancelled'

/**
 * Merge a per-phase patch into extraction_jobs.phase_data without clobbering
 * keys written by earlier phases. The frontend polls this column to drive
 * Darrin's conversational questions (src/components/ImportWizard/StepQuestions).
 */
async function mergePhaseData(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  jobId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { data, error: readErr } = await supabase
    .from('extraction_jobs')
    .select('phase_data')
    .eq('id', jobId)
    .single()

  if (readErr) {
    console.error(`[job-orchestrator] mergePhaseData read failed for ${jobId}:`, readErr.message)
    return
  }

  const existing =
    data?.phase_data && typeof data.phase_data === 'object' && !Array.isArray(data.phase_data)
      ? (data.phase_data as Record<string, unknown>)
      : {}

  const { error: writeErr } = await supabase
    .from('extraction_jobs')
    .update({ phase_data: { ...existing, ...patch }, updated_at: new Date().toISOString() })
    .eq('id', jobId)

  if (writeErr) {
    console.error(`[job-orchestrator] mergePhaseData write failed for ${jobId}:`, writeErr.message)
  }
}

/**
 * Read user-submitted classify corrections from phase_data.
 * Returns [] when absent or malformed — a corrupt override payload
 * should never block extraction, and Zod validation here is enough to
 * drop invalid entries defensively.
 */
async function readClassifyOverrides(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  jobId: string,
): Promise<ClassifyUserOverrides> {
  const { data, error } = await supabase
    .from('extraction_jobs')
    .select('phase_data')
    .eq('id', jobId)
    .single()

  if (error) {
    console.error(`[job-orchestrator] readClassifyOverrides failed for ${jobId}:`, error.message)
    return []
  }

  const phaseData = data?.phase_data
  if (!phaseData || typeof phaseData !== 'object') return []
  const classify = (phaseData as Record<string, unknown>).classify
  if (!classify || typeof classify !== 'object') return []
  const raw = (classify as Record<string, unknown>).user_overrides
  if (!Array.isArray(raw)) return []

  const parsed = ClassifyUserOverridesSchema.safeParse(raw)
  if (!parsed.success) {
    console.warn(`[job-orchestrator] Job ${jobId} has invalid classify overrides; ignoring.`)
    return []
  }
  return parsed.data
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function updateJob(supabase: any, jobId: string, updates: {
  status?: JobStatus
  progress?: number
  status_message?: string
  classify_result?: unknown
  detect_result?: unknown
  extraction_summary?: unknown
  constraint_flags?: unknown
  extraction_run_id?: string
  started_at?: string
  completed_at?: string
  duration_ms?: number
  error_message?: string
  error_phase?: string
  deep_extraction?: boolean
  auto_triggered?: boolean
  extraction_confidence?: unknown
  reconciliation_result?: unknown
  phase_data?: unknown
}) {
  const { error } = await supabase
    .from('extraction_jobs')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', jobId)

  if (error) {
    console.error(`[job-orchestrator] Failed to update job ${jobId}:`, error.message)
  }
}

// ── POST handler ──────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: jobId } = await params

  // Verify internal auth via CRON_SECRET (never send service-role key over the wire)
  const internalSecret = request.headers.get('x-internal-secret')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || !internalSecret || internalSecret !== cronSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const adminSupabase = createAdminSupabaseClient()
  const startTime = Date.now()

  /** Throw if we've consumed too much of the Vercel timeout budget. */
  function checkDeadline(phase: string): void {
    const elapsed = Date.now() - startTime
    if (elapsed > PIPELINE_DEADLINE_MS) {
      throw new PipelineDeadlineError(phase, elapsed)
    }
  }

  // Atomic claim: set status='classifying' only if currently 'queued'
  const { data: claimed, error: claimError } = await adminSupabase
    .from('extraction_jobs')
    .update({
      status: 'classifying',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      progress: 5,
      status_message: 'Starting extraction pipeline...',
    })
    .eq('id', jobId)
    .eq('status', 'queued')
    .select('*, project_id')
    .single()

  if (claimError || !claimed) {
    console.warn(`[job-orchestrator] Could not claim job ${jobId}: ${claimError?.message ?? 'not in queued state'}`)
    return NextResponse.json({ error: 'Job not available' }, { status: 409 })
  }

  const projectId = claimed.project_id
  const pdfStoragePath = claimed.pdf_storage_path

  // Hoisted so the catch block can mark this run failed if the row was
  // created (created at start of Phase 4). Stays undefined if the error
  // fires before Phase 4 — markRunFailed bails on undefined.
  let runId: string | undefined

  try {
    // ══════════════════════════════════════════════════════════════
    // Phase 1: Fetch PDF from storage
    // ══════════════════════════════════════════════════════════════
    console.log(`[job-orchestrator] Job ${jobId}: fetching PDF for project ${projectId}`)
    const pdfBuffer = await fetchProjectPdf(projectId)
    const pdfBase64 = pdfBuffer.toString('base64')
    const pdfByteLength = pdfBuffer.byteLength

    await updateJob(adminSupabase, jobId, {
      progress: 5,
      status_message: 'PDF loaded. Classifying pages...',
    })

    // ══════════════════════════════════════════════════════════════
    // Phase 2: Classify pages
    // ══════════════════════════════════════════════════════════════
    checkDeadline('classifying')
    console.log(`[job-orchestrator] Job ${jobId}: classifying pages`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const classifyRaw: any = await callClassifyPages(pdfBase64)

    // Transform Python response to match the ClassifyPagesResponse shape.
    // Python returns: { page_classifications: [{index, type, ...}], summary: {door_schedule_pages: count, ...} }
    // Downstream code expects: { pages: [{page_number, page_type, confidence}], summary: {door_schedule_pages: number[], ...} }
    // Without this transform, summary fields are counts (numbers) instead of
    // page-index arrays, which causes "0 is not iterable" when spread.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawPages: Array<{ index: number; type: string; confidence?: number; section_labels?: string[]; hw_set_ids?: string[]; has_door_numbers?: boolean; is_scanned?: boolean }> =
      classifyRaw?.page_classifications ?? []
    const classifyResult = {
      pages: rawPages.map(p => ({
        page_number: p.index,
        page_type: p.type as PageClassification['page_type'],
        confidence: p.confidence ?? 1,
        section_labels: p.section_labels ?? [],
        hw_set_ids: p.hw_set_ids ?? [],
        has_door_numbers: p.has_door_numbers ?? false,
        is_scanned: p.is_scanned ?? false,
      })),
      summary: {
        total_pages: classifyRaw?.total_pages ?? rawPages.length,
        door_schedule_pages: rawPages.filter(p => p.type === 'door_schedule').map(p => p.index),
        hardware_set_pages: rawPages.filter(p => p.type === 'hardware_set').map(p => p.index),
        submittal_pages: rawPages.filter(p => p.type === 'reference').map(p => p.index),
        cover_pages: rawPages.filter(p => p.type === 'cover').map(p => p.index),
        other_pages: rawPages.filter(p => p.type === 'other').map(p => p.index),
        scanned_pages: classifyRaw?.summary?.scanned_pages ?? 0,
      },
      profile: classifyRaw?.profile ?? undefined,
      extraction_strategy: classifyRaw?.extraction_strategy ?? undefined,
    }

    await updateJob(adminSupabase, jobId, {
      status: 'detecting_columns',
      progress: 10,
      status_message: 'Pages classified. Detecting column mappings...',
      classify_result: classifyResult,
    })

    // Publish classify findings for the conversational wizard.
    // Prompt 4: pass the full per-page detail through so StepQuestions
    // can render the correction panel without re-fetching classify_result.
    // `skipped_pages` is now ONLY `other` pages — cover pages are
    // surfaced in their own bucket. The old meaning (cover + other)
    // was ambiguous; downstream code now reads the specific bucket
    // it cares about.
    const classifyPageDetails: ClassifyPageDetail[] = classifyResult.pages.map(p => ({
      page: p.page_number,
      // `hardware_sets` (plural) legacy label collapses to `hardware_set`.
      type: (p.page_type === 'hardware_sets' ? 'hardware_set' : p.page_type) as ClassifyPageType,
      confidence: p.confidence,
      labels: p.section_labels ?? [],
      hw_set_ids: p.hw_set_ids ?? [],
    }))
    await mergePhaseData(adminSupabase, jobId, {
      classify: {
        total_pages: classifyResult.summary.total_pages,
        schedule_pages: classifyResult.summary.door_schedule_pages,
        hardware_pages: classifyResult.summary.hardware_set_pages,
        reference_pages: classifyResult.summary.submittal_pages,
        cover_pages: classifyResult.summary.cover_pages,
        skipped_pages: classifyResult.summary.other_pages,
        page_details: classifyPageDetails,
      },
    })

    // ══════════════════════════════════════════════════════════════
    // Phase 3: Detect column mapping
    // ══════════════════════════════════════════════════════════════
    checkDeadline('detecting_columns')
    console.log(`[job-orchestrator] Job ${jobId}: detecting column mapping`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detectResult: any = await callDetectMapping(pdfBase64)

    // Build userColumnMapping from detect result (same logic as wizard)
    const userColumnMapping: Record<string, number> = {}
    const detectedMappings = detectResult?.mappings ?? detectResult?.columns ?? []
    if (Array.isArray(detectedMappings)) {
      for (let i = 0; i < detectedMappings.length; i++) {
        const m = detectedMappings[i]
        const field = m?.mapped_field ?? m?.field
        if (field) {
          userColumnMapping[field] = m?.column_index ?? i
        }
      }
    }
    const mappingPayload = Object.keys(userColumnMapping).length > 0 ? userColumnMapping : null

    await updateJob(adminSupabase, jobId, {
      status: 'extracting',
      progress: 20,
      status_message: 'Columns detected. Running extraction...',
      detect_result: detectResult,
    })

    // ══════════════════════════════════════════════════════════════
    // Phase 3.5: Apply user classify overrides (if any)
    // ══════════════════════════════════════════════════════════════
    //
    // The user may have corrected the classifier from StepQuestions
    // (the "Something's off" correction panel). Overrides land in
    // phase_data.classify.user_overrides via POST
    // /api/jobs/[id]/classify-overrides. We re-read fresh here because
    // the classify publication above raced with any user interaction.
    //
    // Applying overrides rewrites the summary arrays so the chunked
    // extraction path below sees the corrected page lists. It also
    // rewrites phase_data.classify so later UI reads (poll cycles)
    // reflect the corrected state.
    const overrides = await readClassifyOverrides(adminSupabase, jobId)
    const effectiveSummary = { ...classifyResult.summary }
    if (overrides.length > 0) {
      const corrected = applyClassifyOverrides(classifyPageDetails, overrides)
      effectiveSummary.door_schedule_pages = corrected.schedule_pages
      effectiveSummary.hardware_set_pages = corrected.hardware_pages
      effectiveSummary.submittal_pages = corrected.reference_pages
      effectiveSummary.cover_pages = corrected.cover_pages
      effectiveSummary.other_pages = corrected.skipped_pages

      // Propagate the corrected state so polling clients don't revert
      // the user's edits. Keep user_overrides stored so a retried
      // orchestrator run applies the same corrections deterministically.
      await mergePhaseData(adminSupabase, jobId, {
        classify: {
          total_pages: classifyResult.summary.total_pages,
          schedule_pages: corrected.schedule_pages,
          hardware_pages: corrected.hardware_pages,
          reference_pages: corrected.reference_pages,
          cover_pages: corrected.cover_pages,
          skipped_pages: corrected.skipped_pages,
          page_details: corrected.pageDetails,
          user_overrides: overrides,
        },
      })

      console.log(
        `[job-orchestrator] Job ${jobId}: applied ${overrides.length} classify override(s), ` +
          `excluded ${corrected.excluded_pages.length} page(s)`,
      )
    }

    // ══════════════════════════════════════════════════════════════
    // Phase 4: Extract tables (chunked or single-shot)
    // Replicates StepTriage.tsx extraction flow
    // ══════════════════════════════════════════════════════════════
    console.log(`[job-orchestrator] Job ${jobId}: starting extraction (${pdfByteLength} bytes)`)

    // Create the extraction_runs row up front so its id is available to
    // Darrin call sites in processChunk. Status starts as 'extracting' and
    // is advanced to 'reviewing' / 'completed_with_issues' / 'failed' in
    // Phase 7 (or the catch block). Linking the run to the job here too —
    // same single round-trip we used to make later.
    runId = await createExtractionRun(adminSupabase, {
      projectId,
      userId: claimed.created_by,
      pdfStoragePath,
      pdfHash: claimed.pdf_hash ?? undefined,
      pdfPageCount: claimed.pdf_page_count ?? undefined,
      extractionMethod: 'background_job',
    })
    await adminSupabase
      .from('extraction_runs')
      .update({ job_id: jobId })
      .eq('id', runId)

    const anthropicClient = createAnthropicClient()
    // Derive the requestOrigin for callPdfplumber. In server-side context
    // we don't have a request.url pointing to the app, so use env vars.
    const requestOrigin = getPythonApiBaseUrl()
    let extractedDoors: DoorEntry[]
    let extractedSets: HardwareSet[]
    let extractedReferenceCodes: Array<{ code_type: string; code: string; full_name: string }> = []
    // Worst Darrin CP2 self-reported confidence across chunks. null when no
    // chunk supplied the field (call failed on every chunk, or model omitted).
    let darrinWorstConfidence: DarrinConfidence | null = null
    const allQtyFlags: NonNullable<DarrinQuantityCheck['flags']> = []
    const allQtyComplianceIssues: NonNullable<DarrinQuantityCheck['compliance_issues']> = []
    let failedChunks: Array<{ index: number; error: string }> = []
    let extractionConfidence: ExtractionConfidence | null = null

    checkDeadline('extracting')

    if (pdfByteLength > CHUNK_SIZE_THRESHOLD) {
      // ── Chunked extraction ──
      const summary = effectiveSummary
      const schedulePages: number[] = summary.door_schedule_pages ?? []
      const hwPages: number[] = summary.hardware_set_pages ?? []
      const allContentPages = [...schedulePages, ...hwPages].sort((a, b) => a - b)

      let chunks: string[]
      if (allContentPages.length > 0) {
        const chunkSets: number[][] = []
        for (let i = 0; i < allContentPages.length; i += FALLBACK_PAGES_PER_CHUNK) {
          chunkSets.push(allContentPages.slice(i, i + FALLBACK_PAGES_PER_CHUNK))
        }
        const refPages: number[] = summary.submittal_pages ?? []
        chunks = await splitPDFByPages(pdfBuffer.buffer as ArrayBuffer, chunkSets, refPages)
      } else {
        chunks = await splitPDFFixed(pdfBuffer.buffer as ArrayBuffer, FALLBACK_PAGES_PER_CHUNK)
      }

      await updateJob(adminSupabase, jobId, {
        progress: 20,
        status_message: `Extracting from ${chunks.length} chunk(s)...`,
      })

      const allDoors: DoorEntry[] = []
      const allSets: HardwareSet[] = []
      const allReferenceCodes: Array<{ code_type: string; code: string; full_name: string }> = []
      failedChunks = []

      for (let i = 0; i < chunks.length; i++) {
        checkDeadline('extracting')
        const chunkProgress = 20 + Math.round(((i + 1) / chunks.length) * 40)
        await updateJob(adminSupabase, jobId, {
          progress: chunkProgress,
          status_message: `Extracting chunk ${i + 1} of ${chunks.length}...`,
        })

        try {
          const chunkResult = await processChunk(
            anthropicClient,
            chunks[i],
            i,
            chunks.length,
            allSets.map(s => s.set_id),
            mappingPayload,
            projectId,
            requestOrigin,
            runId,
          )

          allDoors.push(...chunkResult.doors)
          allSets.push(...chunkResult.hardwareSets)
          allReferenceCodes.push(...chunkResult.referenceCodes)
          darrinWorstConfidence = pickWorseDarrinConfidence(
            darrinWorstConfidence,
            chunkResult.darrinPostExtractionConfidence,
          )

          if (chunkResult.darrinQuantityCheck) {
            allQtyFlags.push(...(chunkResult.darrinQuantityCheck.flags ?? []))
            allQtyComplianceIssues.push(...(chunkResult.darrinQuantityCheck.compliance_issues ?? []))
          }

          // Keep worst confidence across chunks
          if (!extractionConfidence || chunkResult.confidence.score < extractionConfidence.score) {
            extractionConfidence = chunkResult.confidence
          }
        } catch (chunkErr) {
          const errorMsg = chunkErr instanceof Error ? chunkErr.message : String(chunkErr)
          console.warn(`[job-orchestrator] Job ${jobId}: chunk ${i + 1} failed:`, errorMsg)
          failedChunks.push({ index: i, error: errorMsg })
        }
      }

      extractedDoors = mergeDoors(allDoors)
      extractedSets = mergeHardwareSets(allSets)
      extractedReferenceCodes = allReferenceCodes
    } else {
      // ── Single-shot extraction ──
      const singleResult = await processChunk(
        anthropicClient,
        pdfBase64,
        0,
        1,
        [],
        mappingPayload,
        projectId,
        requestOrigin,
        runId,
      )

      extractedDoors = singleResult.doors
      extractedSets = singleResult.hardwareSets
      extractedReferenceCodes = singleResult.referenceCodes
      extractionConfidence = singleResult.confidence
      darrinWorstConfidence = singleResult.darrinPostExtractionConfidence

      if (singleResult.darrinQuantityCheck) {
        allQtyFlags.push(...(singleResult.darrinQuantityCheck.flags ?? []))
        allQtyComplianceIssues.push(...(singleResult.darrinQuantityCheck.compliance_issues ?? []))
      }
    }

    if (extractedDoors.length === 0) {
      throw Object.assign(new Error('No doors found during extraction'), { phase: 'extracting' })
    }

    // ── Post-extraction: confidence scoring ──
    const { perDoor } = scoreExtraction(extractedDoors)
    for (const door of extractedDoors) {
      const scores = perDoor.get(door.door_number)
      if (scores) door.field_confidence = scores
    }

    // Publish extraction findings for the conversational wizard
    await mergePhaseData(adminSupabase, jobId, {
      extraction: {
        door_count: extractedDoors.length,
        hw_set_count: extractedSets.length,
        hw_sets: extractedSets.map(s => s.set_id).filter(Boolean),
        sample_doors: extractedDoors.slice(0, 5).map(d => ({
          door_number: d.door_number,
          hw_set: d.hw_set ?? null,
          fire_rating: d.fire_rating ?? null,
        })),
      },
    })

    // ── Populate pdf_page on sets from classify-pages metadata ──
    const classifyPages: PageClassification[] = classifyResult?.pages ?? []
    for (const set of extractedSets) {
      const primaryKey = set.generic_set_id ?? set.set_id
      const page =
        findPageForSet(primaryKey, classifyPages) ??
        (set.generic_set_id && set.set_id !== set.generic_set_id
          ? findPageForSet(set.set_id, classifyPages)
          : null)
      set.pdf_page = page
    }

    // ── Persist reference_codes (manufacturer/finish/option lookups) ──
    // Python extracts these per-chunk; we dedupe across chunks and upsert
    // by (project_id, code_type, code) so re-uploads don't error on the
    // unique constraint. Existing rows are left as-is to preserve any
    // user_corrected source. Fire-and-forget; failures are logged but
    // don't block extraction.
    if (extractedReferenceCodes.length > 0) {
      const seen = new Set<string>()
      const dedupedRows: Array<{
        project_id: string
        code_type: string
        code: string
        full_name: string
        source: string
      }> = []
      for (const rc of extractedReferenceCodes) {
        const key = `${rc.code_type}|${rc.code}`
        if (seen.has(key)) continue
        seen.add(key)
        dedupedRows.push({
          project_id: projectId,
          code_type: rc.code_type,
          code: rc.code,
          full_name: rc.full_name,
          source: 'pdf_extracted',
        })
      }
      const { error: refCodesErr } = await adminSupabase
        .from('reference_codes')
        .upsert(dedupedRows, {
          onConflict: 'project_id,code_type,code',
          ignoreDuplicates: true,
        })
      if (refCodesErr) {
        console.warn(
          `[job-orchestrator] Job ${jobId}: reference_codes upsert failed:`,
          refCodesErr.message,
        )
      } else {
        console.debug(
          `[job-orchestrator] Job ${jobId}: upserted ${dedupedRows.length} reference codes`,
        )
      }
    }

    const extractionIsPartial = failedChunks.length > 0

    // ══════════════════════════════════════════════════════════════
    // Phase 4b: Vision extraction (Strategy B) — optional
    // Runs when the job has deep_extraction flag OR confidence
    // scoring suggests it. Results stored alongside Strategy A for
    // later reconciliation (Phase C).
    // ══════════════════════════════════════════════════════════════
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobDeepFlag = (claimed as any).deep_extraction === true ||
      (claimed as any).extraction_summary?.deep_extraction === true
    const autoTriggered = !jobDeepFlag && extractionConfidence != null &&
      shouldAutoTriggerDeepExtraction(extractionConfidence)
    const shouldRunVision = jobDeepFlag || autoTriggered

    // Persist confidence result to the dedicated column
    if (extractionConfidence) {
      await updateJob(adminSupabase, jobId, {
        extraction_summary: {
          ...(typeof claimed.extraction_summary === 'object' && claimed.extraction_summary !== null
            ? claimed.extraction_summary as Record<string, unknown>
            : {}),
          confidence: {
            overall: extractionConfidence.overall,
            score: extractionConfidence.score,
            suggest_deep_extraction: extractionConfidence.suggest_deep_extraction,
          },
        },
      })
      // Also write to the dedicated extraction_confidence column
      await adminSupabase
        .from('extraction_jobs')
        .update({
          extraction_confidence: {
            overall: extractionConfidence.overall,
            score: extractionConfidence.score,
            suggest_deep_extraction: extractionConfidence.suggest_deep_extraction,
            deep_extraction_reasons: extractionConfidence.deep_extraction_reasons,
            signals: extractionConfidence.signals,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
    }

    // If auto-triggered, upgrade the job in-place
    if (autoTriggered) {
      console.log(
        `[job-orchestrator] Job ${jobId}: auto-triggering deep extraction ` +
        `(confidence score: ${extractionConfidence!.score}, reasons: ${extractionConfidence!.deep_extraction_reasons.join('; ')})`
      )
      await adminSupabase
        .from('extraction_jobs')
        .update({
          deep_extraction: true,
          auto_triggered: true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
    }

    let visionResult: VisionExtractionResult | null = null

    if (shouldRunVision) {
      checkDeadline('vision_extraction')
      const triggerSource = jobDeepFlag ? 'user-requested' : 'auto-triggered'
      console.log(`[job-orchestrator] Job ${jobId}: running vision extraction (Strategy B, ${triggerSource})`)
      await updateJob(adminSupabase, jobId, {
        progress: 65,
        status_message: autoTriggered
          ? 'Running deep extraction for higher accuracy \u2014 this submittal had unusual formatting'
          : 'Running vision extraction (deep analysis)...',
      })

      try {
        const classifyPages: PageClassification[] = classifyResult?.pages ?? []
        const { schedulePages: visionPages } = filterSchedulePages(classifyPages)

        if (visionPages.length > 0) {
          visionResult = await callVisionExtraction(
            anthropicClient,
            pdfBase64,
            visionPages,
            {
              projectId,
              knownSetIds: extractedSets.map(s => s.set_id),
              expectedFormat: 'mixed',
            },
          )

          console.log(
            `[job-orchestrator] Job ${jobId}: vision extraction found ` +
            `${visionResult.hardware_sets.length} sets from ${visionResult.pages_processed} pages ` +
            `in ${visionResult.total_processing_time_ms}ms`,
          )
        } else {
          console.warn(`[job-orchestrator] Job ${jobId}: no schedule pages for vision extraction`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[job-orchestrator] Job ${jobId}: vision extraction failed (non-fatal): ${msg}`)
      }
    }

    // ══════════════════════════════════════════════════════════════
    // Phase 4c: Reconciliation (merge Strategy A + Strategy B)
    // ══════════════════════════════════════════════════════════════
    let reconciliationResult: ReconciliationResult | null = null

    if (visionResult && visionResult.hardware_sets.length > 0) {
      console.log(`[job-orchestrator] Job ${jobId}: reconciling Strategy A (${extractedSets.length} sets) with Strategy B (${visionResult.hardware_sets.length} sets)`)

      try {
        reconciliationResult = reconcileExtractions(extractedSets, visionResult)

        console.log(
          `[job-orchestrator] Job ${jobId}: reconciliation complete — ` +
          `${reconciliationResult.summary.total_sets} sets, ` +
          `${reconciliationResult.summary.total_items} items, ` +
          `score=${reconciliationResult.summary.score}, ` +
          `full_agreement=${reconciliationResult.summary.full_agreement_pct}%, ` +
          `conflicts=${reconciliationResult.summary.conflicts}`,
        )

        // Replace extractedSets with reconciled output for downstream processing
        extractedSets = reconciliationResult.hardware_sets.map(rs => ({
          set_id: rs.set_id,
          heading: String(rs.heading.value),
          heading_doors: String(rs.door_numbers.value).split(', ').filter(Boolean),
          qty_convention: (['per_opening', 'aggregate', 'unknown'].includes(String(rs.qty_convention.value))
            ? String(rs.qty_convention.value) as 'per_opening' | 'aggregate' | 'unknown'
            : 'unknown'),
          items: rs.items.map(ri => ({
            name: String(ri.name.value),
            qty: typeof ri.qty.value === 'number' ? ri.qty.value : Number(ri.qty.value) || 0,
            manufacturer: String(ri.manufacturer.value),
            model: String(ri.model.value),
            finish: String(ri.finish.value),
          })),
        }))
        // Persist reconciliation result to the dedicated column
        await adminSupabase
          .from('extraction_jobs')
          .update({
            reconciliation_result: {
              total_sets: reconciliationResult.summary.total_sets,
              total_items: reconciliationResult.summary.total_items,
              full_agreement_pct: reconciliationResult.summary.full_agreement_pct,
              conflicts: reconciliationResult.summary.conflicts,
              single_source_fields: reconciliationResult.summary.single_source_fields,
              score: reconciliationResult.summary.score,
              overall_confidence: reconciliationResult.summary.overall_confidence,
              audit_log: reconciliationResult.audit_log,
            },
            updated_at: new Date().toISOString(),
          })
          .eq('id', jobId)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[job-orchestrator] Job ${jobId}: reconciliation failed (non-fatal): ${msg}`)
      }
    }

    const deepExtractionLabel = autoTriggered ? ' (deep extraction, auto-triggered)' :
      jobDeepFlag ? ' (deep extraction)' : ''
    await updateJob(adminSupabase, jobId, {
      status: 'triaging',
      progress: 70,
      status_message: `Extraction complete${deepExtractionLabel}: ${extractedDoors.length} doors, ${extractedSets.length} sets${extractionIsPartial ? ` (${failedChunks.length} chunk(s) failed)` : ''}${visionResult ? ` + ${visionResult.hardware_sets.length} vision sets` : ''}${reconciliationResult ? ` (reconciled, score=${reconciliationResult.summary.score})` : ''}. Running triage...`,
      extraction_summary: {
        doors_extracted: extractedDoors.length,
        sets_extracted: extractedSets.length,
        qty_flags: allQtyFlags.length,
        compliance_issues: allQtyComplianceIssues.length,
        partial: extractionIsPartial,
        failedChunks: extractionIsPartial ? failedChunks : undefined,
        deep_extraction: shouldRunVision,
        auto_triggered: autoTriggered,
        confidence: extractionConfidence ? {
          overall: extractionConfidence.overall,
          score: extractionConfidence.score,
          suggest_deep_extraction: extractionConfidence.suggest_deep_extraction,
        } : undefined,
        vision_extraction: visionResult ? {
          sets_found: visionResult.hardware_sets.length,
          pages_processed: visionResult.pages_processed,
          pages_skipped: visionResult.pages_skipped,
          processing_time_ms: visionResult.total_processing_time_ms,
          model_used: visionResult.model_used,
        } : undefined,
        reconciliation: reconciliationResult ? {
          total_sets: reconciliationResult.summary.total_sets,
          total_items: reconciliationResult.summary.total_items,
          full_agreement_pct: reconciliationResult.summary.full_agreement_pct,
          conflicts: reconciliationResult.summary.conflicts,
          single_source_fields: reconciliationResult.summary.single_source_fields,
          score: reconciliationResult.summary.score,
          overall_confidence: reconciliationResult.summary.overall_confidence,
        } : undefined,
      },
    })

    // ══════════════════════════════════════════════════════════════
    // Phase 5: Triage classification
    // ══════════════════════════════════════════════════════════════
    checkDeadline('triaging')
    console.log(`[job-orchestrator] Job ${jobId}: running triage on ${extractedDoors.length} doors`)

    // Build filtered PDF for triage (door schedule + hw set pages only)
    let filteredPdfBase64: string | undefined
    const schedulePages: number[] = effectiveSummary.door_schedule_pages ?? []
    const hwPages: number[] = effectiveSummary.hardware_set_pages ?? []
    const relevantPages = [...schedulePages, ...hwPages]
    if (relevantPages.length > 0) {
      try {
        const chunks = await splitPDFByPages(pdfBuffer.buffer as ArrayBuffer, [relevantPages], [])
        filteredPdfBase64 = chunks[0]
      } catch (err) {
        console.warn('[job-orchestrator] Failed to build filtered PDF for triage:', err)
      }
    }

    // Fetch user hints from job_user_constraints (answers submitted during job)
    const { data: constraints } = await adminSupabase
      .from('job_user_constraints')
      .select('question_key, answer_value')
      .eq('job_id', jobId)

    const userHints = (constraints ?? []).map(c => ({
      question_id: c.question_key,
      question_text: c.question_key,
      answer: typeof c.answer_value === 'string' ? c.answer_value : JSON.stringify(c.answer_value),
    }))

    const triageResult = await runTriage(
      anthropicClient, extractedDoors, filteredPdfBase64, userHints,
      async (message) => {
        await updateJob(adminSupabase, jobId, {
          status: 'triaging',
          status_message: message,
        })
      },
    )

    // Filter accepted doors (same logic as StepTriage.tsx)
    const acceptedDoors = extractedDoors.filter(d => {
      const c = triageResult.classifications.find(cl => cl.door_number === d.door_number)
      return !c || c.class === 'door'
    })

    const flagged = triageResult.classifications
      .filter(c => c.class === 'by_others' || (c.confidence === 'low' && c.class !== 'door'))
      .map(c => ({
        door_number: c.door_number,
        reason: c.reason,
        confidence: c.confidence === 'high' ? 0.9 : c.confidence === 'medium' ? 0.6 : 0.3,
      }))

    const triageSummary = {
      doors_found: triageResult.stats.total,
      by_others: triageResult.stats.by_others,
      rejected: triageResult.stats.rejected,
      accepted_count: acceptedDoors.length,
      flagged_count: flagged.length,
      triage_error: triageResult.triage_error ?? false,
      triage_error_message: triageResult.triage_error_message,
    }

    await updateJob(adminSupabase, jobId, {
      status: 'writing_staging',
      progress: 90,
      status_message: `Triage complete: ${acceptedDoors.length} accepted, ${triageResult.stats.by_others} by-others, ${triageResult.stats.rejected} rejected. Writing staging data...`,
      extraction_summary: {
        doors_extracted: extractedDoors.length,
        sets_extracted: extractedSets.length,
        qty_flags: allQtyFlags.length,
        compliance_issues: allQtyComplianceIssues.length,
        partial: extractionIsPartial,
        failedChunks: extractionIsPartial ? failedChunks : undefined,
        triage: triageSummary,
      },
      constraint_flags: allQtyFlags,
    })

    // ── Compute triage-phase signals for the conversational wizard ──
    //
    // Pair detection mirrors the logic used later when building staging
    // openings; orphan detection mirrors the filteredDoors filter below.
    // Duplicating the math here keeps the UX responsive (Darrin can ask
    // these questions before staging writes happen).
    const setMapForPhase = new Map<string, HardwareSet>()
    for (const set of extractedSets) {
      setMapForPhase.set(set.set_id, set)
      if (set.generic_set_id && set.generic_set_id !== set.set_id) {
        setMapForPhase.set(set.generic_set_id, set)
      }
    }
    const doorToSetMapForPhase = buildDoorToSetMap(extractedSets)

    const fireRatedDoors = acceptedDoors.filter(d => {
      const fr = (d.fire_rating ?? '').trim()
      return fr !== '' && fr.toLowerCase() !== 'none' && fr.toLowerCase() !== 'non-rated'
    })
    const fireRatingsFound = Array.from(
      new Set(
        fireRatedDoors
          .map(d => (d.fire_rating ?? '').trim())
          .filter(fr => fr !== ''),
      ),
    )
    const manufacturersFound = Array.from(
      new Set(
        extractedSets
          .flatMap(s => s.items.map(i => (i.manufacturer ?? '').trim()))
          .filter(m => m !== ''),
      ),
    ).sort((a, b) => a.localeCompare(b))

    const pairDoors: Array<{ door_a: string; door_b: string | null }> = []
    for (const door of acceptedDoors) {
      const doorKey = normalizeDoorNumber(door.door_number)
      const hwSet = doorToSetMapForPhase.get(doorKey) ?? setMapForPhase.get(door.hw_set ?? '')
      const doorInfo = {
        door_type: door.door_type ?? '',
        location: door.location ?? '',
      }
      if (detectIsPair(hwSet, doorInfo)) {
        pairDoors.push({ door_a: door.door_number, door_b: null })
      }
    }

    const orphanDoors: Array<{ door_number: string; reason: string }> = []
    for (const d of acceptedDoors) {
      const hwSetVal = (d.hw_set ?? '').trim()
      if (hwSetVal === '' || hwSetVal === 'N/A') {
        const doorKey = normalizeDoorNumber(d.door_number)
        const resolvedSet = doorToSetMapForPhase.get(doorKey) ?? setMapForPhase.get(hwSetVal)
        if (!resolvedSet || resolvedSet.items.length === 0) {
          orphanDoors.push({
            door_number: d.door_number,
            reason: hwSetVal === 'N/A' ? 'hw_set=N/A' : 'no_hw_set_assigned',
          })
        }
      }
    }

    const fireRatedCount = fireRatedDoors.length
    const fireRatedPct = acceptedDoors.length > 0
      ? Math.round((fireRatedCount / acceptedDoors.length) * 100)
      : 0

    await mergePhaseData(adminSupabase, jobId, {
      triage: {
        fire_rated_count: fireRatedCount,
        fire_rated_pct: fireRatedPct,
        fire_ratings_found: fireRatingsFound,
        manufacturers_found: manufacturersFound,
        pair_doors_detected: pairDoors,
        orphan_doors: orphanDoors,
      },
    })

    // ══════════════════════════════════════════════════════════════
    // Phase 6: Write staging data
    // (extraction_runs row was created at the start of Phase 4 so that
    // Darrin call sites in processChunk could log against runId)
    // ══════════════════════════════════════════════════════════════
    checkDeadline('writing_staging')
    console.log(`[job-orchestrator] Job ${jobId}: writing staging data`)

    // Build lookup maps for buildPerOpeningItems (same pattern as save/route.ts)
    const setMap = new Map<string, HardwareSet>()
    for (const set of extractedSets) {
      setMap.set(set.set_id, set)
      if (set.generic_set_id && set.generic_set_id !== set.set_id) {
        setMap.set(set.generic_set_id, set)
      }
    }
    const doorToSetMap = buildDoorToSetMap(extractedSets)

    // Filter orphan doors — doors with hw_set "N/A" (or empty) that resolve
    // to no hardware set with items. Matching save/route.ts logic.
    const filteredDoors = acceptedDoors.filter(d => {
      const hwSetVal = (d.hw_set ?? '').trim()
      if (hwSetVal !== '' && hwSetVal !== 'N/A') return true
      const doorKey = normalizeDoorNumber(d.door_number)
      const resolvedSet = doorToSetMap.get(doorKey) ?? setMap.get(hwSetVal)
      return resolvedSet != null && resolvedSet.items.length > 0
    })
    if (filteredDoors.length < acceptedDoors.length) {
      const orphanCount = acceptedDoors.length - filteredDoors.length
      const orphanNumbers = acceptedDoors
        .filter(d => !filteredDoors.includes(d))
        .map(d => d.door_number)
      console.log(
        `[job-orchestrator] Job ${jobId}: filtered ${orphanCount} orphan door(s) with no hardware set/items: ${orphanNumbers.join(', ')}`
      )
    }

    const doorInfoMap = new Map<string, { door_type: string; frame_type: string }>()
    for (const d of filteredDoors) {
      doorInfoMap.set(d.door_number, {
        door_type: d.door_type || '',
        frame_type: d.frame_type || '',
      })
    }

    // Convert accepted doors to StagingOpening format.
    // Pair detection runs twice intentionally: once here for staging.leaf_count
    // and once inside buildPerOpeningItems for the per-opening item rows. A
    // threaded isPairByDoor map was tried in PR #306 but caused a fresh
    // Radius DC regression where the map and the extractor's detectIsPair
    // call disagreed on sub-headings that round-tripped through the DB.
    // The leaf_count_consistency invariant catches any remaining disagreement.
    const stagingOpenings: StagingOpening[] = filteredDoors.map(d => {
      const doorKey = normalizeDoorNumber(d.door_number)
      const hwSet = doorToSetMap.get(doorKey) ?? setMap.get(d.hw_set ?? '')
      const doorInfo = doorInfoMap.get(d.door_number)
      const isPair = detectIsPairWithTrace(hwSet, doorInfo, {
        runId,
        set_id: hwSet?.set_id ?? d.hw_set ?? null,
        door_number: d.door_number,
        source: 'jobs_run',
      })
      return {
        door_number: d.door_number,
        hw_set: d.hw_set || undefined,
        hw_heading: d.hw_heading,
        location: d.location || undefined,
        door_type: d.door_type || undefined,
        frame_type: d.frame_type || undefined,
        fire_rating: d.fire_rating || undefined,
        hand: d.hand || undefined,
        pdf_page: setMap.get(d.hw_set ?? '')?.pdf_page ?? null,
        leaf_count: isPair ? 2 : 1,
        field_confidence: d.field_confidence,
      }
    })

    // 6a. Write openings only (items handled separately via buildPerOpeningItems)
    const { openingsCount } = await writeStagingData(
      adminSupabase,
      runId,
      projectId,
      stagingOpenings,
      [],  // empty sets — items inserted separately below
    )

    // 6b. Query back staging openings to get their DB-assigned IDs
    const { data: stagingOpeningRows, error: fetchError } = await adminSupabase
      .from('staging_openings')
      .select('id, door_number, hw_set')
      .eq('extraction_run_id', runId)

    if (fetchError) {
      throw new Error(`Failed to fetch staging openings: ${fetchError.message}`)
    }

    // 6c. Build per-opening items (structural rows + leaf_side + hinge split).
    // buildPerOpeningItems calls detectIsPair internally with the same
    // (hwSet, doorInfo) pair used above for leaf_count.
    const builtItems = buildPerOpeningItems(
      stagingOpeningRows ?? [],
      doorInfoMap,
      setMap,
      doorToSetMap,
      'staging_opening_id',
      { extraction_run_id: runId },
    )

    // 6c-bis. Handing filter — drop items whose inferred handing token
    // contradicts opening.hand on single-leaf openings. Pair openings are
    // skipped (pair-handing is a separate workstream). Parity with
    // src/app/api/parse-pdf/save/route.ts — see that file and
    // src/lib/hardware-handing-filter.ts for full rule detail.
    const handByDoorNumber = new Map<string, { hand: string | null; leafCount: number }>()
    for (const so of stagingOpenings) {
      handByDoorNumber.set(so.door_number, {
        hand: so.hand ?? null,
        leafCount: so.leaf_count ?? 1,
      })
    }
    const openingHandMap: OpeningHandRecord[] = (stagingOpeningRows ?? []).map(
      (row: { id: string; door_number: string }) => {
        const meta = handByDoorNumber.get(row.door_number)
        return {
          id: row.id,
          doorNumber: row.door_number,
          hand: meta?.hand ?? null,
          leafCount: meta?.leafCount ?? 1,
        }
      },
    )
    const handingFilter = filterAllItemsByOpeningHand(
      builtItems,
      openingHandMap,
      'staging_opening_id',
    )
    const allItems = handingFilter.kept

    if (handingFilter.dropped.length > 0) {
      Sentry.addBreadcrumb({
        category: 'extraction.jobs_run.handing_filter',
        level: 'info',
        message: 'handing filter drops',
        data: {
          runId,
          jobId,
          droppedCount: handingFilter.dropped.length,
          openingsWithUnknownHand: handingFilter.openingsWithUnknownHand,
          pairOpeningsSkipped: handingFilter.pairOpeningsSkipped,
          sample: handingFilter.dropped.slice(0, 10).map(d => ({
            door: d.doorNumber,
            name: d.itemName,
            model: d.itemModel,
            itemHanding: d.itemHanding,
            openingHand: d.openingHand,
          })),
        },
      })
      void logActivity({
        projectId,
        userId: claimed.created_by,
        action: ACTIVITY_ACTIONS.EXTRACTION_HANDING_FILTER_APPLIED,
        entityType: 'extraction_job',
        entityId: runId,
        details: {
          runId,
          jobId,
          droppedCount: handingFilter.dropped.length,
          openingsWithUnknownHand: handingFilter.openingsWithUnknownHand,
          pairOpeningsSkipped: handingFilter.pairOpeningsSkipped,
          drops: handingFilter.dropped.map(d => ({
            door_number: d.doorNumber,
            item_name: d.itemName,
            item_model: d.itemModel,
            item_handing: d.itemHanding,
            opening_hand: d.openingHand,
          })),
        },
      })
    }

    // 6d. Chunk-insert staging hardware items (same pattern as save/route.ts)
    const ITEM_CHUNK_SIZE = 50
    let itemsCount = 0
    for (let i = 0; i < allItems.length; i += ITEM_CHUNK_SIZE) {
      const chunk = allItems.slice(i, i + ITEM_CHUNK_SIZE)
      const { data, error: chunkError } = await adminSupabase
        .from('staging_hardware_items')
        .insert(chunk as any)
        .select('id')

      if (chunkError) {
        console.error(`[job-orchestrator] Error inserting staging hw items chunk at ${i}:`, chunkError)
      } else if (data) {
        itemsCount += data.length
      }
    }

    // ══════════════════════════════════════════════════════════════
    // Phase 7: Complete
    // ══════════════════════════════════════════════════════════════
    const durationMs = Date.now() - startTime

    await updateJob(adminSupabase, jobId, {
      status: 'completed',
      progress: 100,
      status_message: `Done: ${openingsCount} openings, ${itemsCount} items staged.`,
      extraction_run_id: runId,
      completed_at: new Date().toISOString(),
      duration_ms: durationMs,
    })

    // Finalize the extraction_runs row. The row was created at the start of
    // Phase 4 with status='extracting' and only the PDF metadata; until this
    // call lands it stays stuck in 'extracting' forever. Confidence prefers
    // Darrin's self-reported value when present, falling back to our local
    // computed score (extractionConfidence). Failures are warned, not
    // thrown — a finalize error must not stop a successful job from
    // returning success to the caller.
    const finalConfidence: DarrinConfidence | undefined =
      darrinWorstConfidence
        ?? toDarrinConfidence(extractionConfidence?.overall, 'medium')
    try {
      await updateExtractionRun(adminSupabase, runId, {
        status: extractionIsPartial ? 'completed_with_issues' : 'reviewing',
        confidence: finalConfidence,
        confidenceScore: extractionConfidence?.score,
        doorsExtracted: openingsCount,
        hwSetsExtracted: extractedSets.length,
        referenceCodesExtracted: extractedReferenceCodes.length,
        completedAt: new Date().toISOString(),
        durationMs,
      })
    } catch (finalizeErr) {
      console.warn(
        `[job-orchestrator] Job ${jobId}: extraction_runs finalize failed:`,
        finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr),
      )
    }

    console.log(`[job-orchestrator] Job ${jobId}: completed in ${durationMs}ms — ${openingsCount} openings, ${itemsCount} items`)

    return NextResponse.json({
      success: true,
      jobId,
      extractionRunId: runId,
      openingsCount,
      itemsCount,
      durationMs,
      visionExtraction: visionResult ? {
        sets_found: visionResult.hardware_sets.length,
        pages_processed: visionResult.pages_processed,
        processing_time_ms: visionResult.total_processing_time_ms,
      } : undefined,
    })
  } catch (error) {
    const durationMs = Date.now() - startTime

    // Mark the extraction_runs row failed if it was created. The row is
    // created at the start of Phase 4, so any error before that leaves
    // runId undefined — bail in that case. Wrapped so a finalize error
    // can't mask the original error returned to the caller.
    const markRunFailed = async (msg: string) => {
      if (!runId) return
      try {
        await updateExtractionRun(adminSupabase, runId, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          durationMs,
          errorMessage: msg,
        })
      } catch (finalizeErr) {
        console.warn(
          `[job-orchestrator] Job ${jobId}: extraction_runs failure-finalize failed:`,
          finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr),
        )
      }
    }

    // Specific handling for deadline exceeded — not an unexpected crash
    if (error instanceof PipelineDeadlineError) {
      console.error(`[job-orchestrator] Job ${jobId}: ${error.message}`)
      await updateJob(adminSupabase, jobId, {
        status: 'failed',
        error_message: error.message,
        error_phase: error.phase,
        completed_at: new Date().toISOString(),
        duration_ms: durationMs,
      })
      await markRunFailed(error.message)
      return NextResponse.json({ error: error.message }, { status: 504 })
    }

    const message = error instanceof Error ? error.message : 'Job execution failed'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const phase = (error as any)?.phase ?? 'unknown'

    console.error(`[job-orchestrator] Job ${jobId} failed in phase ${phase} after ${durationMs}ms:`, message)

    await updateJob(adminSupabase, jobId, {
      status: 'failed',
      error_message: message,
      error_phase: phase,
      completed_at: new Date().toISOString(),
      duration_ms: durationMs,
    })
    await markRunFailed(message)

    return NextResponse.json({ error: message, phase }, { status: 500 })
  }
}

// ── Chunk Processor ───────────────────────────────────────────────
// Replicates the logic from /api/parse-pdf/chunk/route.ts, calling
// helper functions directly instead of fetching the API route.

/**
 * Pick the worse of two DarrinConfidence values, treating null as "no signal."
 * Order: low > medium > high (low is worst). Used to aggregate per-chunk
 * Darrin confidence into a single value for the run.
 */
function pickWorseDarrinConfidence(
  current: DarrinConfidence | null,
  next: DarrinConfidence | null,
): DarrinConfidence | null {
  if (next === null) return current
  if (current === null) return next
  const rank: Record<DarrinConfidence, number> = { low: 0, medium: 1, high: 2 }
  return rank[next] < rank[current] ? next : current
}

async function processChunk(
  client: Anthropic,
  chunkBase64: string,
  chunkIndex: number,
  totalChunks: number,
  knownSetIds: string[],
  userColumnMapping: Record<string, number> | null,
  projectId: string,
  requestOrigin: string,
  extractionRunId: string,
): Promise<{
  doors: DoorEntry[]
  hardwareSets: HardwareSet[]
  darrinQuantityCheck: DarrinQuantityCheck | null
  confidence: ExtractionConfidence
  referenceCodes: Array<{ code_type: string; code: string; full_name: string }>
  /** Darrin's self-reported confidence on this chunk's CP2 review.
   *  null when Darrin omitted the field (older responses return corrections
   *  without overall_confidence). A hard failure of callDarrinPostExtraction
   *  throws out of processChunk, so this field is only reached on success. */
  darrinPostExtractionConfidence: DarrinConfidence | null
}> {
  // Step 1: Pdfplumber extraction
  let pdfplumberResult: PdfplumberResult | null = null
  try {
    pdfplumberResult = await callPdfplumber(chunkBase64, userColumnMapping, requestOrigin)
    console.debug(
      `[job] Chunk ${chunkIndex + 1}/${totalChunks}: pdfplumber extracted ` +
      `${pdfplumberResult.hw_sets_found} sets, ${pdfplumberResult.openings.length} doors`
    )
  } catch (err) {
    console.error(
      `[job] Chunk ${chunkIndex + 1}/${totalChunks}: pdfplumber failed:`,
      err instanceof Error ? err.message : String(err)
    )
  }

  // Convert pdfplumber result to our types
  let hardwareSets: HardwareSet[] = (pdfplumberResult?.hardware_sets || []).map(s => ({
    set_id: s.set_id,
    generic_set_id: s.generic_set_id,
    heading: s.heading,
    heading_door_count: s.heading_door_count,
    heading_leaf_count: s.heading_leaf_count,
    heading_doors: s.heading_doors ?? [],
    qty_convention: s.qty_convention ?? 'unknown',
    items: (s.items ?? []).map(i => ({
      qty: i.qty,
      qty_total: i.qty_total,
      qty_door_count: i.qty_door_count,
      qty_source: i.qty_source,
      name: i.name,
      manufacturer: i.manufacturer,
      model: i.model,
      finish: i.finish,
    })),
  }))

  let doors: DoorEntry[] = pdfplumberResult?.openings || []

  // Step 2: Darrin CP1 — Column Mapping Review (first chunk only)
  if (chunkIndex === 0 && userColumnMapping) {
    try {
      await callDarrinColumnReview(client, chunkBase64, userColumnMapping, { projectId, extractionRunId })
    } catch (err) {
      console.error('[job] Darrin column review error:', err instanceof Error ? err.message : String(err))
    }
  }

  // Step 3: Darrin CP2 — Post-Extraction Review
  const corrections = await callDarrinPostExtraction(client, chunkBase64, pdfplumberResult ?? {
    success: false,
    openings: [],
    hardware_sets: [],
    reference_codes: [],
    flagged_doors: [],
    expected_door_count: 0,
    tables_found: 0,
    hw_sets_found: 0,
    method: 'none',
    error: 'pdfplumber failed',
  }, knownSetIds, { projectId, extractionRunId })

  // Apply corrections
  const corrected = applyCorrections(hardwareSets, doors, corrections)
  hardwareSets = corrected.hardwareSets
  doors = corrected.doors

  // Post-Darrin quantity normalization
  normalizeQuantities(hardwareSets, doors)

  // Extract fire ratings
  extractFireRatings(doors)

  // Step 4: Darrin CP3 — Quantity Sanity Check
  let quantityCheck: DarrinQuantityCheck | null = null
  try {
    quantityCheck = await callDarrinQuantityCheck(client, chunkBase64, hardwareSets, doors, null, { projectId, extractionRunId })
  } catch (err) {
    console.error('[job] Darrin quantity check error:', err instanceof Error ? err.message : String(err))
  }

  // Step 5: Confidence Scoring
  const confidence = calculateExtractionConfidence(hardwareSets, doors, corrections)

  // Reference codes — pass through from pdfplumber so the orchestrator can
  // upsert them into public.reference_codes after extraction completes.
  // Filtered to the schema's allowed code_type values.
  const referenceCodes = (pdfplumberResult?.reference_codes ?? []).filter(
    rc => rc && rc.code_type && rc.code && rc.full_name
      && (rc.code_type === 'manufacturer' || rc.code_type === 'finish' || rc.code_type === 'option')
  )

  // Darrin's self-reported overall_confidence from CP2. The schema permits
  // omission (older Darrin responses), so this returns null in that case so
  // the orchestrator can distinguish "no signal" from "low". If the CP2 call
  // itself fails, the throw propagates — we never reach this line.
  const darrinPostExtractionConfidence: DarrinConfidence | null =
    corrections.overall_confidence === 'high'
      || corrections.overall_confidence === 'medium'
      || corrections.overall_confidence === 'low'
      ? corrections.overall_confidence
      : null

  return {
    doors,
    hardwareSets,
    darrinQuantityCheck: quantityCheck,
    confidence,
    referenceCodes,
    darrinPostExtractionConfidence,
  }
}
