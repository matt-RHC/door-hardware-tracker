import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import { fetchProjectPdf } from '@/lib/pdf-storage'
import { extractFireRatings } from '@/lib/fire-rating'
import { scoreExtraction } from '@/lib/confidence-scoring'
import { findPageForSet } from '@/lib/punch-cards'
import {
  createExtractionRun,
  writeStagingData,
  type StagingOpening,
} from '@/lib/extraction-staging'
import {
  callPdfplumber,
  callPunchyColumnReview,
  callPunchyPostExtraction,
  callPunchyQuantityCheck,
  applyCorrections,
  normalizeQuantities,
  createAnthropicClient,
  type PdfplumberResult,
} from '@/lib/parse-pdf-helpers'
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
  PunchyQuantityCheck,
  PageClassification,
} from '@/lib/types'
import type Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 800

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

async function runTriage(
  client: Anthropic,
  doors: DoorEntry[],
  filteredPdfBase64: string | undefined,
  userHints: Array<{ question_id: string; question_text: string; answer: string }>,
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
      classifications = Array.isArray(parsed) ? parsed : (parsed?.classifications ?? [])
    }
  } catch (llmError) {
    console.error('[job-orchestrator] Triage LLM failed, returning all as door:', llmError)
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
      triage_error_message: `AI triage failed: ${llmError instanceof Error ? llmError.message : 'Unknown error'}. All candidates auto-accepted.`,
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
    console.log(`[job-orchestrator] Job ${jobId}: classifying pages`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const classifyResult: any = await callClassifyPages(pdfBase64)

    await updateJob(adminSupabase, jobId, {
      status: 'detecting_columns',
      progress: 10,
      status_message: 'Pages classified. Detecting column mappings...',
      classify_result: classifyResult,
    })

    // ══════════════════════════════════════════════════════════════
    // Phase 3: Detect column mapping
    // ══════════════════════════════════════════════════════════════
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
    // Phase 4: Extract tables (chunked or single-shot)
    // Replicates StepTriage.tsx extraction flow
    // ══════════════════════════════════════════════════════════════
    console.log(`[job-orchestrator] Job ${jobId}: starting extraction (${pdfByteLength} bytes)`)

    const anthropicClient = createAnthropicClient()
    // Derive the requestOrigin for callPdfplumber. In server-side context
    // we don't have a request.url pointing to the app, so use env vars.
    const requestOrigin = getPythonApiBaseUrl()
    let extractedDoors: DoorEntry[]
    let extractedSets: HardwareSet[]
    const allQtyFlags: NonNullable<PunchyQuantityCheck['flags']> = []
    const allQtyComplianceIssues: NonNullable<PunchyQuantityCheck['compliance_issues']> = []

    if (pdfByteLength > CHUNK_SIZE_THRESHOLD) {
      // ── Chunked extraction ──
      const summary = classifyResult?.summary ?? {}
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

      for (let i = 0; i < chunks.length; i++) {
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
          )

          allDoors.push(...chunkResult.doors)
          allSets.push(...chunkResult.hardwareSets)

          if (chunkResult.punchyQuantityCheck) {
            allQtyFlags.push(...(chunkResult.punchyQuantityCheck.flags ?? []))
            allQtyComplianceIssues.push(...(chunkResult.punchyQuantityCheck.compliance_issues ?? []))
          }
        } catch (chunkErr) {
          console.warn(`[job-orchestrator] Job ${jobId}: chunk ${i + 1} failed:`, chunkErr instanceof Error ? chunkErr.message : String(chunkErr))
        }
      }

      extractedDoors = mergeDoors(allDoors)
      extractedSets = mergeHardwareSets(allSets)
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
      )

      extractedDoors = singleResult.doors
      extractedSets = singleResult.hardwareSets

      if (singleResult.punchyQuantityCheck) {
        allQtyFlags.push(...(singleResult.punchyQuantityCheck.flags ?? []))
        allQtyComplianceIssues.push(...(singleResult.punchyQuantityCheck.compliance_issues ?? []))
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

    await updateJob(adminSupabase, jobId, {
      status: 'triaging',
      progress: 70,
      status_message: `Extraction complete: ${extractedDoors.length} doors, ${extractedSets.length} sets. Running triage...`,
      extraction_summary: {
        doors_extracted: extractedDoors.length,
        sets_extracted: extractedSets.length,
        qty_flags: allQtyFlags.length,
        compliance_issues: allQtyComplianceIssues.length,
      },
    })

    // ══════════════════════════════════════════════════════════════
    // Phase 5: Triage classification
    // ══════════════════════════════════════════════════════════════
    console.log(`[job-orchestrator] Job ${jobId}: running triage on ${extractedDoors.length} doors`)

    // Build filtered PDF for triage (door schedule + hw set pages only)
    let filteredPdfBase64: string | undefined
    const schedulePages: number[] = classifyResult?.summary?.door_schedule_pages ?? []
    const hwPages: number[] = classifyResult?.summary?.hardware_set_pages ?? []
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

    const triageResult = await runTriage(anthropicClient, extractedDoors, filteredPdfBase64, userHints)

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
        triage: triageSummary,
      },
      constraint_flags: allQtyFlags,
    })

    // ══════════════════════════════════════════════════════════════
    // Phase 6: Create extraction run + write staging data
    // ══════════════════════════════════════════════════════════════
    console.log(`[job-orchestrator] Job ${jobId}: writing staging data`)

    const runId = await createExtractionRun(adminSupabase, {
      projectId,
      userId: claimed.created_by,
      pdfStoragePath,
      pdfHash: claimed.pdf_hash ?? undefined,
      pdfPageCount: claimed.pdf_page_count ?? undefined,
      extractionMethod: 'background_job',
    })

    // Link extraction run to job
    await adminSupabase
      .from('extraction_runs')
      .update({ job_id: jobId })
      .eq('id', runId)

    // Convert accepted doors to StagingOpening format
    const stagingOpenings: StagingOpening[] = acceptedDoors.map(d => ({
      door_number: d.door_number,
      hw_set: d.hw_set || undefined,
      hw_heading: d.hw_heading,
      location: d.location || undefined,
      door_type: d.door_type || undefined,
      frame_type: d.frame_type || undefined,
      fire_rating: d.fire_rating || undefined,
      hand: d.hand || undefined,
      pdf_page: undefined, // set lookup happens in writeStagingData
      leaf_count: d.leaf_count,
      field_confidence: d.field_confidence,
    }))

    const stagingSets = extractedSets.map(s => ({
      set_id: s.set_id,
      generic_set_id: s.generic_set_id,
      heading: s.heading,
      heading_doors: s.heading_doors,
      pdf_page: s.pdf_page,
      items: s.items.map(i => ({
        name: i.name,
        qty: i.qty,
        qty_total: i.qty_total,
        qty_door_count: i.qty_door_count,
        qty_source: i.qty_source,
        manufacturer: i.manufacturer,
        model: i.model,
        finish: i.finish,
      })),
    }))

    const { openingsCount, itemsCount } = await writeStagingData(
      adminSupabase,
      runId,
      projectId,
      stagingOpenings,
      stagingSets,
    )

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

    console.log(`[job-orchestrator] Job ${jobId}: completed in ${durationMs}ms — ${openingsCount} openings, ${itemsCount} items`)

    return NextResponse.json({
      success: true,
      jobId,
      extractionRunId: runId,
      openingsCount,
      itemsCount,
      durationMs,
    })
  } catch (error) {
    const durationMs = Date.now() - startTime
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

    return NextResponse.json({ error: message, phase }, { status: 500 })
  }
}

