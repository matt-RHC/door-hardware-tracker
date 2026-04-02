import { NextRequest } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
// pdf-parse removed — requires DOMMatrix (browser-only) which crashes in serverless

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

function parseContextLimitError(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err)
  // Match: "input length and `max_tokens` exceed context limit: 185135 + 32768 > 200000"
  const match = msg.match(/input length.*?(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/)
  if (match) {
    return parseInt(match[1], 10) // return the input token count
  }
  // Also check for generic context length errors
  if (msg.includes('context_length') || msg.includes('exceed context limit')) {
    return -1 // unknown input length, but it is a context error
  }
  return null
}

async function callClaude(
  client: Anthropic,
  base64: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 16384
): Promise<{ text: string; truncated: boolean }> {
  try {
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
  } catch (err) {
    const inputTokens = parseContextLimitError(err)
    if (inputTokens !== null && inputTokens > 0) {
      // Retry with reduced max_tokens that fits within the 200K context limit
      const reducedMaxTokens = Math.floor(199000 - inputTokens)
      if (reducedMaxTokens >= 4096) {
        console.log(`Context limit hit (${inputTokens} input tokens). Retrying with max_tokens=${reducedMaxTokens}`)
        const stream = client.messages.stream({
          model: 'claude-sonnet-4-20250514',
          max_tokens: reducedMaxTokens,
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
      } else {
        throw new Error(`PDF is too large to process (${inputTokens} tokens). Maximum supported is ~195,000 tokens.`)
      }
    }
    throw err
  }
}

// Parse compact pipe-delimited hardware set lines into structured data
// Format: SET:ID|Heading
//         qty|name|manufacturer|model|finish
function parseHardwareSetLines(raw: string): HardwareSet[] {
  const sets: HardwareSet[] = []
  let currentSet: HardwareSet | null = null

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) continue

    // Check for set header: SET:DH1|Interior Single Door
    if (trimmed.startsWith('SET:')) {
      const headerParts = trimmed.substring(4).split('|').map(p => p.trim())
      if (headerParts[0]) {
        currentSet = {
          set_id: headerParts[0],
          heading: headerParts[1] || '',
          items: [],
        }
        sets.push(currentSet)
      }
      continue
    }

    // Otherwise it's an item line: qty|name|manufacturer|model|finish
    if (currentSet) {
      const parts = trimmed.split('|').map(p => p.trim())
      if (parts.length >= 2) {
        const qty = parseInt(parts[0], 10)
        currentSet.items.push({
          qty: isNaN(qty) ? 1 : qty,
          name: parts[1] || '',
          manufacturer: parts[2] || '',
          model: parts[3] || '',
          finish: parts[4] || '',
        })
      }
    }
  }

  return sets
}

