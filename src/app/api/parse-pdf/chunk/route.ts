import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'

// --- Zod Schemas for Structured Outputs ---

const HardwareItemSchema = z.object({
  qty: z.number().describe('Quantity per individual door/opening, NOT total across all doors'),
  name: z.string().describe('Item name (e.g. Hinges, Closer, Lockset, Exit Device)'),
  manufacturer_code: z.string().describe('Manufacturer abbreviation code (e.g. IV, SC, LCN)'),
  model: z.string().describe('Full model number/description'),
  finish_code: z.string().describe('Finish code (e.g. 626, US32D, 689)'),
  options: z.string().describe('Option codes or notes, empty string if none'),
  hand: z.string().describe('LH or RH if specified for this item, empty string if not'),
})

const HardwareSetSchema = z.object({
  hardware_sets: z.array(z.object({
    set_id: z.string().describe('Hardware set identifier (e.g. DH1, DH4A, EX3-NR, I1NS-2A)'),
    heading: z.string().describe('Descriptive heading for this set'),
    items: z.array(HardwareItemSchema),
  })),
})

const DoorScheduleSchema = z.object({
  openings: z.array(z.object({
    door_number: z.string().describe('Door/opening tag number exactly as shown in document'),
    hw_set: z.string().describe('Hardware set ID assigned to this opening'),
    hw_heading: z.string().describe('Hardware heading if different from set_id, empty string otherwise'),
    location: z.string().describe('Location description or Opening Label, empty string if not shown'),
    door_type: z.string().describe('Door type code exactly as shown (e.g. A, B, HM-N1, WD-F)'),
    frame_type: z.string().describe('Frame type code exactly as shown (e.g. F1, F2, HM-F1)'),
    fire_rating: z.string().describe('Fire rating (e.g. 45Min, 90Min, 20Min, NR), empty string if not shown'),
    hand: z.string().describe('Hand (e.g. LH, RH, LHR, RHR, A, B), empty string if not shown'),
  })),
})

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

async function callClaudeStructured<T>(
  client: Anthropic,
  base64: string,
  systemPrompt: string,
  userPrompt: string,
  schema: Parameters<typeof client.messages.create>[0]['output_config'] extends undefined ? never : unknown,
  maxTokens = 16384
): Promise<{ data: T; truncated: boolean }> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
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
    output_config: { format: schema as any },
  })

  const truncated = response.stop_reason === 'max_tokens'
  const textBlock = response.content.find((b) => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text in Claude response')
  }
  const data = JSON.parse(textBlock.text) as T
  return { data, truncated }
}

// --- Chunk handler: processes one PDF chunk, returns JSON (no DB writes) ---

