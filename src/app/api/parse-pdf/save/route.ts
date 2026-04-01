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

// --- Save handler: takes merged parse results, writes to DB ---

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

    // Build set lookup map
    const setMap = new Map<string, HardwareSet>()
    for (const set of hardwareSets) {
      setMap.set(set.set_id, set)
    }

    // Delete existing openings (cascade deletes children)
    const { error: deleteError } = await (supabase as any)
      .from('openings')
      .delete()
      .eq('project_id', projectId)

    if (deleteError) {
      console.error('Error deleting existing openings:', deleteError)
    }

    // Batch insert all openings
    const openingRows = doors.map((door) => ({
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

    const CHUNK_SIZE = 50
    const insertedOpenings: Array<{ id: string; door_number: string; hw_set: string }> = []

    for (let i = 0; i < openingRows.length; i += CHUNK_SIZE) {
      const chunk = openingRows.slice(i, i + CHUNK_SIZE)

      const { data, error } = await (supabase as any)
        .from('openings')
        .insert(chunk as any)
        .select('id, door_number, hw_set')

      if (error) {
        console.error(`Error inserting openings chunk at ${i}:`, error)
      } else if (data) {
        insertedOpenings.push(...data)
      }
    }

    // Build hardware item rows
    const allHardwareRows: Array<Record<string, unknown>> = []

    const doorInfoMap = new Map<string, { door_type: string; frame_type: string }>()
    for (const door of doors) {
      doorInfoMap.set(door.door_number, {
        door_type: door.door_type || '',
        frame_type: door.frame_type || '',
      })
    }

    for (const opening of insertedOpenings) {
      let sortOrder = 0
      const doorInfo = doorInfoMap.get(opening.door_number)

      // Determine if pair
      const hwSet = setMap.get(opening.hw_set)
      const heading = (hwSet?.heading || '').toLowerCase()
      const doorType = (doorInfo?.door_type || '').toLowerCase()
      const isPair = heading.includes('pair') || heading.includes('double') ||
                     doorType.includes('pr') || doorType.includes('pair')

      // Add door(s) as checkable items
      if (isPair) {
        allHardwareRows.push({
          opening_id: opening.id,
          name: `Door (Active Leaf)`,
          qty: 1, manufacturer: null, model: doorInfo?.door_type || null,
          finish: null, sort_order: sortOrder++,
        })
        allHardwareRows.push({
          opening_id: opening.id,
          name: `Door (Inactive Leaf)`,
          qty: 1, manufacturer: null, model: doorInfo?.door_type || null,
          finish: null, sort_order: sortOrder++,
        })
      } else {
        allHardwareRows.push({
          opening_id: opening.id,
          name: `Door`,
          qty: 1, manufacturer: null, model: doorInfo?.door_type || null,
          finish: null, sort_order: sortOrder++,
        })
      }

      // Frame
      allHardwareRows.push({
        opening_id: opening.id,
        name: `Frame`,
        qty: 1, manufacturer: null, model: doorInfo?.frame_type || null,
        finish: null, sort_order: sortOrder++,
      })

      // Hardware set items
      if (hwSet?.items?.length) {
        for (const item of hwSet.items) {
          allHardwareRows.push({
            opening_id: opening.id,
            name: item.name,
            qty: item.qty || 1,
            manufacturer: item.manufacturer || null,
            model: item.model || null,
            finish: item.finish || null,
            sort_order: sortOrder++,
          })
        }
      }
    }

    let itemsInserted = 0
    for (let i = 0; i < allHardwareRows.length; i += CHUNK_SIZE) {
      const chunk = allHardwareRows.slice(i, i + CHUNK_SIZE)

      const { data, error } = await (supabase as any)
        .from('hardware_items')
        .insert(chunk as any)
        .select('id')

      if (error) {
        console.error(`Error inserting hardware items chunk at ${i}:`, error)
      } else if (data) {
        itemsInserted += data.length
      }
    }

    // Check for unmatched sets
    const unmatchedSets: string[] = []
    for (const door of doors) {
      if (door.hw_set && !setMap.has(door.hw_set) && !unmatchedSets.includes(door.hw_set)) {
        unmatchedSets.push(door.hw_set)
      }
    }

    console.log(`Save complete: ${insertedOpenings.length} openings, ${itemsInserted} hardware items`)

    return NextResponse.json({
      success: true,
      openingsCount: insertedOpenings.length,
      itemsCount: itemsInserted,
      hardwareSets: hardwareSets.length,
      unmatchedSets: unmatchedSets.length > 0 ? unmatchedSets : undefined,
    })
  } catch (error) {
    console.error('Save error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
