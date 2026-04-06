import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

// --- Types ---

interface ParsedDoor {
  door_number: string
  hw_set: string
  location: string
  door_type: string
  frame_type: string
  fire_rating: string
  hand: string
}

interface ParsedHardwareSet {
  set_id: string
  heading: string
  items: Array<{
    qty: number
    name: string
    model: string
    finish: string
    manufacturer: string
  }>
}

interface ExistingOpening {
  id: string
  door_number: string
  hw_set: string | null
  hw_heading: string | null
  location: string | null
  door_type: string | null
  frame_type: string | null
  fire_rating: string | null
  hand: string | null
  hardware_items: Array<{ id: string; name: string; install_type: string | null }>
  checklist_progress: Array<{ id: string; checked: boolean }>
}

interface FieldChange {
  field: string
  old_value: string | null
  new_value: string | null
}

// --- Helpers ---

function normalizeDoorNumber(dn: string): string {
  return dn
    .trim()
    .toUpperCase()
    .replace(/^0+/, '')         // strip leading zeros
    .replace(/\s+/g, '')        // strip whitespace
    .replace(/O(?=\d)/g, '0')   // common OCR: letter O before digit → zero
    .replace(/(?<=\d)O/g, '0')  // common OCR: letter O after digit → zero
}

// --- Compare: diff new parse results against existing project data ---

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
    }

    const body = await request.json()
    const { projectId, hardwareSets, doors } = body as {
      projectId: string
      hardwareSets: ParsedHardwareSet[]
      doors: ParsedDoor[]
    }

    if (!projectId || !doors) {
      return NextResponse.json({ error: 'Missing projectId or doors' }, { status: 400 })
    }

    // Fetch existing openings with hardware items and progress
    const { data: existing, error: fetchError } = await (supabase as any)
      .from('openings')
      .select(`
        id,
        door_number,
        hw_set,
        hw_heading,
        location,
        door_type,
        frame_type,
        fire_rating,
        hand,
        hardware_items(id, name, install_type),
        checklist_progress(id, checked)
      `)
      .eq('project_id', projectId)
      .order('door_number', { ascending: true })

    if (fetchError) {
      return NextResponse.json({ error: 'Failed to fetch existing openings' }, { status: 500 })
    }

    const existingOpenings = (existing || []) as ExistingOpening[]

    // Build lookup maps with normalized door numbers
    const existingMap = new Map<string, ExistingOpening>()
    for (const op of existingOpenings) {
      existingMap.set(normalizeDoorNumber(op.door_number), op)
    }

    const newMap = new Map<string, ParsedDoor>()
    for (const door of doors) {
      newMap.set(normalizeDoorNumber(door.door_number), door)
    }

    const setMap = new Map<string, ParsedHardwareSet>()
    for (const set of hardwareSets) {
      setMap.set(set.set_id, set)
    }

    // Categorize each door
    const matched: Array<{
      door_number: string
      existing: ExistingOpening
      parsed: ParsedDoor
    }> = []

    const changed: Array<{
      door_number: string
      existing: ExistingOpening
      parsed: ParsedDoor
      changes: FieldChange[]
      hw_set_changed: boolean
      progress_count: { total: number; checked: number }
    }> = []

    const added: ParsedDoor[] = []

    const removed: Array<{
      door_number: string
      existing: ExistingOpening
      progress_count: { total: number; checked: number }
    }> = []

    // Compare fields for each door in the new parse
    for (const door of doors) {
      const normalizedKey = normalizeDoorNumber(door.door_number)
      const ex = existingMap.get(normalizedKey)
      if (!ex) {
        added.push(door)
        continue
      }

      // Check which fields changed
      const fieldChanges: FieldChange[] = []
      const compareFields: Array<{ field: string; oldVal: string | null; newVal: string | null }> = [
        { field: 'hw_set', oldVal: ex.hw_set, newVal: door.hw_set || null },
        { field: 'location', oldVal: ex.location, newVal: door.location || null },
        { field: 'door_type', oldVal: ex.door_type, newVal: door.door_type || null },
        { field: 'frame_type', oldVal: ex.frame_type, newVal: door.frame_type || null },
        { field: 'fire_rating', oldVal: ex.fire_rating, newVal: door.fire_rating || null },
        { field: 'hand', oldVal: ex.hand, newVal: door.hand || null },
      ]

      for (const { field, oldVal, newVal } of compareFields) {
        const o = (oldVal || '').trim().toLowerCase()
        const n = (newVal || '').trim().toLowerCase()

        // Skip if both empty or same
        if (o === n) continue

        // Empty-field protection: if old has value but new is empty/dash,
        // this is likely an extraction failure, not a real change
        const newIsEmpty = !n || n === '-' || n === 'n/a' || n === 'null' || n === 'undefined'
        if (o && newIsEmpty) {
          // Don't flag as changed — keep existing value
          console.debug(`Empty-field protection: ${door.door_number}.${field} keeping "${oldVal}" (new was empty)`)
          continue
        }

        fieldChanges.push({ field, old_value: oldVal, new_value: newVal })
      }

      const progressCount = {
        total: ex.checklist_progress?.length || 0,
        checked: ex.checklist_progress?.filter(cp => cp.checked).length || 0,
      }

      if (fieldChanges.length > 0) {
        changed.push({
          door_number: door.door_number,
          existing: ex,
          parsed: door,
          changes: fieldChanges,
          hw_set_changed: fieldChanges.some(c => c.field === 'hw_set'),
          progress_count: progressCount,
        })
      } else {
        matched.push({
          door_number: door.door_number,
          existing: ex,
          parsed: door,
        })
      }
    }

    // Find removed doors (in existing but not in new parse)
    for (const ex of existingOpenings) {
      if (!newMap.has(normalizeDoorNumber(ex.door_number))) {
        removed.push({
          door_number: ex.door_number,
          existing: ex,
          progress_count: {
            total: ex.checklist_progress?.length || 0,
            checked: ex.checklist_progress?.filter(cp => cp.checked).length || 0,
          },
        })
      }
    }

    return NextResponse.json({
      summary: {
        existing_count: existingOpenings.length,
        new_count: doors.length,
        matched: matched.length,
        changed: changed.length,
        added: added.length,
        removed: removed.length,
      },
      matched: matched.map(m => ({
        door_number: m.door_number,
        hw_set: m.parsed.hw_set,
      })),
      changed: changed.map(c => ({
        door_number: c.door_number,
        existing_id: c.existing.id,
        existing_hw_set: c.existing.hw_set,
        new_hw_set: c.parsed.hw_set,
        changes: c.changes,
        hw_set_changed: c.hw_set_changed,
        progress_count: c.progress_count,
        item_count: c.existing.hardware_items?.length || 0,
      })),
      added: added.map(a => ({
        door_number: a.door_number,
        hw_set: a.hw_set,
        location: a.location,
        door_type: a.door_type,
        frame_type: a.frame_type,
        fire_rating: a.fire_rating,
        hand: a.hand,
      })),
      removed: removed.map(r => ({
        door_number: r.door_number,
        existing_id: r.existing.id,
        hw_set: r.existing.hw_set,
        hw_heading: r.existing.hw_heading,
        progress_count: r.progress_count,
        item_count: r.existing.hardware_items?.length || 0,
      })),
      hardwareSets: hardwareSets.map(s => ({ set_id: s.set_id, heading: s.heading, item_count: s.items.length })),
    })
  } catch (error) {
    console.error('Compare error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
