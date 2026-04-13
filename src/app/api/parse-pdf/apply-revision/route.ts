import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import type { DoorEntry, HardwareSet } from '@/lib/types'
import { buildPerOpeningItems, buildDoorToSetMap, normalizeQuantities } from '@/lib/parse-pdf-helpers'
import { logActivity } from '@/lib/activity-log'

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
    // Revisions don't run through chunk/route.ts's Punchy pipeline the way a
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

    // ==========================================
    // 1. Handle REMOVED doors
    // ==========================================
    const toDelete = removed_decisions.filter(d => d.action === 'delete').map(d => d.existing_id)
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
    for (const decision of changed_decisions) {
      const parsedDoor = doorMap.get(decision.door_number)
      if (!parsedDoor) continue

      const hwSet = setMap.get(parsedDoor.hw_set)

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
        const newItems = buildPerOpeningItems(
          [{ id: decision.existing_id, door_number: parsedDoor.door_number, hw_set: parsedDoor.hw_set ?? null }],
          doorInfoMap,
          setMap,
          doorToSetMap,
        )
        const itemsToInsert = newItems.filter(item => {
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
    const newDoors = new_door_numbers.map(dn => doorMap.get(dn)).filter(Boolean) as DoorEntry[]

    if (newDoors.length > 0) {
      const openingRows = newDoors.map(door => ({
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
      }))

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
      const allHardwareRows = buildPerOpeningItems(insertedOpenings, newDoorInfoMap, setMap, doorToSetMap)

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
      doors_kept: removed_decisions.filter(d => d.action === 'keep').length,
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

    return NextResponse.json({ success: true, summary })
  } catch (error) {
    console.error('Apply revision error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
