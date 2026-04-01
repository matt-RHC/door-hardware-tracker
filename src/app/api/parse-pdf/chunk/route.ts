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

// --- Helpers ---

async function callClaude(
  client: Anthropic,
  base64: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 16384
): Promise<{ text: string; truncated: boolean }> {
  const stream = client.messages.stream({
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
  })

  const response = await stream.finalMessage()
  const truncated = response.stop_reason === 'max_tokens'

  const textBlock = response.content.find((b) => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text in Claude response')
  }

  let text = textBlock.text.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
  }
  return { text, truncated }
}

function parseDoorLines(raw: string): DoorEntry[] {
  const doors: DoorEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('door_number') || trimmed.startsWith('---') || trimmed.startsWith('#')) {
      continue
    }
    const parts = trimmed.split('|').map((p) => p.trim())
    if (parts.length >= 2) {
      doors.push({
        door_number: parts[0] || '',
        hw_set: parts[1] || '',
        location: parts[2] || '',
        door_type: parts[3] || '',
        frame_type: parts[4] || '',
        fire_rating: parts[5] || '',
        hand: parts[6] || '',
      })
    }
  }
  return doors
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
    // ==========================================
    const pass1System = `You extract hardware set definitions from door hardware submittals.

A hardware set (e.g. DH1, DH2, EX1, EX3-NR) defines a list of hardware items installed on doors assigned to that set.

Extract EVERY hardware set definition from this document. Return valid JSON:
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

CRITICAL RULES FOR QTY:
- The "qty" field must be the quantity PER INDIVIDUAL DOOR/OPENING, NOT the total across all doors.
- For example, a typical single door has 3 hinges, 1 lockset, 1 closer, 1 kick plate, etc.
- If the document shows a total quantity column and a per-opening quantity column, use the PER-OPENING quantity.
- If only a total is shown, divide by the number of openings in that set to get per-opening qty.
- Common per-opening quantities: hinges = 3 or 4, closers = 1, locksets = 1, stops = 1, kick plates = 1, seals = 1 set, silencers = 1 set.

If this section of the document contains NO hardware set definitions, return: {"hardware_sets": []}

IMPORTANT: Extract ALL hardware sets with ALL items in each. No markdown, only JSON.`

    let hardwareSets: HardwareSet[] = []
    try {
      const { text, truncated } = await callClaude(client, chunkBase64, pass1System,
        'Extract ALL hardware set definitions from this section. Return only valid JSON. If none found, return {"hardware_sets": []}.', 32768)

      if (truncated) {
        console.warn(`Chunk ${chunkIndex + 1}/${totalChunks}: Pass 1 truncated at 32K tokens`)
      }

      const parsed = JSON.parse(text)
      hardwareSets = parsed.hardware_sets || []
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`Chunk ${chunkIndex + 1}/${totalChunks}: Pass 1 failed:`, msg)
      // Don't fail the whole chunk — continue with empty sets, doors may still be extractable
    }

    // ==========================================
    // PASS 2: Extract door schedule
    // ==========================================
    // Combine any set IDs from this chunk with ones from prior chunks
    const localSetIds = hardwareSets.map(s => s.set_id)
    const allSetIds = [...new Set([...localSetIds, ...(knownSetIds || [])])]
    const setIdsStr = allSetIds.length > 0 ? allSetIds.join(', ') : 'unknown'

    const pass2System = `You extract door schedules from door hardware submittals.

Extract EVERY door/opening from this section. Return a PIPE-DELIMITED list (one door per line):
door_number|hw_set|location|door_type|frame_type|fire_rating|hand

Example output:
110-01A|DH1|Office 110 from Corridor|WD|HM|20Min|LHR
110-02A|DH4A|Storage from Corridor|HM|HM|45Min|A
1201A|EX3-NR|Exterior Equipment Yard|HM|HM|NR|RHR

Rules:
- One door per line, no blank lines between doors
- hw_set should ideally be one of: ${setIdsStr}
- Use empty string if a field is unknown (e.g. 110-01A|DH1|||HM|20Min|)
- Extract EVERY door from ALL pages in this section. Do NOT stop early.
- If this section contains NO door schedule entries, return exactly: NO_DOORS_FOUND
- No headers, no markdown, no explanation — just the data lines.`

    let doors: DoorEntry[] = []
    try {
      const { text, truncated } = await callClaude(client, chunkBase64, pass2System,
        'List EVERY door from the door schedule in this section. Pipe-delimited, one per line. No headers. If none found, return NO_DOORS_FOUND.', 16384)

      if (text.trim() !== 'NO_DOORS_FOUND') {
        doors = parseDoorLines(text)

        // Handle truncation with continuation
        if (truncated && doors.length > 0) {
          const lastDoor = doors[doors.length - 1].door_number
          const contSystem = `You extract door schedules from door hardware submittals.

Continue extracting doors. The previous extraction stopped at door "${lastDoor}".

Return ONLY doors that come AFTER "${lastDoor}" in the document. Use pipe-delimited format:
door_number|hw_set|location|door_type|frame_type|fire_rating|hand

hw_set should be one of: ${setIdsStr}
No headers, no markdown, just data lines.`

          const { text: contText } = await callClaude(client, chunkBase64, contSystem,
            `Continue the door list from after "${lastDoor}". Only doors AFTER that one.`, 16384)

          const moreDoors = parseDoorLines(contText)
          if (moreDoors.length > 0) {
            doors = doors.concat(moreDoors)
          }
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
