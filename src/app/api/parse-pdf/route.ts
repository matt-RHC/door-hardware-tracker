import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'

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

interface Pass1Result {
  hardware_sets: HardwareSet[]
}

interface Pass2Result {
  doors: DoorEntry[]
}

// --- Helpers ---

async function callClaude(client: Anthropic, base64: string, systemPrompt: string, userPrompt: string): Promise<string> {
  const stream = client.messages.stream({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16384,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64,
            },
          },
          { type: 'text', text: userPrompt },
        ],
      },
    ],
  })

  const response = await stream.finalMessage()

  if (response.stop_reason === 'max_tokens') {
    throw new Error('TRUNCATED')
  }

  const textBlock = response.content.find((b) => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text in Claude response')
  }

  // Strip markdown code fences if present
  let text = textBlock.text.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }
  return text
}

// --- Main handler ---

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const formData = await request.formData()
    const file = formData.get('file') as File
    const projectId = formData.get('projectId') as string

    if (!file || !projectId) {
      return NextResponse.json({ error: 'Missing file or projectId' }, { status: 400 })
    }
    if (file.type !== 'application/pdf') {
      return NextResponse.json({ error: 'File must be a PDF' }, { status: 400 })
    }

    const buffer = await file.arrayBuffer()
    const base64 = Buffer.from(buffer).toString('base64')
    const client = new Anthropic()

    // ============================
    // PASS 1: Extract hardware sets
    // ============================
    console.log('Pass 1: Extracting hardware set definitions...')

    const pass1System = `You extract hardware set definitions from door hardware submittals.

A hardware set (e.g. DH1, DH2, EX1, EX3-NR) defines a list of hardware items that get installed on doors assigned to that set.

Extract EVERY hardware set definition from this document. Each set has:
- A set ID (e.g. "DH1", "DH4A", "EX3-NR")
- A heading/description (e.g. "Interior Single Door - Office")
- A list of hardware items with qty, name, manufacturer, model, and finish

Return valid JSON only:
{
  "hardware_sets": [
    {
      "set_id": "DH1",
      "heading": "Interior Single Door - Office",
      "items": [
        { "qty": 3, "name": "Hinges", "manufacturer": "IV", "model": "5BB1 HW 4 1/2 x 4 1/2 NRP", "finish": "626" },
        { "qty": 1, "name": "Lockset", "manufacturer": "SC", "model": "ND50PD RHO", "finish": "626" }
      ]
    }
  ]
}

IMPORTANT: Extract ALL hardware sets, not just a few. Include every item in each set.`

    let pass1Data: Pass1Result
    try {
      const pass1Json = await callClaude(client, base64, pass1System,
        'Extract ALL hardware set definitions from this submittal. Return only valid JSON.')
      pass1Data = JSON.parse(pass1Json)
      console.log(`Pass 1 complete: ${pass1Data.hardware_sets.length} hardware sets found`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'TRUNCATED') {
        console.error('Pass 1 truncated')
        return NextResponse.json({ error: 'Too many hardware sets - response was truncated' }, { status: 413 })
      }
      console.error('Pass 1 failed:', msg)
      return NextResponse.json({ error: `Failed to extract hardware sets: ${msg}` }, { status: 500 })
    }

    // Build a lookup map: set_id -> HardwareSet
    const setMap = new Map<string, HardwareSet>()
    for (const set of pass1Data.hardware_sets) {
      setMap.set(set.set_id, set)
    }

    // ============================
    // PASS 2: Extract door schedule
    // ============================
    console.log('Pass 2: Extracting door schedule...')

    const setIds = pass1Data.hardware_sets.map(s => s.set_id).join(', ')

    const pass2System = `You extract door/opening schedules from door hardware submittals.

The document contains a door schedule or opening index that lists every door and which hardware set it uses.

The hardware sets in this document are: ${setIds}

Extract EVERY door/opening from the schedule. For each door, capture:
- door_number (e.g. "110-01A", "1201A", "ST-1C")
- hw_set (which hardware set it references, must be one of the sets listed above)
- location (room name or description, e.g. "Corridor 1201" or "Vestibule 1601 from Lobby 1600")
- door_type (e.g. "WD", "HM", "AL", or full description)
- frame_type (e.g. "HM", "AL", "WD")
- fire_rating (e.g. "20Min", "45Min", "90Min", "NR")
- hand (e.g. "A", "LHR", "RHR")

Return valid JSON only:
{
  "doors": [
    {
      "door_number": "110-01A",
      "hw_set": "DH1",
      "location": "Office 110 from Corridor 100",
      "door_type": "WD",
      "frame_type": "HM",
      "fire_rating": "20Min",
      "hand": "LHR"
    }
  ]
}

CRITICAL: Extract EVERY SINGLE door from ALL pages. There may be 30-100+ doors. Do NOT stop early.`

    let pass2Data: Pass2Result
    try {
      const pass2Json = await callClaude(client, base64, pass2System,
        'Extract EVERY door/opening from the door schedule in this document. Include ALL doors from ALL pages. Return only valid JSON.')
      pass2Data = JSON.parse(pass2Json)
      console.log(`Pass 2 complete: ${pass2Data.doors.length} doors found`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'TRUNCATED') {
        console.error('Pass 2 truncated')
        return NextResponse.json({ error: 'Too many doors - response was truncated' }, { status: 413 })
      }
      console.error('Pass 2 failed:', msg)
      return NextResponse.json({ error: `Failed to extract door schedule: ${msg}` }, { status: 500 })
    }

    // ============================
    // COMBINE & INSERT
    // ============================
    console.log(`Combining ${pass2Data.doors.length} doors with ${pass1Data.hardware_sets.length} hardware sets...`)

    // Delete existing openings for this project (cascade deletes children)
    const { error: deleteError } = await (supabase as any)
      .from('openings')
      .delete()
      .eq('project_id', projectId)

    if (deleteError) {
      console.error('Error deleting existing openings:', deleteError)
    }

    let openingsCount = 0
    let itemsCount = 0
    let unmatchedSets: string[] = []

    for (const door of pass2Data.doors) {
      // Insert the opening
      const { data: insertedOpening, error: openingError } = await (supabase as any)
        .from('openings')
        .insert([{
          project_id: projectId,
          door_number: door.door_number,
          hw_set: door.hw_set || null,
          hw_heading: setMap.get(door.hw_set)?.heading || null,
          location: door.location || null,
          door_type: door.door_type || null,
          frame_type: door.frame_type || null,
          fire_rating: door.fire_rating || null,
          hand: door.hand || null,
        }] as any)
        .select()
        .single()

      if (openingError) {
        console.error(`Error inserting opening ${door.door_number}:`, openingError)
        continue
      }

      openingsCount++

      // Look up the hardware set and insert its items
      const hwSet = setMap.get(door.hw_set)
      if (!hwSet || !hwSet.items || hwSet.items.length === 0) {
        if (door.hw_set && !unmatchedSets.includes(door.hw_set)) {
          unmatchedSets.push(door.hw_set)
        }
        continue
      }

      const hardwareInserts = hwSet.items.map((item, index) => ({
        opening_id: insertedOpening.id,
        name: item.name,
        qty: item.qty || 1,
        manufacturer: item.manufacturer || null,
        model: item.model || null,
        finish: item.finish || null,
        sort_order: index,
      }))

      const { error: itemsError, data: insertedItems } = await (supabase as any)
        .from('hardware_items')
        .insert(hardwareInserts as any)
        .select()

      if (!itemsError && insertedItems) {
        itemsCount += insertedItems.length
      } else if (itemsError) {
        console.error(`Error inserting hardware items for ${door.door_number}:`, itemsError)
      }
    }

    if (unmatchedSets.length > 0) {
      console.warn(`Unmatched hardware sets (doors reference these but no definition found): ${unmatchedSets.join(', ')}`)
    }

    console.log(`PDF parse complete: ${openingsCount} openings, ${itemsCount} hardware items inserted`)

    return NextResponse.json({
      success: true,
      openingsCount,
      itemsCount,
      hardwareSets: pass1Data.hardware_sets.length,
      unmatchedSets: unmatchedSets.length > 0 ? unmatchedSets : undefined,
    })
  } catch (error) {
    console.error('PDF parsing error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
