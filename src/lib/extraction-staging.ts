/**
 * Extraction staging client.
 *
 * Provides helpers to:
 * 1. Create extraction runs
 * 2. Write staging data (openings + hardware items)
 * 3. Promote staging → production via the promote_extraction() RPC
 * 4. Track corrections for the feedback loop
 */

import { SupabaseClient } from '@supabase/supabase-js'

// --- Types ---

export type ExtractionStatus =
  | 'pending'
  | 'extracting'
  | 'reviewing'
  | 'promoted'
  | 'rejected'
  | 'failed'
  | 'completed_with_issues'

export type PdfSourceType =
  | 'comsense'
  | 's4h'
  | 'word_excel'
  | 'allegion'
  | 'assa_abloy'
  | 'scanned'
  | 'bluebeam'
  | 'unknown'

export type CorrectionType =
  | 'wrong_value'
  | 'missing_value'
  | 'extra_value'
  | 'wrong_column'
  | 'split_error'
  | 'merge_error'
  | 'formatting'

export interface ExtractionRunInput {
  projectId: string
  userId: string
  pdfStoragePath?: string
  pdfHash?: string
  pdfPageCount?: number
  pdfSourceType?: PdfSourceType
  extractionMethod?: string
}

export interface StagingOpening {
  door_number: string
  hw_set?: string
  hw_heading?: string
  location?: string
  door_type?: string
  frame_type?: string
  fire_rating?: string
  hand?: string
  notes?: string
  /** 0-based PDF page index where this opening's hardware set is defined.
   *  Populated from HardwareSet.pdf_page at save time. Copied to
   *  openings.pdf_page on promote_extraction(). */
  pdf_page?: number | null
  /** Number of door leaves (1 = single, 2 = pair). Computed from
   *  detectIsPair() at save time. Copied to openings.leaf_count on promote. */
  leaf_count?: number
  is_flagged?: boolean
  flag_reason?: string
  field_confidence?: Record<string, number>
}

export interface StagingHardwareItem {
  name: string
  qty?: number
  qty_total?: number
  qty_door_count?: number
  qty_source?: string
  manufacturer?: string
  model?: string
  finish?: string
  options?: string
  sort_order?: number
}

// --- Extraction Run Management ---

export async function createExtractionRun(
  supabase: SupabaseClient,
  input: ExtractionRunInput
): Promise<string> {
  const { data, error } = await supabase
    .from('extraction_runs')
    .insert({
      project_id: input.projectId,
      created_by: input.userId,
      status: 'extracting',
      started_at: new Date().toISOString(),
      pdf_storage_path: input.pdfStoragePath ?? null,
      pdf_hash: input.pdfHash ?? null,
      pdf_page_count: input.pdfPageCount ?? null,
      pdf_source_type: input.pdfSourceType ?? 'unknown',
      extraction_method: input.extractionMethod ?? 'pdfplumber',
    })
    .select('id')
    .single()

  if (error) throw new Error(`Failed to create extraction run: ${error.message}`)
  return data.id
}

export async function updateExtractionRun(
  supabase: SupabaseClient,
  runId: string,
  updates: {
    status?: ExtractionStatus
    confidence?: 'high' | 'medium' | 'low'
    confidenceScore?: number
    doorsExtracted?: number
    doorsFlagged?: number
    hwSetsExtracted?: number
    referenceCodesExtracted?: number
    completedAt?: string
    durationMs?: number
    errorMessage?: string
    extractionNotes?: string[]
  }
): Promise<void> {
  const row: Record<string, unknown> = {}
  if (updates.status !== undefined) row.status = updates.status
  if (updates.confidence !== undefined) row.confidence = updates.confidence
  if (updates.confidenceScore !== undefined) row.confidence_score = updates.confidenceScore
  if (updates.doorsExtracted !== undefined) row.doors_extracted = updates.doorsExtracted
  if (updates.doorsFlagged !== undefined) row.doors_flagged = updates.doorsFlagged
  if (updates.hwSetsExtracted !== undefined) row.hw_sets_extracted = updates.hwSetsExtracted
  if (updates.referenceCodesExtracted !== undefined) row.reference_codes_extracted = updates.referenceCodesExtracted
  if (updates.completedAt !== undefined) row.completed_at = updates.completedAt
  if (updates.durationMs !== undefined) row.duration_ms = updates.durationMs
  if (updates.errorMessage !== undefined) row.error_message = updates.errorMessage
  if (updates.extractionNotes !== undefined) row.extraction_notes = updates.extractionNotes

  const { error } = await supabase
    .from('extraction_runs')
    .update(row)
    .eq('id', runId)

  if (error) throw new Error(`Failed to update extraction run: ${error.message}`)
}

// --- Staging Data ---

