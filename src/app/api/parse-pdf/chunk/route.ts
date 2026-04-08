import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
import { extractFireRatings } from '@/lib/fire-rating'
import type {
  DoorEntry,
  HardwareSet,
  PdfplumberFlaggedDoor,
  PunchyQuantityCheck,
  PunchyObservation,
} from '@/lib/types'
import {
  callPdfplumber,
  callPunchyColumnReview,
  callPunchyPostExtraction,
  callPunchyQuantityCheck,
  applyCorrections,
  normalizeQuantities,
  type PdfplumberResult,
} from '@/lib/parse-pdf-helpers'

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
    const { chunkBase64, chunkIndex, totalChunks, knownSetIds, userColumnMapping } = body as {
      chunkBase64: string
      chunkIndex: number
      totalChunks: number
      knownSetIds?: string[]
      userColumnMapping?: Record<string, number> | null
    }

    if (!chunkBase64) {
      return NextResponse.json({ error: 'Missing chunkBase64' }, { status: 400 })
    }

    // ==========================================
    // Step 1: Pdfplumber deterministic extraction
    // ==========================================
    let pdfplumberResult: PdfplumberResult | null = null
    try {
      pdfplumberResult = await callPdfplumber(chunkBase64, userColumnMapping)
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

    // Convert pdfplumber result to our types — Python layer handles qty normalization
    let hardwareSets: HardwareSet[] = (pdfplumberResult?.hardware_sets || []).map(s => ({
      set_id: s.set_id,
      generic_set_id: s.generic_set_id,
      heading: s.heading,
      heading_door_count: s.heading_door_count,
      heading_leaf_count: s.heading_leaf_count,
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
    // Step 2: Punchy Checkpoint 1 — Column Mapping Review
    // (only on first chunk when user provided a mapping)
    // ==========================================
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const punchyObservations: PunchyObservation[] = []

    if (chunkIndex === 0 && userColumnMapping) {
      try {
        const columnReview = await callPunchyColumnReview(client, chunkBase64, userColumnMapping)
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
        console.debug(`Chunk ${chunkIndex + 1}: Punchy column review: ${columnReview.unmapped_fields?.length ?? 0} unmapped fields, ${columnReview.mapping_issues?.length ?? 0} issues`)
      } catch (err) {
        console.error('Punchy column review error:', err instanceof Error ? err.message : String(err))
      }
    }

    // ==========================================
    // Step 3: Punchy Checkpoint 2 — Post-Extraction Review
    // ==========================================
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
    }, knownSetIds)

    // Track Punchy's post-extraction observations
    if (corrections.notes) {
      punchyObservations.push({
        checkpoint: 'post_extraction',
        message: corrections.notes,
        confidence: (corrections.overall_confidence as PunchyObservation['confidence']) ?? 'medium',
      })
    }

    // Apply corrections
    const corrected = applyCorrections(hardwareSets, doors, corrections)
    hardwareSets = corrected.hardwareSets
    doors = corrected.doors

    // Post-Punchy qty re-normalization
    normalizeQuantities(hardwareSets, doors)

    // Extract fire ratings embedded in hw_heading/location fields
    extractFireRatings(doors)

    // ==========================================
    // Step 4: Punchy Checkpoint 3 — Quantity Sanity Check
    // ==========================================
    let quantityCheck: PunchyQuantityCheck | null = null
    try {
      quantityCheck = await callPunchyQuantityCheck(client, chunkBase64, hardwareSets, doors)
      if ((quantityCheck.flags?.length ?? 0) > 0 || (quantityCheck.compliance_issues?.length ?? 0) > 0) {
        punchyObservations.push({
          checkpoint: 'quantity_check',
          message: quantityCheck.notes ?? 'Quantity check complete',
          confidence: (quantityCheck.compliance_issues?.length ?? 0) > 0 ? 'medium' : 'high',
        })
      }
      console.debug(
        `Chunk ${chunkIndex + 1}: Punchy qty check: ${quantityCheck.flags?.length ?? 0} flags, ` +
        `${quantityCheck.compliance_issues?.length ?? 0} compliance issues`
      )
    } catch (err) {
      console.error('Punchy quantity check error:', err instanceof Error ? err.message : String(err))
    }

    console.debug(
      `Chunk ${chunkIndex + 1}/${totalChunks}: Punchy pipeline complete: ` +
      `${hardwareSets.length} sets, ${doors.length} doors, ` +
      `${punchyObservations.length} observations`
    )

    return NextResponse.json({
      chunkIndex,
      hardwareSets,
      doors,
      flaggedDoors,
      reviewNotes: corrections.notes,
      punchyObservations,
      punchyQuantityCheck: quantityCheck,
    })
  } catch (error) {
    console.error('Chunk processing error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
