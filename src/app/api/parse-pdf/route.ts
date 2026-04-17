import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { extractFireRatings } from '@/lib/fire-rating'
import { fetchProjectPdfBase64 } from '@/lib/pdf-storage'
import type {
  DoorEntry,
  HardwareSet,
  DarrinCorrections,
  DarrinQuantityCheck,
  DarrinObservation,
} from '@/lib/types'
import { toDarrinConfidence } from '@/lib/types'
import {
  callPdfplumber,
  callDarrinColumnReview,
  callDarrinPostExtraction,
  callDarrinQuantityCheck,
  applyCorrections,
  normalizeQuantities,
  calculateExtractionConfidence,
  createAnthropicClient,
  type PdfplumberResult,
} from '@/lib/parse-pdf-helpers'
import { shouldAutoTriggerDeepExtraction } from '@/lib/types/confidence'
import type { ExtractionConfidence } from '@/lib/types/confidence'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import { assertProjectMember } from '@/lib/auth-helpers'
import { assertProjectInUserCompany, CompanyAccessError } from '@/lib/companies'
import { validateJson, errorResponse } from '@/lib/api-helpers/validate'
import { ParsePdfRequestSchema } from '@/lib/schemas/parse-pdf'

// Vercel Fluid Compute: 800s timeout (Pro plan max)
export const maxDuration = 800

// --- Core extraction logic (non-chunked flow orchestrator) ---

/**
 * Shape of the optional user-confirmed golden sample threaded through to
 * Darrin's post-extraction review (CP2) and quantity check (CP3) so the
 * LLM can treat that sample as the naming / quantity baseline for the
 * submittal. Matches the shape accepted by the deep-extract route.
 */
type GoldenSampleInput = {
  set_id: string
  items: Array<{
    qty: number
    name: string
    manufacturer?: string
    model?: string
    finish?: string
  }>
} | null | undefined