export async function writeStagingData(
  supabase: SupabaseClient,
  runId: string,
  projectId: string,
  openings: StagingOpening[],
  hardwareSets: Array<{ set_id: string; generic_set_id?: string; heading: string; heading_doors?: string[]; pdf_page?: number | null; items: StagingHardwareItem[] }>
): Promise<{ openingsCount: number; itemsCount: number }> {
  // Build set lookup — register under BOTH set_id and generic_set_id
  // because doors may be assigned to either (heading "DH1.01" vs set "DH1-10")
  const setMap = new Map<string, typeof hardwareSets[number]>()
  // Door-number lookup for multi-heading sub-sets (DH4A.0 vs DH4A.1)
  const doorToSetMap = new Map<string, typeof hardwareSets[number]>()
  const normalizeDoor = (s: string) => (s ?? '').trim().toUpperCase().replace(/\s+/g, '')
  for (const s of hardwareSets) {
    setMap.set(s.set_id, s)
    for (const dn of s.heading_doors ?? []) {
      const key = normalizeDoor(dn)
      if (key && !doorToSetMap.has(key)) doorToSetMap.set(key, s)
    }
    if (s.generic_set_id && s.generic_set_id !== s.set_id) {
      setMap.set(s.generic_set_id, s)
    }
  }

  // Insert staging openings in chunks
  const CHUNK_SIZE = 50
  const insertedOpenings: Array<{ id: string; door_number: string; hw_set: string | null }> = []

  for (let i = 0; i < openings.length; i += CHUNK_SIZE) {
    const chunk = openings.slice(i, i + CHUNK_SIZE).map(o => ({
      extraction_run_id: runId,
      project_id: projectId,
      door_number: o.door_number,
      hw_set: o.hw_set ?? null,
      hw_heading: o.hw_heading ?? setMap.get(o.hw_set ?? '')?.heading ?? null,
      location: o.location ?? null,
      door_type: o.door_type ?? null,
      frame_type: o.frame_type ?? null,
      fire_rating: o.fire_rating ?? null,
      hand: o.hand ?? null,
      notes: o.notes ?? null,
      pdf_page: o.pdf_page ?? setMap.get(o.hw_set ?? '')?.pdf_page ?? null,
      leaf_count: o.leaf_count ?? 1,
      is_flagged: o.is_flagged ?? false,
      flag_reason: o.flag_reason ?? null,
      field_confidence: o.field_confidence ?? null,
    }))

    const { data, error } = await supabase
      .from('staging_openings')
      .insert(chunk)
      .select('id, door_number, hw_set')

    if (error) {
      console.error(`Error inserting staging openings chunk at ${i}:`, error)
    } else if (data) {
      insertedOpenings.push(...data)
    }
  }

  // Insert staging hardware items
  const allItems: Array<Record<string, unknown>> = []

  for (const opening of insertedOpenings) {
    // Try door-number lookup first (handles multi-heading sub-sets),
    // fall back to hw_set lookup for legacy/single-heading cases.
    const doorKey = normalizeDoor(opening.door_number)
    const hwSet = doorToSetMap.get(doorKey) ?? setMap.get(opening.hw_set ?? '')
    if (!hwSet?.items?.length) continue

    for (const item of hwSet.items) {
      allItems.push({
        staging_opening_id: opening.id,
        extraction_run_id: runId,
        name: item.name,
        qty: item.qty ?? 1,
        qty_total: item.qty_total ?? null,
        qty_door_count: item.qty_door_count ?? null,
        qty_source: item.qty_source ?? null,
        manufacturer: item.manufacturer ?? null,
        model: item.model ?? null,
        finish: item.finish ?? null,
        options: item.options ?? null,
        sort_order: item.sort_order ?? 0,
      })
    }
  }

  let itemsInserted = 0
  for (let i = 0; i < allItems.length; i += CHUNK_SIZE) {
    const chunk = allItems.slice(i, i + CHUNK_SIZE)
    const { data, error } = await supabase
      .from('staging_hardware_items')
      .insert(chunk)
      .select('id')

    if (error) {
      console.error(`Error inserting staging hw items chunk at ${i}:`, error)
    } else if (data) {
      itemsInserted += data.length
    }
  }

  return { openingsCount: insertedOpenings.length, itemsCount: itemsInserted }
}

// --- Promote ---

export async function promoteExtraction(
  supabase: SupabaseClient,
  runId: string,
  userId: string
): Promise<{ success: boolean; openingsPromoted?: number; itemsPromoted?: number; error?: string }> {
  const { data, error } = await supabase.rpc('promote_extraction', {
    p_extraction_run_id: runId,
    p_user_id: userId,
  })

  if (error) {
    return { success: false, error: error.message }
  }

  return {
    success: data.success,
    openingsPromoted: data.openings_promoted,
    itemsPromoted: data.items_promoted,
    error: data.error,
  }
}

// --- Corrections ---

export async function recordCorrection(
  supabase: SupabaseClient,
  input: {
    extractionRunId: string
    projectId: string
    doorNumber?: string
    fieldName: string
    originalValue?: string
    correctedValue?: string
    correctionType?: CorrectionType
    userId: string
  }
): Promise<void> {
  const { error } = await supabase
    .from('extraction_corrections')
    .insert({
      extraction_run_id: input.extractionRunId,
      project_id: input.projectId,
      door_number: input.doorNumber ?? null,
      field_name: input.fieldName,
      original_value: input.originalValue ?? null,
      corrected_value: input.correctedValue ?? null,
      correction_type: input.correctionType ?? 'wrong_value',
      corrected_by: input.userId,
    })

  if (error) throw new Error(`Failed to record correction: ${error.message}`)
}
