import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createExtractionRun, updateExtractionRun, writeStagingData, promoteExtraction } from '@/lib/extraction-staging'
import type { StagingOpening } from '@/lib/extraction-staging'
import type { DoorEntry, HardwareSet } from '@/lib/types'
import { buildPerOpeningItems, buildDoorToSetMap, detectIsPair, normalizeDoorNumber } from '@/lib/parse-pdf-helpers'
import { logActivity } from '@/lib/activity-log'

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

    // Project membership check (finding #9): verify the authenticated user is
    // a member of projectId before writing any staging data. Auth alone is not
    // sufficient — an authenticated user could supply any projectId they know.
    const { data: membership, error: memberError } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()
    if (memberError || !membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
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

    // NOTE (2026-04-13, fix/qty-normalization-pipeline-overhaul):
    //
    // normalizeQuantities() is intentionally NOT called here.
    //
    // CONTEXT: normalizeQuantities() used to be called three times:
    //   1. Inside chunk/route.ts (after Punchy CP2)
    //   2. Inside parse-pdf/route.ts (same)
    //   3. HERE — as a "final safety net"
    //
    // The third call was architecturally wrong. By the time save/route.ts
    // runs, the wizard client has already received the fully-normalized
    // HardwareSets from the chunk pipeline, reviewed them with Punchy CP2+CP3,
    // and the user has made (or approved) any manual edits. The data is final.
    //
    // Calling normalizeQuantities() again here would:
    //   a) Re-divide items that already went through PATH 1-4 (Python-annotated
    //      paths). The NEVER_RENORMALIZE guard catches the ones correctly marked,
    //      but items that fell through to PATH 5 and were divided there do NOT
    //      have a terminal qty_source — they have 'divided', 'flagged', etc.
    //      Those ARE in NEVER_RENORMALIZE, so they're protected.
    //   b) However, any item that somehow arrives here with qty_source='parsed'
    //      or undefined would be re-processed by the TS taxonomy fallback. That
    //      is specifically what we're eliminating: silent double-division.
    //
    // If you are tempted to add a safety net here again: solve it upstream
    // instead (in Python annotation or Punchy CP2 feedback). Do not add a
    // third division pass — the value of having a SINGLE authoritative pass
    // is that bugs are visible and traceable.
    //
    // Build doorInfoMap
    // (moved comment anchor — see normalizeQuantities call removed above)

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
    const stagingOpenings: StagingOpening[] = doors.map(d => {
      // Resolve the hardware set for this door (same lookup chain as buildPerOpeningItems)
      const doorKey = normalizeDoorNumber(d.door_number)
      const hwSet = doorToSetMap.get(doorKey) ?? setMap.get(d.hw_set ?? '')
      const doorInfo = doorInfoMap.get(d.door_number)
      const isPair = detectIsPair(hwSet, doorInfo)
      return {
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
        // Phase 2: persist pair detection so the UI can render per-leaf sections
        leaf_count: isPair ? 2 : 1,
        field_confidence: d.field_confidence || undefined,
      }
    })

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
    const failedItemChunks: Array<{ offset: number; count: number; error: string }> = []
    for (let i = 0; i < allItems.length; i += CHUNK_SIZE) {
      const chunk = allItems.slice(i, i + CHUNK_SIZE)
      const { data, error } = await (supabase as any)
        .from('staging_hardware_items')
        .insert(chunk as any)
        .select('id')

      if (error) {
        console.error(`Error inserting staging hw items chunk at ${i}:`, error)
        failedItemChunks.push({ offset: i, count: chunk.length, error: error.message })
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

    const isPartialSave = failedItemChunks.length > 0
    console.log(`Staging save complete: ${stagingResult.openingsCount} openings, ${itemsInserted} items, run=${runId}${isPartialSave ? ` (${failedItemChunks.length} chunk(s) failed)` : ''}`)

    // 8. Auto-promote: staging → production in the same request
    const promoteResult = await promoteExtraction(supabase, runId, user.id)

    if (!promoteResult.success) {
      console.error('Auto-promote failed:', promoteResult.error)
      return NextResponse.json({
        success: false,
        partial: isPartialSave,
        error: promoteResult.error ?? 'Promotion to production failed',
        stagingSuccess: true,
        openingsCount: stagingResult.openingsCount,
        itemsCount: itemsInserted,
        expectedItemsCount: allItems.length,
        hardwareSets: hardwareSets.length,
        unmatchedSets: unmatchedSets.length > 0 ? unmatchedSets : undefined,
        failedChunks: isPartialSave ? failedItemChunks : undefined,
        extraction_run_id: runId,
      })
    }

    console.log(`Auto-promote complete: ${promoteResult.openingsPromoted} openings, ${promoteResult.itemsPromoted} items`)

    // Audit trail
    await logActivity({
      projectId,
      userId: user.id,
      action: 'extraction_promoted',
      entityType: 'project',
      entityId: projectId,
      details: {
        extractionRunId: runId,
        openingsPromoted: promoteResult.openingsPromoted,
        itemsPromoted: promoteResult.itemsPromoted,
        hardwareSets: hardwareSets.length,
      },
    })

    return NextResponse.json({
      success: true,
      partial: isPartialSave,
      openingsCount: promoteResult.openingsPromoted ?? stagingResult.openingsCount,
      itemsCount: promoteResult.itemsPromoted ?? itemsInserted,
      expectedItemsCount: allItems.length,
      hardwareSets: hardwareSets.length,
      unmatchedSets: unmatchedSets.length > 0 ? unmatchedSets : undefined,
      failedChunks: isPartialSave ? failedItemChunks : undefined,
      extraction_run_id: runId,
      promoted: true,
    })
  } catch (error) {
    console.error('Save error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