async function extractFromPDF(
  base64: string,
  filteredPdfBase64?: string,
  userColumnMapping?: Record<string, number> | null,
  projectId?: string,
  goldenSample?: GoldenSampleInput,
  requestOrigin?: string,
): Promise<{
  hardwareSets: HardwareSet[]
  doors: DoorEntry[]
  corrections: DarrinCorrections
  darrinObservations: DarrinObservation[]
  darrinQuantityCheck: DarrinQuantityCheck | null
  confidence: ExtractionConfidence
  stats: { tables_found: number; hw_sets_found: number; method: string }
}> {
  let pdfplumberResult: PdfplumberResult | null = null
  try {
    pdfplumberResult = await callPdfplumber(base64, userColumnMapping, requestOrigin)
    console.debug(
      `Pdfplumber: ${pdfplumberResult.hw_sets_found} hardware sets, ` +
      `${pdfplumberResult.openings.length} doors, ` +
      `${(pdfplumberResult.reference_codes ?? []).length} reference codes`
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('Pdfplumber extraction failed:', msg)
  }

  // Python layer now handles qty normalization (total ÷ door_count = per-opening).
  // Pass through qty metadata fields as-is.
  //
  // heading_doors MUST be forwarded — the Python extractor populates it
  // via extract_heading_door_numbers() so the TS layer can route doors
  // to specific sub-sets (DH4A.0 vs DH4A.1). Dropping it here silently
  // breaks buildDoorToSetMap() and the wizard's Verify Sample picker,
  // which produced the "wrong door paired with wrong items" symptom.
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

  let allDoors: DoorEntry[] = pdfplumberResult?.openings || []

  const client = createAnthropicClient()
  const darrinObservations: DarrinObservation[] = []

  // Use filtered PDF for Darrin review if available (fewer pages = cheaper + faster)
  const reviewPdf = filteredPdfBase64 ?? base64

  // ==========================================
  // Darrin Checkpoint 1: Column Mapping Review
  // ==========================================
  if (userColumnMapping) {
    try {
      const columnReview = await callDarrinColumnReview(client, reviewPdf, userColumnMapping, { projectId })
      if ((columnReview.unmapped_fields?.length ?? 0) > 0 || (columnReview.mapping_issues?.length ?? 0) > 0) {
        darrinObservations.push({
          checkpoint: 'column_mapping',
          message: columnReview.notes ?? 'Column mapping review complete',
          confidence: (columnReview.unmapped_fields?.length ?? 0) > 0 ? 'medium' : 'high',
          field_suggestions: (columnReview.unmapped_fields ?? []).map(f => ({
            field: f.field,
            suggestion: f.suggestion,
            confidence: f.confidence,
          })),
        })
      }
      console.debug(`Darrin column review: ${columnReview.unmapped_fields?.length ?? 0} unmapped fields, ${columnReview.mapping_issues?.length ?? 0} issues`)
    } catch (err) {
      console.error('Darrin column review error:', err instanceof Error ? err.message : String(err))
    }
  }

  // ==========================================
  // Darrin Checkpoint 2: Post-Extraction Review
  // ==========================================
  // Pass extracted set IDs so Darrin knows the full set context (mirrors chunk route)
  const knownSetIds = (pdfplumberResult?.hardware_sets ?? []).map(s => s.set_id)

  const corrections = await callDarrinPostExtraction(client, reviewPdf, pdfplumberResult ?? {
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
  }, knownSetIds, { projectId, goldenSample: goldenSample ?? undefined })

  if (corrections.notes) {
    darrinObservations.push({
      checkpoint: 'post_extraction',
      message: corrections.notes,
      confidence: toDarrinConfidence(corrections.overall_confidence),
    })
  }

  const corrected = applyCorrections(hardwareSets, allDoors, corrections)
  hardwareSets = corrected.hardwareSets
  allDoors = corrected.doors

  // Post-Darrin qty re-normalization
  normalizeQuantities(hardwareSets, allDoors)

  // Extract fire ratings embedded in hw_heading/location fields
  extractFireRatings(allDoors)

  // ==========================================
  // Darrin Checkpoint 3: Quantity Sanity Check
  // ==========================================
  let darrinQuantityCheck: DarrinQuantityCheck | null = null
  try {
    darrinQuantityCheck = await callDarrinQuantityCheck(client, reviewPdf, hardwareSets, allDoors, goldenSample ?? undefined, { projectId })
    if ((darrinQuantityCheck.flags?.length ?? 0) > 0 || (darrinQuantityCheck.compliance_issues?.length ?? 0) > 0) {
      darrinObservations.push({
        checkpoint: 'quantity_check',
        message: darrinQuantityCheck.notes ?? 'Quantity check complete',
        confidence: (darrinQuantityCheck.compliance_issues?.length ?? 0) > 0 ? 'medium' : 'high',
      })
    }
  } catch (err) {
    console.error('Darrin quantity check error:', err instanceof Error ? err.message : String(err))
  }

  // ==========================================
  // Confidence Scoring (runs after full pipeline)
  // ==========================================
  const confidence = calculateExtractionConfidence(hardwareSets, allDoors, corrections)

  return {
    hardwareSets,
    doors: allDoors,
    corrections,
    darrinObservations,
    darrinQuantityCheck,
    confidence,
    stats: {
      tables_found: pdfplumberResult?.tables_found ?? 0,
      hw_sets_found: pdfplumberResult?.hw_sets_found ?? 0,
      method: pdfplumberResult?.method ?? 'none',
    },
  }
}

// --- Main handler ---

export async function POST(request: NextRequest) {
  try {
    // Service role bypass for testing scripts (e.g. run-golden-suite.mjs)
    const serviceRoleHeader = request.headers.get('x-service-role')
    const isServiceRole = serviceRoleHeader && serviceRoleHeader === process.env.SUPABASE_SERVICE_ROLE_KEY
    let userSupabase: Awaited<ReturnType<typeof createServerSupabaseClient>> | null = null
    let authedUserId: string | null = null
    if (!isServiceRole) {
      userSupabase = await createServerSupabaseClient()
      const { data: { user }, error: authError } = await userSupabase.auth.getUser()
      if (authError || !user) {
        return errorResponse('AUTH_REQUIRED', 'You must be signed in')
      }
      authedUserId = user.id
    }

    const parsed = await validateJson(request, ParsePdfRequestSchema)
    if (!parsed.ok) return parsed.response
    const body = parsed.data

    // Enforce project + company membership when a projectId is provided
    // (IDOR + cross-tenant prevention). Skipped for service-role callers
    // (testing scripts). assertProjectInUserCompany re-checks project_members
    // internally, so we drop the redundant assertProjectMember call here.
    if (userSupabase && authedUserId && body.projectId) {
      try {
        await assertProjectInUserCompany(userSupabase, body.projectId)
      } catch (err) {
        if (err instanceof CompanyAccessError) {
          return errorResponse('ACCESS_DENIED', err.message)
        }
        return errorResponse('ACCESS_DENIED', 'Access denied to this project')
      }
    }
    // Keep assertProjectMember imported for other paths/tests that still
    // rely on the project-only assertion.
    void assertProjectMember

    // Resolve PDF: prefer server-side storage fetch via projectId, fallback to base64 in body
    let base64: string = body.pdfBase64 ?? ''
    if (!base64 && body.projectId) {
      try {
        base64 = await fetchProjectPdfBase64(body.projectId)
      } catch (err) {
        console.error('Failed to fetch PDF from storage:', err instanceof Error ? err.message : String(err))
      }
    }
    if (!base64) {
      return errorResponse('VALIDATION_ERROR', 'Missing pdfBase64 or projectId')
    }

    // Client may send a filtered PDF (opening list + hardware schedule pages only)
    // for cheaper LLM review. pdfplumber still gets the full PDF.
    const filteredPdfBase64: string | undefined = body.filteredPdfBase64 ?? undefined

    const userColumnMapping = body.userColumnMapping ?? null
    const projectId: string | undefined = body.projectId ?? undefined
    // Optional user-confirmed golden sample — threaded to Darrin CP2/CP3
    // so naming + quantity conventions are treated as the baseline for
    // the submittal. Matches the shape already accepted by deep-extract.
    const goldenSample: GoldenSampleInput = body.goldenSample ?? undefined
    const requestOrigin = new URL(request.url).origin
    const { hardwareSets, doors, corrections, darrinObservations, darrinQuantityCheck, confidence, stats } = await extractFromPDF(base64, filteredPdfBase64, userColumnMapping, projectId, goldenSample, requestOrigin)

    // ── Auto-queue deep extraction job if confidence is low ──
    const suggestDeep = shouldAutoTriggerDeepExtraction(confidence)
    let deepExtractionAutoQueued = false

    if (suggestDeep && projectId) {
      try {
        const adminSupabase = createAdminSupabaseClient()

        // Look up project to get PDF storage path
        const { data: project } = await adminSupabase
          .from('projects')
          .select('pdf_storage_path, last_pdf_hash, pdf_page_count')
          .eq('id', projectId)
          .single()

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const projectRow = project as any
        if (projectRow?.pdf_storage_path) {
          const { data: job, error: insertError } = await adminSupabase
            .from('extraction_jobs')
            .insert({
              project_id: projectId,
              created_by: authedUserId ?? '',
              status: 'queued',
              status_message: 'Auto-queued: low confidence extraction',
              pdf_storage_path: projectRow.pdf_storage_path,
              pdf_hash: projectRow.last_pdf_hash ?? null,
              pdf_page_count: projectRow.pdf_page_count ?? null,
              deep_extraction: true,
              auto_triggered: true,
              extraction_confidence: {
                overall: confidence.overall,
                score: confidence.score,
                suggest_deep_extraction: confidence.suggest_deep_extraction,
                deep_extraction_reasons: confidence.deep_extraction_reasons,
              },
            })
            .select('id')
            .single()

          if (!insertError && job) {
            deepExtractionAutoQueued = true
            console.log(`[parse-pdf] Auto-queued deep extraction job ${job.id} for project ${projectId} (confidence score: ${confidence.score})`)

            // Fire-and-forget: kick off the job
            const baseUrl = process.env.NEXT_PUBLIC_APP_URL
              || (requestOrigin && requestOrigin !== 'null' ? requestOrigin : null)
              || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

            fetch(`${baseUrl}/api/jobs/${job.id}/run`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-internal-secret': process.env.CRON_SECRET!,
              },
            }).catch(err => {
              console.error(`[parse-pdf] Fire-and-forget deep extraction job ${job.id} failed:`, err)
            })
          } else if (insertError) {
            console.error('[parse-pdf] Failed to auto-queue deep extraction job:', insertError.message)
          }
        }
      } catch (err) {
        console.error('[parse-pdf] Error auto-queuing deep extraction:', err instanceof Error ? err.message : String(err))
      }
    }

    return NextResponse.json({
      success: true,
      doors,
      sets: hardwareSets,
      flaggedDoors: [],
      stats,
      reviewNotes: corrections.notes,
      darrinObservations,
      darrinQuantityCheck,
      confidence,
      suggest_deep_extraction: suggestDeep,
      extraction_confidence: {
        overall: confidence.overall,
        score: confidence.score,
        suggest_deep_extraction: confidence.suggest_deep_extraction,
        deep_extraction_reasons: confidence.deep_extraction_reasons,
      },
      deep_extraction_auto_queued: deepExtractionAutoQueued,
    })
  } catch (error) {
    console.error('Parse PDF error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
