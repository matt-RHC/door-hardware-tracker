import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createExtractionRun, updateExtractionRun, writeStagingData, promoteExtraction } from '@/lib/extraction-staging'
import type { StagingOpening } from '@/lib/extraction-staging'
import type { DoorEntry, HardwareSet } from '@/lib/types'
import { buildPerOpeningItems, buildDoorToSetMap } from '@/lib/parse-pdf-helpers'

// --- Shared: check for unmatched sets ---
//
// Doors with `by_others === true` are intentionally unassigned (hardware
// is provided by a different contractor) and their `hw_set` is typically
// a sentinel like "N/A". Skipping them here prevents the save endpoint
// from emitting noise in the `unmatchedSets` warning list and keeps the
// server-side logic consistent with the client-side StepConfirm
// validation (which uses findDoorsWithUnmatchedSets).
function findUnmatchedSets(doors: DoorEntry[], setMap: Map<string, HardwareSet>): string[] {
  const unmatched: string[] = []
  for (const door of doors) {
    if (door.by_others) continue
    if (door.hw_set && !setMap.has(door.hw_set) && !unmatched.includes(door.hw_set)) {
      unmatched.push(door.hw_set)
    }
  }
  return unmatched
}

// --- Save handler: takes merged parse results, writes to DB ---

const CHUNK_SIZE = 50