// ── Chunk Processor ───────────────────────────────────────────────
// Replicates the logic from /api/parse-pdf/chunk/route.ts, calling
// helper functions directly instead of fetching the API route.

async function processChunk(
  client: Anthropic,
  chunkBase64: string,
  chunkIndex: number,
  totalChunks: number,
  knownSetIds: string[],
  userColumnMapping: Record<string, number> | null,
  projectId: string,
  requestOrigin: string,
): Promise<{
  doors: DoorEntry[]
  hardwareSets: HardwareSet[]
  punchyQuantityCheck: PunchyQuantityCheck | null
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

  // Step 2: Punchy CP1 — Column Mapping Review (first chunk only)
  if (chunkIndex === 0 && userColumnMapping) {
    try {
      await callPunchyColumnReview(client, chunkBase64, userColumnMapping, { projectId })
    } catch (err) {
      console.error('[job] Punchy column review error:', err instanceof Error ? err.message : String(err))
    }
  }

  // Step 3: Punchy CP2 — Post-Extraction Review
  const corrections = await callPunchyPostExtraction(client, chunkBase64, pdfplumberResult ?? {
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
  }, knownSetIds, { projectId })

  // Apply corrections
  const corrected = applyCorrections(hardwareSets, doors, corrections)
  hardwareSets = corrected.hardwareSets
  doors = corrected.doors

  // Post-Punchy quantity normalization
  normalizeQuantities(hardwareSets, doors)

  // Extract fire ratings
  extractFireRatings(doors)

  // Step 4: Punchy CP3 — Quantity Sanity Check
  let quantityCheck: PunchyQuantityCheck | null = null
  try {
    quantityCheck = await callPunchyQuantityCheck(client, chunkBase64, hardwareSets, doors, null, { projectId })
  } catch (err) {
    console.error('[job] Punchy quantity check error:', err instanceof Error ? err.message : String(err))
  }

  return { doors, hardwareSets, punchyQuantityCheck: quantityCheck }
}
