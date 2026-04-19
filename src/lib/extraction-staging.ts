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
  /** Per-opening qty AFTER normalization + any post-write mutation
   *  (pair-leaf hinge split subtracts electric-hinge count on the active
   *  leaf, handing filter, user edits). Authoritative value for the UI. */
  qty?: number
  /** RAW per-set PDF qty at extraction time. Records what the PDF said —
   *  NOT a recomputable derivation of qty. Stays constant across leaf-
   *  split / handing-filter mutations. Use for audit, not math
   *  (qty !== ceil(qty_total/qty_door_count) on pair-leaf or sub-
   *  aggregate cases — see migration 049 for full semantics). */
  qty_total?: number
  /** Divisor Python recommended at extraction time (door or leaf count
   *  depending on qty_convention). May exceed qty_total when Python
   *  detected per-opening qty (no division applied). Same audit-only
   *  caveat as qty_total. */
  qty_door_count?: number
  /** How qty was derived. See NEVER_RENORMALIZE in parse-pdf-helpers.ts
   *  for the terminal values that lock qty from further division. */
  qty_source?: string
  manufacturer?: string
  model?: string
  finish?: string
  options?: string
  sort_order?: number
  leaf_side?: 'active' | 'inactive' | 'shared' | 'both' | null
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

  if (error || !data) throw new Error(`Failed to create extraction run: ${error?.message ?? 'no data returned'}`)
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
    /** Migration 048: per-set + per-opening audit captured at staging-write
     *  time. Used to detect silent opening loss and weak pair-signal tiers
     *  without re-running the extractor. Built by buildOpeningAudit(). */
    openingAudit?: unknown
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
  if (updates.openingAudit !== undefined) row.opening_audit = updates.openingAudit

  const { error } = await supabase
    .from('extraction_runs')
    .update(row)
    .eq('id', runId)

  if (error) throw new Error(`Failed to update extraction run: ${error.message}`)
}

/**
 * Mark extraction_runs rows that have been stuck in 'extracting' for too
 * long as 'failed'. Defends against the case where a Vercel function times
 * out (or the worker crashes) before the orchestrator's catch handler can
 * fire updateExtractionRun({ status: 'failed' }).
 *
 * The job-orchestrator route has maxDuration=800s in vercel.json (~13 min),
 * so any run still in 'extracting' beyond ~30 minutes is definitively
 * stuck — its function instance is long gone.
 *
 * Returns ids and started_at of reaped rows so the caller can log the
 * sweep result. Single round-trip; no per-row work.
 */
export async function reapStuckExtractionRuns(
  supabase: SupabaseClient,
  ageMinutes: number,
): Promise<Array<{ id: string; started_at: string | null }>> {
  const cutoff = new Date(Date.now() - ageMinutes * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('extraction_runs')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: `reaped by stuck-run sweep — extraction did not complete within ${ageMinutes} minutes`,
    })
    .eq('status', 'extracting')
    .lt('started_at', cutoff)
    .select('id, started_at')

  if (error) throw new Error(`Failed to reap stuck extraction runs: ${error.message}`)
  return data ?? []
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

  // Build the full payload: each opening with its matched hardware items
  const payload = openings.map(o => {
    const doorKey = normalizeDoor(o.door_number)
    const hwSet = doorToSetMap.get(doorKey) ?? setMap.get(o.hw_set ?? '')
    const items = (hwSet?.items ?? []).map(item => ({
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
      leaf_side: item.leaf_side ?? null,
    }))

    return {
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
      items,
    }
  })

  const { data, error } = await supabase.rpc('write_staging_data', {
    p_extraction_run_id: runId,
    p_project_id: projectId,
    p_payload: payload,
  })

  if (error) {
    throw new Error(`Failed to write staging data: ${error.message}`)
  }

  if (!data.success) {
    throw new Error(`Failed to write staging data: ${data.error}`)
  }

  return { openingsCount: data.openings_count, itemsCount: data.items_count }
}

// --- Promote ---

export async function promoteExtraction(
  supabase: SupabaseClient,
  runId: string,
  userId: string
): Promise<{
  success: boolean
  openingsPromoted?: number
  itemsPromoted?: number
  added?: number
  updated?: number
  unchanged?: number
  deactivated?: number
  error?: string
  // Populated when merge_extraction rejects the run because some staging
  // openings had zero joined hardware items. See migration 037.
  orphanDoors?: string[]
}> {
  const { data, error } = await supabase.rpc('merge_extraction', {
    p_extraction_run_id: runId,
    p_user_id: userId,
  })

  if (error) {
    return { success: false, error: error.message }
  }

  // migration 037 returns `orphan_doors` as a JSON array of door_number
  // strings when the pre-flight rejects the run. Keep the cast narrow.
  const rawOrphans = (data as { orphan_doors?: unknown }).orphan_doors
  const orphanDoors = Array.isArray(rawOrphans)
    ? rawOrphans.filter((x): x is string => typeof x === 'string')
    : undefined

  return {
    success: data.success,
    // Backwards-compatible: total promoted = added + updated + unchanged
    openingsPromoted: (data.added ?? 0) + (data.updated ?? 0) + (data.unchanged ?? 0),
    itemsPromoted: data.items_promoted,
    added: data.added,
    updated: data.updated,
    unchanged: data.unchanged,
    deactivated: data.deactivated,
    error: data.error,
    orphanDoors,
  }
}

