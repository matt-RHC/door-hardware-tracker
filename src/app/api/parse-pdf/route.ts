import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { extractFireRatings } from '@/lib/fire-rating'
import { fetchProjectPdfBase64 } from '@/lib/pdf-storage'
import type {
  DoorEntry,
  HardwareSet,
  PunchyCorrections,
  PunchyQuantityCheck,
  PunchyObservation,
} from '@/lib/types'
import { toPunchyConfidence } from '@/lib/types'
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

// Vercel Fluid Compute: 800s timeout (Pro plan max)
export const maxDuration = 800

// --- Core extraction logic (non-chunked flow orchestrator) ---

/**
 * Shape of the optional user-confirmed golden sample threaded through to
 * Punchy's post-extraction review (CP2) and quantity check (CP3) so the
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
): Promise<{
  hardwareSets: HardwareSet[]
  doors: DoorEntry[]
  corrections: PunchyCorrections
  punchyObservations: PunchyObservation[]
  punchyQuantityCheck: PunchyQuantityCheck | null
  stats: { tables_found: number; hw_sets_found: number; method: string }
}> {
  let pdfplumberResult: PdfplumberResult | null = null
  try {
    pdfplumberResult = await callPdfplumber(base64, userColumnMapping)
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
  const punchyObservations: PunchyObservation[] = []

  // Use filtered PDF for Punchy review if available (fewer pages = cheaper + faster)
  const reviewPdf = filteredPdfBase64 ?? base64

  // ==========================================
  // Punchy Checkpoint 1: Column Mapping Review
  // ==========================================
  if (userColumnMapping) {
    try {
      const columnReview = await callPunchyColumnReview(client, reviewPdf, userColumnMapping, { projectId })
      if ((columnReview.unmapped_fields?.length ?? 0) > 0 || (columnReview.mapping_issues?.length ?? 0) > 0) {
        punchyObservations.push({
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
      console.debug(`Punchy column review: ${columnReview.unmapped_fields?.length ?? 0} unmapped fields, ${columnReview.mapping_issues?.length ?? 0} issues`)
    } catch (err) {
      console.error('Punchy column review error:', err instanceof Error ? err.message : String(err))
    }
  }

  // ==========================================
  // Punchy Checkpoint 2: Post-Extraction Review
  // ==========================================
  // Pass extracted set IDs so Punchy knows the full set context (mirrors chunk route)
  const knownSetIds = (pdfplumberResult?.hardware_sets ?? []).map(s => s.set_id)

  const corrections = await callPunchyPostExtraction(client, reviewPdf, pdfplumberResult ?? {
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
    punchyObservations.push({
      checkpoint: 'post_extraction',
      message: corrections.notes,
      confidence: toPunchyConfidence(corrections.overall_confidence),
    })
  }

  const corrected = applyCorrections(hardwareSets, allDoors, corrections)
  hardwareSets = corrected.hardwareSets
  allDoors = corrected.doors

  // Post-Punchy qty re-normalization
  normalizeQuantities(hardwareSets, allDoors)

  // Extract fire ratings embedded in hw_heading/location fields
  extractFireRatings(allDoors)

  // ==========================================
  // Punchy Checkpoint 3: Quantity Sanity Check
  // ==========================================
  let punchyQuantityCheck: PunchyQuantityCheck | null = null
  try {
    punchyQuantityCheck = await callPunchyQuantityCheck(client, reviewPdf, hardwareSets, allDoors, goldenSample ?? undefined, { projectId })
    if ((punchyQuantityCheck.flags?.length ?? 0) > 0 || (punchyQuantityCheck.compliance_issues?.length ?? 0) > 0) {
      punchyObservations.push({
        checkpoint: 'quantity_check',
        message: punchyQuantityCheck.notes ?? 'Quantity check complete',
        confidence: (punchyQuantityCheck.compliance_issues?.length ?? 0) > 0 ? 'medium' : 'high',
      })
    }
  } catch (err) {
    console.error('Punchy quantity check error:', err instanceof Error ? err.message : String(err))
  }

  return {
    hardwareSets,
    doors: allDoors,
    corrections,
    punchyObservations,
    punchyQuantityCheck,
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
    if (!isServiceRole) {
      const supabase = await createServerSupabaseClient()
      const { data: { user }, error: authError } = await supabase.auth.getUser()
      if (authError || !user) {
        return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
      }
    }

    const body = await request.json()

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
      return NextResponse.json({ error: 'Missing pdfBase64 or projectId' }, { status: 400 })
    }

    // Client may send a filtered PDF (opening list + hardware schedule pages only)
    // for cheaper LLM review. pdfplumber still gets the full PDF.
    const filteredPdfBase64: string | undefined = body.filteredPdfBase64 ?? undefined

    const userColumnMapping = body.userColumnMapping ?? null
    const projectId: string | undefined = body.projectId ?? undefined
    // Optional user-confirmed golden sample — threaded to Punchy CP2/CP3
    // so naming + quantity conventions are treated as the baseline for
    // the submittal. Matches the shape already accepted by deep-extract.
    const goldenSample: GoldenSampleInput = body.goldenSample ?? undefined
    const { hardwareSets, doors, corrections, punchyObservations, punchyQuantityCheck, stats } = await extractFromPDF(base64, filteredPdfBase64, userColumnMapping, projectId, goldenSample)

    return NextResponse.json({
      success: true,
      doors,
      sets: hardwareSets,
      flaggedDoors: [],
      stats,
      reviewNotes: corrections.notes,
      punchyObservations,
      punchyQuantityCheck,
    })
  } catch (error) {
    console.error('Parse PDF error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