export async function POST(request: NextRequest) {
  try {
    // Auth check
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
    }

    const body = await request.json()
    const { chunkBase64, chunkIndex, totalChunks, knownSetIds } = body as {
      chunkBase64: string
      chunkIndex: number
      totalChunks: number
      knownSetIds?: string[] // optional: set IDs already discovered from prior chunks
    }

    if (!chunkBase64) {
      return NextResponse.json({ error: 'Missing chunkBase64' }, { status: 400 })
    }

    const client = new Anthropic()

    // ==========================================
    // PASS 1: Extract hardware set definitions
    // Uses Structured Outputs with Zod schema
    // ==========================================
    const pass1System = `You extract hardware set definitions from door hardware submittals.

A hardware set (e.g. DH1, DH2, EX1, EX3-NR, I1NS-2A) defines a list of hardware items installed on doors assigned to that set.

Extract EVERY hardware set definition from this document.

CRITICAL RULES FOR QTY:
- The "qty" field must be the quantity PER INDIVIDUAL DOOR/OPENING, NOT the total across all doors.
- For example, a typical single door has 3 hinges, 1 lockset, 1 closer, 1 kick plate, etc.
- If the document shows a total quantity column and a per-opening quantity column, use the PER-OPENING quantity.
- If only a total is shown, divide by the number of openings in that set to get per-opening qty.
- Common per-opening quantities: hinges = 3 or 4, closers = 1, locksets = 1, stops = 1, kick plates = 1, seals = 1 set, silencers = 1 set.

Extract ALL hardware sets with ALL items in each.`

    let hardwareSets: HardwareSet[] = []
    try {
      const { data: pass1Result, truncated } = await callClaudeStructured<z.infer<typeof HardwareSetSchema>>(
        client, chunkBase64, pass1System,
        'Extract ALL hardware set definitions from this section.',
        zodOutputFormat(HardwareSetSchema), 32768)

      if (truncated) {
        console.warn(`Chunk ${chunkIndex + 1}/${totalChunks}: Pass 1 truncated at 32K tokens`)
      }

      hardwareSets = pass1Result.hardware_sets.map(set => ({
        set_id: set.set_id,
        heading: set.heading,
        items: set.items.map(item => ({
          qty: item.qty,
          name: item.name,
          manufacturer: item.manufacturer_code,
          model: item.model,
          finish: item.finish_code,
        })),
      }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`Chunk ${chunkIndex + 1}/${totalChunks}: Pass 1 failed:`, msg)
      // Don't fail the whole chunk — continue with empty sets, doors may still be extractable
    }

    // ==========================================
    // PASS 2: Extract door schedule
    // Uses Structured Outputs with Zod schema
    // ==========================================
    // Combine any set IDs from this chunk with ones from prior chunks
    const localSetIds = hardwareSets.map(s => s.set_id)
    const allSetIds = [...new Set([...localSetIds, ...(knownSetIds || [])])]
    const setIdsStr = allSetIds.length > 0 ? allSetIds.join(', ') : 'unknown'

    const pass2System = `You extract door schedules from door hardware submittals.

Extract EVERY door/opening from the Opening List / Door Schedule in this document section.

For each opening, extract the fields exactly as they appear in the document. Use empty string for any field not present.

Known hardware set IDs in this document: ${setIdsStr}

IMPORTANT: Extract EVERY door from ALL pages in this section. Do NOT stop early.`

    let doors: DoorEntry[] = []
    try {
      const { data: pass2Result, truncated } = await callClaudeStructured<z.infer<typeof DoorScheduleSchema>>(
        client, chunkBase64, pass2System,
        'Extract ALL doors/openings from the door schedule in this section.',
        zodOutputFormat(DoorScheduleSchema), 16384)

      doors = pass2Result.openings.map(d => ({
        door_number: d.door_number,
        hw_set: d.hw_set,
        location: d.location,
        door_type: d.door_type,
        frame_type: d.frame_type,
        fire_rating: d.fire_rating,
        hand: d.hand,
      }))

      // Handle truncation with continuation
      if (truncated && doors.length > 0) {
        const lastDoor = doors[doors.length - 1].door_number
        const contPrompt = `Continue the door list from after "${lastDoor}". Only doors AFTER that one.`

        const { data: contData } = await callClaudeStructured<z.infer<typeof DoorScheduleSchema>>(
          client, chunkBase64, pass2System, contPrompt,
          zodOutputFormat(DoorScheduleSchema), 16384)

        const moreDoors = contData.openings.map(d => ({
          door_number: d.door_number,
          hw_set: d.hw_set,
          location: d.location,
          door_type: d.door_type,
          frame_type: d.frame_type,
          fire_rating: d.fire_rating,
          hand: d.hand,
        }))

        if (moreDoors.length > 0) {
          doors = doors.concat(moreDoors)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`Chunk ${chunkIndex + 1}/${totalChunks}: Pass 2 failed:`, msg)
    }

    console.log(`Chunk ${chunkIndex + 1}/${totalChunks}: ${hardwareSets.length} sets, ${doors.length} doors`)

    return NextResponse.json({
      chunkIndex,
      hardwareSets,
      doors,
    })
  } catch (error) {
    console.error('Chunk processing error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
