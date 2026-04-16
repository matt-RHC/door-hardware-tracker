import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { extractFireRatings } from '@/lib/fire-rating'
import type {
  DoorEntry,
  HardwareSet,
  PdfplumberFlaggedDoor,
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

// Vercel Fluid Compute: 800s timeout (Pro plan max)
export const maxDuration = 800

// --- Chunk handler: processes one PDF chunk, returns JSON (no DB writes) ---

export async function POST(request: NextRequest) {
  try {
    // Auth check (service role bypass for testing scripts)
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
    const {
      chunkBase64,
      chunkIndex,
      totalChunks,
      knownSetIds,
      userColumnMapping,
      projectId,
      goldenSample,
    } = body as {
      chunkBase64: string
      chunkIndex: number
      totalChunks: number
      knownSetIds?: string[]
      userColumnMapping?: Record<string, number> | null
      projectId?: string
      // Optional user-confirmed golden sample for Darrin CP2/CP3 baselining.
      // Matches the shape the wizard already sends to /deep-extract.
      goldenSample?: {
        set_id: string
        items: Array<{
          qty: number
          name: string
          manufacturer?: string
          model?: string
          finish?: string
        }>
      }
    }

    if (!chunkBase64) {
      return NextResponse.json({ error: 'Missing chunkBase64' }, { status: 400 })
    }

    // ==========================================
    // Step 1: Pdfplumber deterministic extraction
    // ==========================================
    let pdfplumberResult: PdfplumberResult | null = null
    try {
      pdfplumberResult = await callPdfplumber(chunkBase64, userColumnMapping, new URL(request.url).origin)
      console.debug(
        `Chunk ${chunkIndex + 1}/${totalChunks}: pdfplumber extracted ` +
        `${pdfplumberResult.hw_sets_found} sets, ${pdfplumberResult.openings.length} doors`
      )
    } catch (err) {
      console.error(
        `Chunk ${chunkIndex + 1}/${totalChunks}: pdfplumber failed:`,
        err instanceof Error ? err.message : String(err)
      )
    }

    // Convert pdfplumber result to our types — Python layer handles qty normalization.
    //
    // heading_doors MUST be forwarded — see parse-pdf/route.ts for the full
    // explanation. Dropping this field breaks sub-set door routing and the
    // Verify Sample picker. Mirrors the fix in the non-chunked route.
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
    const flaggedDoors: PdfplumberFlaggedDoor[] = pdfplumberResult?.flagged_doors || []

    // ==========================================
    // Step 2: Darrin Checkpoint 1 — Column Mapping Review
    // (only on first chunk when user provided a mapping)
    // ==========================================
    const client = createAnthropicClient()
    const darrinObservations: DarrinObservation[] = []

    if (chunkIndex === 0 && userColumnMapping) {
      try {
        const columnReview = await callDarrinColumnReview(client, chunkBase64, userColumnMapping, { projectId })
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
        console.debug(`Chunk ${chunkIndex + 1}: Darrin column review: ${columnReview.unmapped_fields?.length ?? 0} unmapped fields, ${columnReview.mapping_issues?.length ?? 0} issues`)
      } catch (err) {
        console.error('Darrin column review error:', err instanceof Error ? err.message : String(err))
      }
    }

    // ==========================================
    // Step 3: Darrin Checkpoint 2 — Post-Extraction Review
    // ==========================================
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
    }, knownSetIds, { projectId, goldenSample })

    // Track Darrin's post-extraction observations
    if (corrections.notes) {
      darrinObservations.push({
        checkpoint: 'post_extraction',
        message: corrections.notes,
        confidence: toDarrinConfidence(corrections.overall_confidence),
      })
    }

    // Apply corrections
    const corrected = applyCorrections(hardwareSets, doors, corrections)
    hardwareSets = corrected.hardwareSets
    doors = corrected.doors

    // Post-Darrin qty re-normalization
    normalizeQuantities(hardwareSets, doors)

    // Extract fire ratings embedded in hw_heading/location fields
    extractFireRatings(doors)

    // ==========================================
    // Step 4: Darrin Checkpoint 3 — Quantity Sanity Check
    // ==========================================
    let quantityCheck: DarrinQuantityCheck | null = null
    try {
      quantityCheck = await callDarrinQuantityCheck(client, chunkBase64, hardwareSets, doors, goldenSample, { projectId })
      if ((quantityCheck.flags?.length ?? 0) > 0 || (quantityCheck.compliance_issues?.length ?? 0) > 0) {
        darrinObservations.push({
          checkpoint: 'quantity_check',
          message: quantityCheck.notes ?? 'Quantity check complete',
          confidence: (quantityCheck.compliance_issues?.length ?? 0) > 0 ? 'medium' : 'high',
        })
      }
      console.debug(
        `Chunk ${chunkIndex + 1}: Darrin qty check: ${quantityCheck.flags?.length ?? 0} flags, ` +
        `${quantityCheck.compliance_issues?.length ?? 0} compliance issues`
      )
    } catch (err) {
      console.error('Darrin quantity check error:', err instanceof Error ? err.message : String(err))
    }

    // ==========================================
    // Step 5: Confidence Scoring
    // ==========================================
    const confidence = calculateExtractionConfidence(hardwareSets, doors, corrections)
    const suggestDeep = shouldAutoTriggerDeepExtraction(confidence)

    console.debug(
      `Chunk ${chunkIndex + 1}/${totalChunks}: Darrin pipeline complete: ` +
      `${hardwareSets.length} sets, ${doors.length} doors, ` +
      `${darrinObservations.length} observations, confidence: ${confidence.score}/100` +
      `${suggestDeep ? ' (deep extraction suggested)' : ''}`
    )

    return NextResponse.json({
      chunkIndex,
      hardwareSets,
      doors,
      flaggedDoors,
      reviewNotes: corrections.notes,
      darrinObservations,
      darrinQuantityCheck: quantityCheck,
      confidence,
      suggest_deep_extraction: suggestDeep,
      extraction_confidence: {
        overall: confidence.overall,
        score: confidence.score,
        suggest_deep_extraction: confidence.suggest_deep_extraction,
        deep_extraction_reasons: confidence.deep_extraction_reasons,
      },
    })
  } catch (error) {
    console.error('Chunk processing error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