function parseDoorLines(raw: string): DoorEntry[] {
  const doors: DoorEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('door_number') || trimmed.startsWith('---') || trimmed.startsWith('#')) {
      continue // skip headers and blanks
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

// --- Main handler (streaming progress) ---

export async function POST(request: NextRequest) {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      function send(progress: number, status: string, error?: string, result?: Record<string, unknown>) {
        const event = JSON.stringify({ progress, status, error, result })
        controller.enqueue(encoder.encode(event + '\n'))
      }

      try {
        send(2, 'Authenticating...')

        const supabase = await createServerSupabaseClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
          send(0, 'Error', 'You must be signed in to upload')
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

        // ==========================================
        // PASS 1: Extract hardware set definitions
        // Uses compact pipe-delimited format for token efficiency.
        // JSON is ~3-4x more tokens for the same data — with large PDFs
        // that leave <15K output tokens, JSON truncates too badly to parse.
        // ==========================================
        send(8, 'Analyzing hardware sets...')

        const pass1System = `You extract hardware set definitions from door hardware submittals.

A hardware set (e.g. DH1, DH2, EX1, EX3-NR) defines a list of hardware items installed on doors assigned to that set.

Extract EVERY hardware set definition from this document. Return in COMPACT PIPE-DELIMITED format:

SET:DH1|Interior Single Door - Office
3|Hinges|IV|5BB1 HW 4 1/2 x 4 1/2 NRP|626
1|Lockset|SC|ND50PD RHO|626
1|Closer|LCN|4041 DEL|689
SET:DH2|Interior Single Door - Storage
3|Hinges|IV|5BB1 HW 4 1/2 x 4 1/2 NRP|626
1|Passage Set|SC|ND10S RHO|626

Format rules:
- Each set starts with SET:ID|Heading
- Each item line: qty|name|manufacturer|model|finish
- One item per line, no blank lines between items within a set
- No JSON, no markdown, no explanation — just the data lines

CRITICAL RULES FOR QTY:
- The "qty" field must be the quantity PER INDIVIDUAL DOOR/OPENING, NOT the total across all doors.
- For example, a typical single door has 3 hinges, 1 lockset, 1 closer, 1 kick plate, etc.
- If the document shows a total quantity column and a per-opening quantity column, use the PER-OPENING quantity.
- If only a total is shown, divide by the number of openings in that set to get per-opening qty.
- Common per-opening quantities: hinges = 3 or 4, closers = 1, locksets = 1, stops = 1, kick plates = 1, seals = 1 set, silencers = 1 set.

IMPORTANT: Extract ALL hardware sets with ALL items in each.`

        let pass1Data: { hardware_sets: HardwareSet[] } = { hardware_sets: [] }
        try {
          const { text, truncated } = await callClaude(client, base64, pass1System,
            'Extract ALL hardware set definitions from this submittal. Use the compact pipe-delimited format (SET:ID|Heading then qty|name|mfr|model|finish). No JSON.', 32768)

          const parsedSets = parseHardwareSetLines(text)
          console.log(`Pass 1: parsed ${parsedSets.length} hardware sets (truncated: ${truncated})`)

          if (parsedSets.length === 0) {
            send(0, 'Error', 'No hardware sets found in the document. The PDF may not be a hardware submittal.')
            controller.close()
            return
          }

          pass1Data.hardware_sets = parsedSets

          // If truncated, continuation loop — ask for remaining sets
          if (truncated) {
            const MAX_CONTINUATIONS = 5
            let continuations = 0

            while (continuations < MAX_CONTINUATIONS) {
              continuations++
              const lastSetId = pass1Data.hardware_sets[pass1Data.hardware_sets.length - 1].set_id
              const knownSetIds = pass1Data.hardware_sets.map(s => s.set_id).join(', ')

              send(8 + continuations * 5, `Found ${pass1Data.hardware_sets.length} sets so far (last: ${lastSetId}). Fetching more...`)

              const contPrompt = `Continue extracting hardware set definitions. You already extracted these sets: ${knownSetIds}

Extract ONLY the hardware sets that come AFTER "${lastSetId}" in the document. Do NOT re-extract any of the sets listed above.

Use the same compact format:
SET:ID|Heading
qty|name|manufacturer|model|finish

If there are no more hardware sets after "${lastSetId}", respond with just: DONE`

              const { text: contText, truncated: contTruncated } = await callClaude(
                client, base64, pass1System, contPrompt, 32768
              )

              if (contText.trim() === 'DONE') {
                console.log(`Pass 1 continuation ${continuations}: DONE signal received`)
                break
              }

              const moreSets = parseHardwareSetLines(contText)

              if (moreSets.length === 0) {
                console.log(`Pass 1 continuation ${continuations}: no more sets found`)
                break
              }

              // Deduplicate — only add sets we don't already have
              const existingIds = new Set(pass1Data.hardware_sets.map(s => s.set_id))
              const newSets = moreSets.filter(s => !existingIds.has(s.set_id))

              if (newSets.length === 0) {
                console.log(`Pass 1 continuation ${continuations}: all returned sets already known`)
                break
              }

              pass1Data.hardware_sets.push(...newSets)
              console.log(`Pass 1 continuation ${continuations}: added ${newSets.length} new sets (total: ${pass1Data.hardware_sets.length})`)

              if (!contTruncated) break // Got a complete response, we're done
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('Pass 1 failed:', msg)
          send(0, 'Error', `Failed to extract hardware sets: ${msg}`)
          controller.close()
          return
        }

        const setCount = pass1Data.hardware_sets.length
        const totalItems = pass1Data.hardware_sets.reduce((sum, s) => sum + (s.items?.length || 0), 0)
        send(35, `Found ${setCount} hardware sets (${totalItems} items). Reading door schedule...`)

        const setMap = new Map<string, HardwareSet>()
        for (const set of pass1Data.hardware_sets) {
          setMap.set(set.set_id, set)
        }

        // ==========================================
        // PASS 2: Extract door schedule (compact)
        // Also uses pipe-delimited format with continuation loop
        // ==========================================
        const setIds = pass1Data.hardware_sets.map((s) => s.set_id).join(', ')

        const pass2System = `You extract door schedules from door hardware submittals.

Extract EVERY door/opening. Return a PIPE-DELIMITED list (one door per line):
door_number|hw_set|location|door_type|frame_type|fire_rating|hand

Example output:
110-01A|DH1|Office 110 from Corridor|WD|HM|20Min|LHR
110-02A|DH4A|Storage from Corridor|HM|HM|45Min|A
1201A|EX3-NR|Exterior Equipment Yard|HM|HM|NR|RHR

Rules:
- One door per line, no blank lines between doors
- hw_set MUST be one of: ${setIds}
- Use empty string if a field is unknown (e.g. 110-01A|DH1|||HM|20Min|)
- Extract EVERY door from ALL pages. Do NOT stop early.
- No headers, no markdown, no explanation — just the data lines.`

        let allDoors: DoorEntry[] = []

        try {
          send(40, 'Extracting door schedule...')
          const { text, truncated } = await callClaude(client, base64, pass2System,
            'List EVERY door from the door schedule. Pipe-delimited, one per line. No headers. Do NOT stop early.', 16384)

          allDoors = parseDoorLines(text)
          send(55, `Found ${allDoors.length} doors${truncated ? ' (partial — fetching more)...' : '.'}`)

          // If truncated, continuation loop (not single-shot)
          if (truncated && allDoors.length > 0) {
            const MAX_DOOR_CONTINUATIONS = 8
            let doorCont = 0

            while (doorCont < MAX_DOOR_CONTINUATIONS) {
              doorCont++
              const lastDoor = allDoors[allDoors.length - 1].door_number

              send(55 + doorCont * 2, `Fetching doors after ${lastDoor}... (${allDoors.length} so far)`)

              const contSystem = `You extract door schedules from door hardware submittals.

Continue extracting doors. The previous extraction stopped at door "${lastDoor}".

Return ONLY doors that come AFTER "${lastDoor}" in the document. Use pipe-delimited format:
door_number|hw_set|location|door_type|frame_type|fire_rating|hand

hw_set must be one of: ${setIds}
No headers, no markdown, just data lines.
If there are no more doors after "${lastDoor}", respond with just: DONE`

              const { text: contText, truncated: contTruncated } = await callClaude(client, base64, contSystem,
                `Continue the door list from after "${lastDoor}". Only doors AFTER that one. Pipe-delimited, one per line.`, 16384)

              if (contText.trim() === 'DONE') {
                console.log(`Pass 2 continuation ${doorCont}: DONE signal received`)
                break
              }

              const moreDoors = parseDoorLines(contText)
              if (moreDoors.length === 0) {
                console.log(`Pass 2 continuation ${doorCont}: no more doors found`)
                break
              }

              // Deduplicate by door_number
              const existingDoors = new Set(allDoors.map(d => d.door_number))
              const newDoors = moreDoors.filter(d => !existingDoors.has(d.door_number))

              if (newDoors.length === 0) {
                console.log(`Pass 2 continuation ${doorCont}: all returned doors already known`)
                break
              }

              allDoors = allDoors.concat(newDoors)
              console.log(`Pass 2 continuation ${doorCont}: added ${newDoors.length} doors (total: ${allDoors.length})`)

              if (!contTruncated) break // Complete response, done
            }

            send(68, `Door schedule complete: ${allDoors.length} doors total.`)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('Pass 2 failed:', msg)
          send(0, 'Error', `Failed to extract door schedule: ${msg}`)
          controller.close()
          return
        }

        if (allDoors.length === 0) {
          send(0, 'Error', 'No doors found in the document. The PDF may not contain a door schedule.')
          controller.close()
          return
        }

        send(70, `Saving ${allDoors.length} doors to database...`)

        // ==========================================
        // COMBINE & BATCH INSERT
        // ==========================================

        // Delete existing openings (cascade deletes children)
        const { error: deleteError } = await (supabase as any)
          .from('openings')
          .delete()
          .eq('project_id', projectId)

        if (deleteError) {
          console.error('Error deleting existing openings:', deleteError)
        }

        // Batch insert all openings at once
        const openingRows = allDoors.map((door) => ({
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

        // Insert in chunks of 200 for efficiency
        const CHUNK_SIZE = 200
        const insertedOpenings: Array<{ id: string; door_number: string; hw_set: string }> = []

        for (let i = 0; i < openingRows.length; i += CHUNK_SIZE) {
          const chunk = openingRows.slice(i, i + CHUNK_SIZE)
          const progress = 70 + Math.round((i / openingRows.length) * 15)
          send(progress, `Saving doors ${i + 1}–${Math.min(i + CHUNK_SIZE, openingRows.length)} of ${openingRows.length}...`)

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

        send(87, `Saved ${insertedOpenings.length} doors. Loading hardware items...`)

        // Build all hardware item rows at once, then batch insert
        // Each opening gets: door(s), frame, then hardware set items
        const allHardwareRows: Array<Record<string, unknown>> = []

        // Build a lookup for door_type and frame_type from allDoors
        const doorInfoMap = new Map<string, { door_type: string; frame_type: string }>()
        for (const door of allDoors) {
          doorInfoMap.set(door.door_number, {
            door_type: door.door_type || '',
            frame_type: door.frame_type || '',
          })
        }

        for (const opening of insertedOpenings) {
          let sortOrder = 0
          const doorInfo = doorInfoMap.get(opening.door_number)

          // Determine if pair (two doors) based on door_type or hw_heading
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
              qty: 1,
              manufacturer: null,
              model: doorInfo?.door_type || null,
              finish: null,
              sort_order: sortOrder++,
            })
            allHardwareRows.push({
              opening_id: opening.id,
              name: `Door (Inactive Leaf)`,
              qty: 1,
              manufacturer: null,
              model: doorInfo?.door_type || null,
              finish: null,
              sort_order: sortOrder++,
            })
          } else {
            allHardwareRows.push({
              opening_id: opening.id,
              name: `Door`,
              qty: 1,
              manufacturer: null,
              model: doorInfo?.door_type || null,
              finish: null,
              sort_order: sortOrder++,
            })
          }

          // Add frame as checkable item
          allHardwareRows.push({
            opening_id: opening.id,
            name: `Frame`,
            qty: 1,
            manufacturer: null,
            model: doorInfo?.frame_type || null,
            finish: null,
            sort_order: sortOrder++,
          })

          // Add hardware set items
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
          const progress = 87 + Math.round((i / allHardwareRows.length) * 10)
          if (i % 400 === 0) {
            send(progress, `Loading hardware items ${i + 1}–${Math.min(i + CHUNK_SIZE, allHardwareRows.length)} of ${allHardwareRows.length}...`)
          }

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
        for (const door of allDoors) {
          if (door.hw_set && !setMap.has(door.hw_set) && !unmatchedSets.includes(door.hw_set)) {
            unmatchedSets.push(door.hw_set)
          }
        }

        if (unmatchedSets.length > 0) {
          console.warn(`Unmatched hardware sets: ${unmatchedSets.join(', ')}`)
        }

        console.log(`PDF parse complete: ${insertedOpenings.length} openings, ${itemsInserted} hardware items`)

        const warnings: string[] = []
        if (unmatchedSets.length > 0) {
          warnings.push(`${unmatchedSets.length} hardware set(s) not found: ${unmatchedSets.join(', ')}`)
        }

        const summary = warnings.length > 0
          ? `Done! ${insertedOpenings.length} doors, ${itemsInserted} items. ⚠ ${warnings.join('; ')}`
          : `Done! ${insertedOpenings.length} doors, ${itemsInserted} hardware items loaded.`

        send(100, summary, undefined, {
          success: true,
          openingsCount: insertedOpenings.length,
          itemsCount: itemsInserted,
          hardwareSets: setCount,
          unmatchedSets: unmatchedSets.length > 0 ? unmatchedSets : undefined,
        })

        // Auto-trigger submittal sync (fire-and-forget)
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
        fetch(`${baseUrl}/api/projects/${projectId}/sync-submittal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }).catch(() => {})
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
