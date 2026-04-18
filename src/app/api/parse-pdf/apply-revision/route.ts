import { NextRequest, NextResponse } from 'next/server'
import * as Sentry from '@sentry/nextjs'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import type { DoorEntry, HardwareSet } from '@/lib/types'
import {
  buildPerOpeningItems,
  buildDoorToSetMap,
  normalizeQuantities,
  detectIsPair,
  normalizeDoorNumber,
} from '@/lib/parse-pdf-helpers'
import {
  filterAllItemsByOpeningHand,
  type HandingFilterDrop,
  type OpeningHandRecord,
} from '@/lib/hardware-handing-filter'
import { logActivity } from '@/lib/activity-log'
import { ACTIVITY_ACTIONS } from '@/lib/constants/activity-actions'

// User decisions from the wizard
interface RemovedDecision {
  door_number: string
  existing_id: string
  action: 'keep' | 'delete' // 'keep' leaves it as-is, 'delete' removes it
}

interface ChangedDecision {
  door_number: string
  existing_id: string
  transfer_progress: boolean // true = keep existing progress, false = reset
}

interface ApplyRevisionPayload {
  projectId: string
  hardwareSets: HardwareSet[]
  // Full parsed data for doors that need inserting/updating
  allDoors: DoorEntry[]
  // User decisions
  removed_decisions: RemovedDecision[]
  changed_decisions: ChangedDecision[]
  // Door numbers for doors that are new (to insert)
  new_door_numbers: string[]
  // Door numbers for unchanged doors (no action needed)
  matched_door_numbers: string[]
}

