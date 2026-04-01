import { NextRequest } from 'next/server'
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
            source: { type: 'base64', media_type: 'application/pdf', data: base64 },
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

  let text = textBlock.text.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }
  return text
}

// --- Main handler (streaming progress) ---

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      // Helper to send a progress event to the client
      function send(progress: number, status: string, error?: string, result?: Record<string, unknown>) {
        const event = JSON.stringify({ progress, status, error, result })
        controller.enqueue(encoder.encode(event + '\n'))
      }

      try {
        send(2, 'Authenticating...')

        const supabase = await createServerSupabaseClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
          send(0, 'Unauthorized', 'You must be signed in to upload')
          controller.close()
          return
        }

        const formData = await request.formData()
        const file = formData.get('file') as File
        const projectId = formData.get('projectId') as string

        if (!file || !projectId) {
          send(0, 'Error', 'Missing file or project ID')
          controller.close()
          return
        }
        if (file.type !== 'application/pdf') {
          send(0, 'Error', 'File must be a PDF')
          controller.close()
          return
        }

        send(5, 'Reading PDF...')
        const buffer = await file.arrayBuffer()
        const base64 = Buffer.from(buffer).toString('base64')
        const client = new Anthropic()

        // ============================
        // PASS 1: Extract hardware sets
        // ============================
        send(10, 'Analyzing hardware sets...')

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
        { "qty": 3, "name": "Hinges", "manufacturer": "IV", "model": "5BB1 HW 4 1/2 x 4 1/2 NRP", "finish": "626" }
      ]
    }
  ]
}

IMPORTANT: Extract ALL hardware sets, not just a few. Include every item in each set.`

        let pass1Data: { hardware_sets: HardwareSet[] }
        try {
          const pass1Json = await callClaude(client, base64, pass1System,
            'Extract ALL hardware set definitions from this submittal. Return only valid JSON.')
          pass1Data = JSON.parse(pass1Json)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg === 'TRUNCATED') {
            send(0, 'Error', 'Too many hardware sets — response was truncated')
          } else {
            send(0, 'Error', `Failed to extract hardware sets: ${msg}`)
          }
          controller.close()
          return
        }

        const setCount = pass1Data.hardware_sets.length
        const totalItems = pass1Data.hardware_sets.reduce((sum, s) => sum + (s.items?.length || 0), 0)
        send(40, `Found ${setCount} hardware sets (${totalItems} items). Extracting door schedule...`)

        // Build lookup map
        const setMap = new Map<string, HardwareSet>()
        for (const set of pass1Data.hardware_sets) {
          setMap.set(set.set_id, set)
        }

        // ============================
        // PASS 2: Extract door schedule
        // ============================
        const setIds = pass1Data.hardware_sets.map(s => s.set_id).join(', ')

        const pass2System = `You extract door/opening schedules from door hardware submittals.

The document contains a door schedule or opening index that lists every door and which hardware set it uses.

The hardware sets in this document are: ${setIds}

Extract EVERY door/opening from the schedule. For each door, capture:
- door_number (e.g. "110-01A", "1201A", "ST-1C")
- hw_set (which hardware set it references, must be one of: ${setIds})
- location (room name or description)
- door_type (e.g. "WD", "HM", "AL")
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

        let pass2Data: { doors: DoorEntry[] }
        try {
          const pass2Json = await callClaude(client, base64, pass2System,
            'Extract EVERY door/opening from the door schedule in this document. Include ALL doors from ALL pages. Return only valid JSON.')
          pass2Data = JSON.parse(pass2Json)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg === 'TRUNCATED') {
            send(0, 'Error', 'Too many doors — response was truncated')
          } else {
            send(0, 'Error', `Failed to extract door schedule: ${msg}`)
          }
          controller.close()
          return
        }

        const doorCount = pass2Data.doors.length
        send(70, `Found ${doorCount} doors. Saving to database...`)

        // ============================
        // COMBINE & INSERT
        // ============================

        // Delete existing openings (cascade deletes children)
        const { error: deleteError } = await (supabase as any)
          .from('openings')
          .delete()
          .eq('project_id', projectId)

        if (deleteError) {
          console.error('Error deleting existing openings:', deleteError)
        }

        let openingsCount = 0
        let itemsCount = 0
        const unmatchedSets: string[] = []

        for (let i = 0; i < pass2Data.doors.length; i++) {
          const door = pass2Data.doors[i]

          // Progress: 70-95% spread across door inserts
          const insertProgress = 70 + Math.round((i / pass2Data.doors.length) * 25)
          if (i % 5 === 0) {
            send(insertProgress, `Saving door ${i + 1} of ${doorCount}...`)
          }

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
          console.warn(`Unmatched hardware sets: ${unmatchedSets.join(', ')}`)
        }

        console.log(`PDF parse complete: ${openingsCount} openings, ${itemsCount} hardware items`)

        const summary = unmatchedSets.length > 0
          ? `Done! ${openingsCount} doors, ${itemsCount} hardware items. Warning: ${unmatchedSets.length} unmatched set(s).`
          : `Done! ${openingsCount} doors, ${itemsCount} hardware items loaded.`

        send(100, summary, undefined, {
          success: true,
          openingsCount,
          itemsCount,
          hardwareSets: setCount,
          unmatchedSets: unmatchedSets.length > 0 ? unmatchedSets : undefined,
        })
      } catch (error) {
        console.error('PDF parsing error:', error)
        const message = error instanceof Error ? error.message : 'Internal server error'
        const event = JSON.stringify({ progress: 0, status: 'Error', error: message })
        controller.enqueue(encoder.encode(event + '\n'))
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    },
  })
}
