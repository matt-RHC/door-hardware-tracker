import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import type { DoorEntry, HardwareSet } from '@/lib/types'
import { buildPerOpeningItems } from '@/lib/parse-pdf-helpers'

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

    const setMap = new Map<string, HardwareSet>()
    for (const set of hardwareSets) {
      setMap.set(set.set_id, set)
    }

    // --- Quantity correction (heading-based, same strategy as save/route.ts) ---
    for (const [setId, set] of setMap) {
      const leafCount = (set.heading_leaf_count ?? 0) > 1 ? (set.heading_leaf_count ?? 0) : 0
      const doorCount = (set.heading_door_count ?? 0) > 1 ? (set.heading_door_count ?? 0) : 0
      if (leafCount <= 1 && doorCount <= 1) continue

      for (const item of set.items) {
        if (item.qty_source === 'divided' || item.qty_source === 'flagged' || item.qty_source === 'capped') continue
        let divided = false
        if (leafCount > 1 && item.qty >= leafCount) {
          const perLeaf = item.qty / leafCount
          if (Number.isInteger(perLeaf)) {
            item.qty = perLeaf
            divided = true
          }
        }
        if (!divided && doorCount > 1 && doorCount !== leafCount && item.qty >= doorCount) {
          const perOpening = item.qty / doorCount
          if (Number.isInteger(perOpening)) {
            item.qty = perOpening
          }
        }
      }
    }

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
        })
        .eq('id', decision.existing_id)

      if (updateError) {
        console.error(`Error updating opening ${decision.door_number}:`, updateError)
        continue
      }

      if (!decision.transfer_progress) {
        // Reset: delete old hardware items and checklist, insert new ones
        await (supabase as any)
          .from('hardware_items')
          .delete()
          .eq('opening_id', decision.existing_id)

        await (supabase as any)
          .from('checklist_progress')
          .delete()
          .eq('opening_id', decision.existing_id)

        // Insert new hardware items via shared builder
        const doorInfoMap = new Map([[parsedDoor.door_number, {
          door_type: parsedDoor.door_type || '',
          frame_type: parsedDoor.frame_type || '',
        }]])
        const newItems = buildPerOpeningItems(
          [{ id: decision.existing_id, door_number: parsedDoor.door_number, hw_set: parsedDoor.hw_set ?? null }],
          doorInfoMap,
          setMap,
        )
        if (newItems.length > 0) {
          await (supabase as any)
            .from('hardware_items')
            .insert(newItems)
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
      const allHardwareRows = buildPerOpeningItems(insertedOpenings, newDoorInfoMap, setMap)

      for (let i = 0; i < allHardwareRows.length; i += CHUNK_SIZE) {
        const chunk = allHardwareRows.slice(i, i + CHUNK_SIZE)
        await (supabase as any)
          .from('hardware_items')
          .insert(chunk as any)
      }

      doorsAdded = insertedOpenings.length
    }

    return NextResponse.json({
      success: true,
      summary: {
        doors_deleted: doorsDeleted,
        doors_updated: doorsUpdated,
        doors_added: doorsAdded,
        progress_transferred: progressTransferred,
        progress_reset: progressReset,
        doors_kept: removed_decisions.filter(d => d.action === 'keep').length,
      },
    })
  } catch (error) {
    console.error('Apply revision error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