// --- Apply revision based on user decisions ---

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
    }

    const body: ApplyRevisionPayload = await request.json()
    const {
      projectId,
      hardwareSets,
      allDoors,
      removed_decisions,
      changed_decisions,
      new_door_numbers,
    } = body

    if (!projectId) {
      return NextResponse.json({ error: 'Missing projectId' }, { status: 400 })
    }

    // Project membership check (finding #9): verify the authenticated user is
    // a member of projectId before modifying any production data. Auth alone
    // is not sufficient — an authenticated user could supply any projectId.
    const { data: membership, error: memberError } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()
    if (memberError || !membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const setMap = new Map<string, HardwareSet>()
    for (const set of hardwareSets) {
      setMap.set(set.set_id, set)
      if (set.generic_set_id && set.generic_set_id !== set.set_id) {
        setMap.set(set.generic_set_id, set)
      }
    }
    const doorToSetMap = buildDoorToSetMap(hardwareSets)

    // --- Quantity correction ---
    //
    // Revisions don't run through chunk/route.ts's Darrin pipeline the way a
    // fresh upload does, so this is the ONLY normalization pass between the
    // wizard and the DB. Call the authoritative category-aware normalizer
    // from parse-pdf-helpers.ts (per_leaf / per_opening / per_pair / per_frame
    // handling, sub-heading detection, max-qty sanity check, doorsPerSet
    // fallback for older PDFs with missing heading counts).
    //
    // Phase 4 of groovy-tumbling-backus: this used to be a trimmed inline
    // loop that lacked category awareness — revisions normalized differently
    // than fresh extractions. Collapsed to the shared helper so the two
    // flows can't drift.
    normalizeQuantities(hardwareSets, allDoors)

    const doorMap = new Map<string, DoorEntry>()
    for (const door of allDoors) {
      doorMap.set(door.door_number, door)
    }

    const CHUNK_SIZE = 50
    let doorsDeleted = 0
    let doorsUpdated = 0
    let doorsAdded = 0
    let progressTransferred = 0
    let progressReset = 0

    // Handing filter drops aggregated across both buildPerOpeningItems call
    // sites in this handler (CHANGED doors below and NEW doors further down).
    // Parity with save/route.ts and jobs/[id]/run/route.ts — apply-revision
    // writes directly to production, so invariant (j) cannot backstop. See
    // src/lib/hardware-handing-filter.ts.
    const handingDrops: HandingFilterDrop[] = []
    let handingOpeningsWithUnknownHand = 0
    let handingPairOpeningsSkipped = 0

    // ==========================================
    // 1. Handle REMOVED doors
    // ==========================================
    const toDelete = (removed_decisions ?? []).filter(d => d.action === 'delete').map(d => d.existing_id)
    if (toDelete.length > 0) {
      // Delete in chunks
      for (let i = 0; i < toDelete.length; i += CHUNK_SIZE) {
        const chunk = toDelete.slice(i, i + CHUNK_SIZE)
        const { error } = await (supabase as any)
          .from('openings')
          .delete()
          .in('id', chunk)
        if (error) {
          console.error('Error deleting removed openings:', error)
        } else {
          doorsDeleted += chunk.length
        }
      }
    }

    // ==========================================
    // 2. Handle CHANGED doors
    // ==========================================
    for (const decision of changed_decisions ?? []) {
      const parsedDoor = doorMap.get(decision.door_number)
      if (!parsedDoor) continue

      const hwSet = setMap.get(parsedDoor.hw_set)

      // Pair detection for leaf_count: mirror save/route.ts so apply-revision
      // writes the SAME value a fresh extraction would. doorToSetMap is keyed
      // by normalized door number; fall back to the legacy setMap by hw_set.
      // DoorEntry.leaf_count is authoritative when present (the wizard already
      // computed it from pair detection); otherwise recompute via detectIsPair.
      const doorKey = normalizeDoorNumber(parsedDoor.door_number)
      const resolvedSet = doorToSetMap.get(doorKey) ?? setMap.get(parsedDoor.hw_set ?? '')
      const doorInfo = {
        door_type: parsedDoor.door_type || '',
        frame_type: parsedDoor.frame_type || '',
      }
      const resolvedLeafCount =
        parsedDoor.leaf_count ?? (detectIsPair(resolvedSet, doorInfo) ? 2 : 1)

      // Update the opening fields
      const { error: updateError } = await (supabase as any)
        .from('openings')
        .update({
          hw_set: parsedDoor.hw_set || null,
          hw_heading: hwSet?.heading || null,
          location: parsedDoor.location || null,
          door_type: parsedDoor.door_type || null,
          frame_type: parsedDoor.frame_type || null,
          fire_rating: parsedDoor.fire_rating || null,
          hand: parsedDoor.hand || null,
          pdf_page: hwSet?.pdf_page ?? null,
          // Phase 2 (PR-B): persist pair detection on revision path. Omitting
          // this made every updated opening revert to leaf_count=1 (DB default),
          // breaking the per-leaf UI tabs for users who re-extracted onto a
          // pair-laden project. Save/route.ts writes the same field.
          leaf_count: resolvedLeafCount,
        })
        .eq('id', decision.existing_id)

      if (updateError) {
        console.error(`Error updating opening ${decision.door_number}:`, updateError)
        continue
      }

      if (!decision.transfer_progress) {
        // Reset the CHECKLIST WORKFLOW (received → pre_install → installed →
        // qa_qc) but preserve user-classified hardware items.
        //
        // The previous implementation deleted ALL hardware_items plus ALL
        // checklist_progress for the opening, then re-inserted items from
        // the new PDF. That silently destroyed:
        //   - user classifications (install_type = bench/field)
        //   - user edits to qty / model / finish / options
        //   - any manually-added items not present in the new PDF
        //
        // "Reset progress" in the UI means "restart the workflow on this
        // door," not "wipe everything I've edited." Fix: delete only
        // checklist_progress; preserve items the user has touched
        // (install_type set), and refresh only untouched items from the
        // new PDF.

        // 1. Reset the workflow.
        await (supabase as any)
          .from('checklist_progress')
          .delete()
          .eq('opening_id', decision.existing_id)

        // 2. Fetch existing items to decide which to preserve.
        const { data: existingItems } = await (supabase as any)
          .from('hardware_items')
          .select('id, name, install_type')
          .eq('opening_id', decision.existing_id)

        type ExistingRow = { id: string; name: string | null; install_type: string | null }
        const rows: ExistingRow[] = (existingItems ?? []) as ExistingRow[]
        const preserved = rows.filter(r => r.install_type !== null)
        const preservedNames = new Set(
          preserved.map(r => (r.name ?? '').toLowerCase()),
        )
        const toDeleteIds = rows
          .filter(r => r.install_type === null)
          .map(r => r.id)

        // 3. Delete only untouched (un-classified) existing items.
        if (toDeleteIds.length > 0) {
          await (supabase as any)
            .from('hardware_items')
            .delete()
            .in('id', toDeleteIds)
        }

        // 4. Insert fresh items from the new PDF, skipping any whose name
        //    collides with a preserved item (case-insensitive) so the
        //    user's edit wins.
        const doorInfoMap = new Map([[parsedDoor.door_number, {
          door_type: parsedDoor.door_type || '',
          frame_type: parsedDoor.frame_type || '',
        }]])
        const builtItems = buildPerOpeningItems(
          [{ id: decision.existing_id, door_number: parsedDoor.door_number, hw_set: parsedDoor.hw_set ?? null }],
          doorInfoMap,
          setMap,
          doorToSetMap,
        )

        // Handing filter — drop items whose inferred handing contradicts
        // opening.hand on single-leaf openings. Same logic as save/route.ts
        // and jobs/[id]/run/route.ts. fkColumn is 'opening_id' here because
        // apply-revision writes directly to production hardware_items.
        const changedOpeningHandMap: OpeningHandRecord[] = [{
          id: decision.existing_id,
          doorNumber: parsedDoor.door_number,
          hand: parsedDoor.hand ?? null,
          leafCount: resolvedLeafCount,
        }]
        const changedHandingFilter = filterAllItemsByOpeningHand(
          builtItems,
          changedOpeningHandMap,
          'opening_id',
        )
        handingDrops.push(...changedHandingFilter.dropped)
        handingOpeningsWithUnknownHand += changedHandingFilter.openingsWithUnknownHand
        handingPairOpeningsSkipped += changedHandingFilter.pairOpeningsSkipped

        const itemsToInsert = changedHandingFilter.kept.filter(item => {
          const itemName = typeof item.name === 'string' ? item.name : ''
          return !preservedNames.has(itemName.toLowerCase())
        })
        if (itemsToInsert.length > 0) {
          await (supabase as any)
            .from('hardware_items')
            .insert(itemsToInsert)
        }

        progressReset++
      } else {
        progressTransferred++
      }

      doorsUpdated++
    }

    // ==========================================
    // 3. Handle NEW doors
    // ==========================================
    const newDoors = (new_door_numbers ?? []).map(dn => doorMap.get(dn)).filter(Boolean) as DoorEntry[]

    if (newDoors.length > 0) {
      const openingRows = newDoors.map(door => {
        // Pair detection mirrors save/route.ts:170-191 so apply-revision writes
        // the SAME leaf_count a fresh extraction would. See PR-B note above.
        const doorKey = normalizeDoorNumber(door.door_number)
        const resolvedSet = doorToSetMap.get(doorKey) ?? setMap.get(door.hw_set ?? '')
        const doorInfo = {
          door_type: door.door_type || '',
          frame_type: door.frame_type || '',
        }
        const resolvedLeafCount =
          door.leaf_count ?? (detectIsPair(resolvedSet, doorInfo) ? 2 : 1)
        return {
          project_id: projectId,
          door_number: door.door_number,
          hw_set: door.hw_set || null,
          hw_heading: setMap.get(door.hw_set)?.heading || null,
          location: door.location || null,
          door_type: door.door_type || null,
          frame_type: door.frame_type || null,
          fire_rating: door.fire_rating || null,
          hand: door.hand || null,
          pdf_page: setMap.get(door.hw_set)?.pdf_page ?? null,
          // Phase 2 (PR-B): persist pair detection on new-door insert path.
          leaf_count: resolvedLeafCount,
        }
      })

      const insertedOpenings: Array<{ id: string; door_number: string; hw_set: string }> = []

      for (let i = 0; i < openingRows.length; i += CHUNK_SIZE) {
        const chunk = openingRows.slice(i, i + CHUNK_SIZE)
        const { data, error } = await (supabase as any)
          .from('openings')
          .insert(chunk as any)
          .select('id, door_number, hw_set')

        if (error) {
          console.error('Error inserting new openings:', error)
        } else if (data) {
          insertedOpenings.push(...data)
        }
      }

      // Build hardware items for new doors via shared builder
      const newDoorInfoMap = new Map<string, { door_type: string; frame_type: string }>()
      for (const door of newDoors) {
        newDoorInfoMap.set(door.door_number, {
          door_type: door.door_type || '',
          frame_type: door.frame_type || '',
        })
      }
      const builtHardwareRows = buildPerOpeningItems(insertedOpenings, newDoorInfoMap, setMap, doorToSetMap)

      // Handing filter for new-door inserts. Build the opening→hand map by
      // joining insertedOpenings (DB rows with id) to newDoors (payload with
      // hand + leaf_count).
      const newDoorsByNumber = new Map<string, DoorEntry>()
      for (const door of newDoors) newDoorsByNumber.set(door.door_number, door)
      const newOpeningHandMap: OpeningHandRecord[] = insertedOpenings.map(row => {
        const d = newDoorsByNumber.get(row.door_number)
        const resolvedSet = d
          ? (doorToSetMap.get(normalizeDoorNumber(d.door_number)) ?? setMap.get(d.hw_set ?? ''))
          : undefined
        const doorInfo = d ? { door_type: d.door_type || '', frame_type: d.frame_type || '' } : undefined
        const leafCount = d?.leaf_count ?? (d ? (detectIsPair(resolvedSet, doorInfo) ? 2 : 1) : 1)
        return {
          id: row.id,
          doorNumber: row.door_number,
          hand: d?.hand ?? null,
          leafCount,
        }
      })
      const newHandingFilter = filterAllItemsByOpeningHand(
        builtHardwareRows,
        newOpeningHandMap,
        'opening_id',
      )
      handingDrops.push(...newHandingFilter.dropped)
      handingOpeningsWithUnknownHand += newHandingFilter.openingsWithUnknownHand
      handingPairOpeningsSkipped += newHandingFilter.pairOpeningsSkipped
      const allHardwareRows = newHandingFilter.kept

      for (let i = 0; i < allHardwareRows.length; i += CHUNK_SIZE) {
        const chunk = allHardwareRows.slice(i, i + CHUNK_SIZE)
        await (supabase as any)
          .from('hardware_items')
          .insert(chunk as any)
      }

      doorsAdded = insertedOpenings.length
    }

    const summary = {
      doors_deleted: doorsDeleted,
      doors_updated: doorsUpdated,
      doors_added: doorsAdded,
      progress_transferred: progressTransferred,
      progress_reset: progressReset,
      doors_kept: (removed_decisions ?? []).filter(d => d.action === 'keep').length,
    }

    // Audit trail
    await logActivity({
      projectId,
      userId: user.id,
      action: 'extraction_promoted',
      entityType: 'project',
      entityId: projectId,
      details: { revision: true, ...summary },
    })

    // Handing filter audit — fires only when at least one row was dropped
    // across the two buildPerOpeningItems call sites above.
    if (handingDrops.length > 0) {
      Sentry.addBreadcrumb({
        category: 'extraction.apply_revision.handing_filter',
        level: 'info',
        message: 'handing filter drops',
        data: {
          projectId,
          droppedCount: handingDrops.length,
          openingsWithUnknownHand: handingOpeningsWithUnknownHand,
          pairOpeningsSkipped: handingPairOpeningsSkipped,
          sample: handingDrops.slice(0, 10).map(d => ({
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
        userId: user.id,
        action: ACTIVITY_ACTIONS.EXTRACTION_HANDING_FILTER_APPLIED,
        entityType: 'project',
        entityId: projectId,
        details: {
          source: 'apply_revision',
          droppedCount: handingDrops.length,
          openingsWithUnknownHand: handingOpeningsWithUnknownHand,
          pairOpeningsSkipped: handingPairOpeningsSkipped,
          drops: handingDrops.map(d => ({
            door_number: d.doorNumber,
            item_name: d.itemName,
            item_model: d.itemModel,
            item_handing: d.itemHanding,
            opening_hand: d.openingHand,
          })),
        },
      })
    }

    return NextResponse.json({ success: true, summary })
  } catch (error) {
    console.error('Apply revision error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