export async function POST(request: NextRequest) {
  try {
    // Auth check
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
    }

    const body = await request.json()
    const { projectId, hardwareSets, doors } = body as {
      projectId: string
      hardwareSets: HardwareSet[]
      doors: DoorEntry[]
    }

    if (!projectId || !doors || doors.length === 0) {
      return NextResponse.json({ error: 'Missing projectId or doors' }, { status: 400 })
    }

    // Build set lookup map — register under BOTH set_id and generic_set_id
    // because doors may be assigned to either (e.g., heading "DH1.01" vs set "DH1-10")
    const setMap = new Map<string, HardwareSet>()
    for (const set of hardwareSets) {
      setMap.set(set.set_id, set)
      if (set.generic_set_id && set.generic_set_id !== set.set_id) {
        setMap.set(set.generic_set_id, set)
      }
    }
    // Door-number → specific sub-set map (handles multi-heading sub-sets
    // like DH4A.0 vs DH4A.1 that share a generic_set_id)
    const doorToSetMap = buildDoorToSetMap(hardwareSets)

    // --- Final qty normalization safety net ---
    // Python does primary normalization. Only re-divide items the LLM may
    // have reverted. Use heading-based counts from Python when available.
    // S-064: Build doorsPerSet fallback from opening list (matches route.ts logic)
    const doorsPerSet = new Map<string, number>()
    for (const door of doors) {
      const setKey = (door.hw_set ?? '').toUpperCase()
      if (setKey) doorsPerSet.set(setKey, (doorsPerSet.get(setKey) ?? 0) + 1)
    }

    // Iterate hardwareSets directly (not setMap) to avoid double-iteration —
    // each set is registered under both set_id and generic_set_id in setMap,
    // which would cause items to be divided twice.
    for (const set of hardwareSets) {
      const setId = set.set_id
      const leafCount = (set.heading_leaf_count ?? 0) > 1 ? (set.heading_leaf_count ?? 0) : 0
      // S-064: Fall back to doorsPerSet when heading_door_count is missing
      const headingDoorCount = (set.heading_door_count ?? 0) > 1 ? (set.heading_door_count ?? 0) : 0
      const doorCount = headingDoorCount > 1
        ? headingDoorCount
        : (doorsPerSet.get((set.generic_set_id ?? set.set_id ?? setId).toUpperCase()) ?? 0)
      if (leafCount <= 1 && doorCount <= 1) continue

      for (const item of set.items ?? []) {
        if (item.qty_source === 'divided' || item.qty_source === 'flagged' || item.qty_source === 'capped') continue
        let divided = false
        if (leafCount > 1 && item.qty >= leafCount) {
          const perLeaf = item.qty / leafCount
          if (Number.isInteger(perLeaf)) {
            console.debug(`[save-qty-norm] ${setId}: "${item.name}" qty ${item.qty} ÷ ${leafCount} leaves = ${perLeaf}`)
            item.qty = perLeaf
            item.qty_source = 'divided'  // prevent re-division downstream
            divided = true
          }
        }
        if (!divided && doorCount > 1 && doorCount !== leafCount && item.qty >= doorCount) {
          const perOpening = item.qty / doorCount
          if (Number.isInteger(perOpening)) {
            console.debug(`[save-qty-norm] ${setId}: "${item.name}" qty ${item.qty} ÷ ${doorCount} openings = ${perOpening}`)
            item.qty = perOpening
            item.qty_source = 'divided'
          }
        }
      }
    }

    // Build doorInfoMap (needed by both staging and production paths)
    const doorInfoMap = new Map<string, { door_type: string; frame_type: string }>()
    for (const door of doors) {
      doorInfoMap.set(door.door_number, {
        door_type: door.door_type || '',
        frame_type: door.frame_type || '',
      })
    }

    // 1. Create extraction run
    const runId = await createExtractionRun(supabase, {
      projectId,
      userId: user.id,
      extractionMethod: 'pdfplumber',
    })

    // 2. Transform doors → StagingOpening[]
    const stagingOpenings: StagingOpening[] = doors.map(d => ({
      door_number: d.door_number,
      hw_set: d.hw_set || undefined,
      location: d.location || undefined,
      door_type: d.door_type || undefined,
      frame_type: d.frame_type || undefined,
      fire_rating: d.fire_rating || undefined,
      hand: d.hand || undefined,
      // Issue #8: carry the set's PDF page through to the staging opening
      // so it lands on openings.pdf_page after promote_extraction().
      pdf_page: setMap.get(d.hw_set ?? '')?.pdf_page ?? null,
      field_confidence: d.field_confidence || undefined,
    }))

    // 3. Write staging openings (empty hardwareSets — items handled separately)
    const stagingResult = await writeStagingData(supabase, runId, projectId, stagingOpenings, [])

    // 4. Query back staging openings to get their IDs for item insertion
    const { data: stagingOpeningRows, error: fetchError } = await (supabase as any)
      .from('staging_openings')
      .select('id, door_number, hw_set')
      .eq('extraction_run_id', runId)

    if (fetchError) {
      throw new Error(`Failed to fetch staging openings: ${fetchError.message}`)
    }

    // 5. Build all items (Door/Frame + set items) via shared helper
    const allItems = buildPerOpeningItems(
      stagingOpeningRows ?? [],
      doorInfoMap,
      setMap,
      doorToSetMap,
      'staging_opening_id',
      { extraction_run_id: runId },
    )

    // 6. Chunk-insert staging hardware items
    let itemsInserted = 0
    for (let i = 0; i < allItems.length; i += CHUNK_SIZE) {
      const chunk = allItems.slice(i, i + CHUNK_SIZE)
      const { data, error } = await (supabase as any)
        .from('staging_hardware_items')
        .insert(chunk as any)
        .select('id')

      if (error) {
        console.error(`Error inserting staging hw items chunk at ${i}:`, error)
      } else if (data) {
        itemsInserted += data.length
      }
    }

    // 7. Update extraction run status to staged
    await updateExtractionRun(supabase, runId, {
      status: 'reviewing',
      doorsExtracted: stagingResult.openingsCount,
      hwSetsExtracted: hardwareSets.length,
      completedAt: new Date().toISOString(),
    })

    const unmatchedSets = findUnmatchedSets(doors, setMap)

    console.log(`Staging save complete: ${stagingResult.openingsCount} openings, ${itemsInserted} items, run=${runId}`)

    // 8. Auto-promote: staging → production in the same request
    const promoteResult = await promoteExtraction(supabase, runId, user.id)

    if (!promoteResult.success) {
      console.error('Auto-promote failed:', promoteResult.error)
      return NextResponse.json({
        success: false,
        error: promoteResult.error ?? 'Promotion to production failed',
        stagingSuccess: true,
        openingsCount: stagingResult.openingsCount,
        itemsCount: itemsInserted,
        hardwareSets: hardwareSets.length,
        unmatchedSets: unmatchedSets.length > 0 ? unmatchedSets : undefined,
        extraction_run_id: runId,
      })
    }

    console.log(`Auto-promote complete: ${promoteResult.openingsPromoted} openings, ${promoteResult.itemsPromoted} items`)

    return NextResponse.json({
      success: true,
      openingsCount: promoteResult.openingsPromoted ?? stagingResult.openingsCount,
      itemsCount: promoteResult.itemsPromoted ?? itemsInserted,
      hardwareSets: hardwareSets.length,
      unmatchedSets: unmatchedSets.length > 0 ? unmatchedSets : undefined,
      extraction_run_id: runId,
      promoted: true,
    })
  } catch (error) {
    console.error('Save error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
