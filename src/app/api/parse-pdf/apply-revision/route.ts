import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

// --- Types ---

interface HardwareItem {
  qty: number
  name: string
  model: string
  finish: string
  manufacturer: string
}

interface HardwareSet {
  set_id: string
  heading: string
  items: HardwareItem[]
}

interface DoorEntry {
  door_number: string
  hw_set: string
  location: string
  door_type: string
  frame_type: string
  fire_rating: string
  hand: string
}

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

    // --- Quantity correction (same logic as save/route.ts) ---
    const openingCountPerSet = new Map<string, number>()
    for (const door of allDoors) {
      if (door.hw_set) {
        openingCountPerSet.set(door.hw_set, (openingCountPerSet.get(door.hw_set) || 0) + 1)
      }
    }
    for (const [setId, set] of setMap) {
      const numOpenings = openingCountPerSet.get(setId) || 1
      if (numOpenings <= 1) continue
      const allDivisible = set.items.every(
        (item) => item.qty === 1 || item.qty % numOpenings === 0
      )
      const anyInflated = set.items.some((item) => item.qty > numOpenings)
      if (allDivisible && anyInflated) {
        for (const item of set.items) {
          if (item.qty > 1) {
            item.qty = Math.round(item.qty / numOpenings)
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

        // Insert new hardware items
        if (hwSet?.items?.length) {
          const doorInfo = { door_type: parsedDoor.door_type, frame_type: parsedDoor.frame_type }
          const heading = (hwSet.heading || '').toLowerCase()
          const doorType = (doorInfo.door_type || '').toLowerCase()
          const isPair = heading.includes('pair') || heading.includes('double') ||
                         doorType.includes('pr') || doorType.includes('pair')

          const newItems: Array<Record<string, unknown>> = []
          let sortOrder = 0

          // Door(s)
          if (isPair) {
            newItems.push({ opening_id: decision.existing_id, name: 'Door (Active Leaf)', qty: 1, manufacturer: null, model: doorInfo.door_type || null, finish: null, sort_order: sortOrder++ })
            newItems.push({ opening_id: decision.existing_id, name: 'Door (Inactive Leaf)', qty: 1, manufacturer: null, model: doorInfo.door_type || null, finish: null, sort_order: sortOrder++ })
          } else {
            newItems.push({ opening_id: decision.existing_id, name: 'Door', qty: 1, manufacturer: null, model: doorInfo.door_type || null, finish: null, sort_order: sortOrder++ })
          }

          // Frame
          newItems.push({ opening_id: decision.existing_id, name: 'Frame', qty: 1, manufacturer: null, model: doorInfo.frame_type || null, finish: null, sort_order: sortOrder++ })

          // Hardware items
          for (const item of hwSet.items) {
            newItems.push({
              opening_id: decision.existing_id,
              name: item.name, qty: item.qty || 1,
              manufacturer: item.manufacturer || null,
              model: item.model || null,
              finish: item.finish || null,
              sort_order: sortOrder++,
            })
          }

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

      // Insert hardware items for new doors
      const allHardwareRows: Array<Record<string, unknown>> = []

      for (const opening of insertedOpenings) {
        let sortOrder = 0
        const door = doorMap.get(opening.door_number)
        const hwSet = setMap.get(opening.hw_set)
        const heading = (hwSet?.heading || '').toLowerCase()
        const doorType = (door?.door_type || '').toLowerCase()
        const isPair = heading.includes('pair') || heading.includes('double') ||
                       doorType.includes('pr') || doorType.includes('pair')

        if (isPair) {
          allHardwareRows.push({ opening_id: opening.id, name: 'Door (Active Leaf)', qty: 1, manufacturer: null, model: door?.door_type || null, finish: null, sort_order: sortOrder++ })
          allHardwareRows.push({ opening_id: opening.id, name: 'Door (Inactive Leaf)', qty: 1, manufacturer: null, model: door?.door_type || null, finish: null, sort_order: sortOrder++ })
        } else {
          allHardwareRows.push({ opening_id: opening.id, name: 'Door', qty: 1, manufacturer: null, model: door?.door_type || null, finish: null, sort_order: sortOrder++ })
        }

        allHardwareRows.push({ opening_id: opening.id, name: 'Frame', qty: 1, manufacturer: null, model: door?.frame_type || null, finish: null, sort_order: sortOrder++ })

        if (hwSet?.items?.length) {
          for (const item of hwSet.items) {
            allHardwareRows.push({
              opening_id: opening.id,
              name: item.name, qty: item.qty || 1,
              manufacturer: item.manufacturer || null,
              model: item.model || null,
              finish: item.finish || null,
              sort_order: sortOrder++,
            })
          }
        }
      }

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
