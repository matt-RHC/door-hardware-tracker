import { NextRequest } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
import { getTaxonomyPromptText } from '@/lib/hardware-taxonomy'

// Vercel Fluid Compute: 300s timeout (Pro plan supports up to 800s)
export const maxDuration = 300

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

interface PdfplumberResult {
  success: boolean
  openings: DoorEntry[]
  hardware_sets: Array<{
    set_id: string
    heading: string
    items: Array<{
      qty: number
      name: string
      manufacturer: string
      model: string
      finish: string
    }>
  }>
  reference_codes: Array<{
    code_type: string
    code: string
    full_name: string
  }>
  expected_door_count: number
  tables_found: number
  hw_sets_found: number
  method: string
  error: string
  has_text_layer?: boolean
  pages_with_text?: number
  total_pages?: number
}

interface LLMCorrections {
  hardware_sets_corrections?: Array<{
    set_id: string
    heading?: string
    items_to_add?: HardwareItem[]
    items_to_remove?: string[]
    items_to_fix?: Array<{ name: string; field: string; old_value: string; new_value: string }>
  }>
  doors_corrections?: Array<{
    door_number: string
    field: string
    old_value: string
    new_value: string
  }>
  missing_doors?: DoorEntry[]
  missing_sets?: Array<{
    set_id: string
    heading: string
    items: HardwareItem[]
  }>
  notes?: string
}

// Full extraction result from LLM (when pdfplumber fails)
interface LLMFullExtraction {
  hardware_sets: Array<{
    set_id: string
    heading: string
    items: HardwareItem[]
  }>
  doors: DoorEntry[]
  notes?: string
}

// --- Helpers ---

async function callPdfplumber(base64: string): Promise<PdfplumberResult> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000')

  const response = await fetch(`${baseUrl}/api/extract-tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pdf_base64: base64 }),
  })

  if (!response.ok) {
    throw new Error(`Pdfplumber extraction failed: ${response.status} ${response.statusText}`)
  }

  return response.json()
}

/**
 * LLM Full Extraction — used when pdfplumber finds nothing (no text layer, image PDF, etc.)
 * This is the high-fidelity cloud OCR path: Claude vision reads the PDF directly.
 */
async function callLLMFullExtraction(
  client: Anthropic,
  base64: string
): Promise<LLMFullExtraction> {
  const systemPrompt = `You are a precision data extractor for door hardware submittal PDFs.

You will receive a PDF document containing a door hardware submittal. Your job is to extract ALL data with maximum accuracy.

Extract TWO things:

1. HARDWARE SETS — Each set has:
   - set_id: The set identifier (e.g. "DH1", "DH2-R", "EX1")
   - heading: Description (e.g. "Interior Single Door - Office")
   - items: Array of hardware items, each with:
     - qty: Quantity PER INDIVIDUAL DOOR (not totals). Typical: hinges=3-4, closers=1, locksets=1
     - name: Item name/description (e.g. "Continuous Hinge", "Lockset", "Door Closer")
     - manufacturer: Manufacturer abbreviation (e.g. "IV", "SC", "LCN")
     - model: Model/catalog number (e.g. "5BB1", "ND50PD RHO", "4041")
     - finish: Finish code (e.g. "626", "652", "689")

2. DOORS (Opening List / Door Schedule) — Each door has:
   - door_number: The opening/door number (e.g. "110-01A", "ST-1A")
   - hw_set: Which hardware set applies (e.g. "DH1")
   - location: Room/area description
   - door_type: Door type code (e.g. "WD", "HM", "AL")
   - frame_type: Frame type code (e.g. "HM", "WD", "AL")
   - fire_rating: Fire rating (e.g. "20Min", "45Min", "90Min", "" for none)
   - hand: Handing (e.g. "LHR", "RHR", "LH", "RH")

Return valid JSON with this EXACT structure:
{
  "hardware_sets": [
    {
      "set_id": "DH1",
      "heading": "Interior Single Door - Office",
      "items": [
        {"qty": 3, "name": "Hinges", "manufacturer": "IV", "model": "5BB1 4.5x4.5", "finish": "626"},
        {"qty": 1, "name": "Lockset", "manufacturer": "SC", "model": "ND50PD RHO", "finish": "626"}
      ]
    }
  ],
  "doors": [
    {"door_number": "110-01A", "hw_set": "DH1", "location": "Office", "door_type": "WD", "frame_type": "HM", "fire_rating": "", "hand": "LHR"}
  ],
  "notes": "Any relevant observations about the extraction"
}

CRITICAL RULES:
- Extract EVERY door/opening you can find. Do not skip any.
- Extract EVERY hardware set definition you can find. Do not skip any.
- qty must be PER INDIVIDUAL DOOR/OPENING (not totals across the project).
- Be precise with model numbers, finish codes, and abbreviations — copy them exactly as shown.
- If a value is unclear or not present, use an empty string "".
- Do NOT hallucinate data. Only extract what you can actually see in the PDF.

${getTaxonomyPromptText()}`

  try {
    // Use streaming to avoid timeout on large PDF document processing
    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 32768,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 },
            },
            {
              type: 'text',
              text: 'Extract all hardware sets and doors from this submittal PDF. Return the complete data as JSON.',
            },
          ],
        },
      ],
    })

    const response = await stream.finalMessage()

    const textBlock = response.content.find((b) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      return { hardware_sets: [], doors: [], notes: 'LLM extraction returned no text' }
    }

    let text = textBlock.text.trim()
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
    }

    return JSON.parse(text) as LLMFullExtraction
  } catch (err) {
    console.error('LLM full extraction failed:', err instanceof Error ? err.message : String(err))
    return { hardware_sets: [], doors: [], notes: `LLM extraction failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function callLLMReview(
  client: Anthropic,
  base64: string,
  pdfplumberResult: PdfplumberResult
): Promise<LLMCorrections> {
  const systemPrompt = `You are a quality reviewer for door hardware submittal PDF extraction.

You will receive:
1. A PDF document (door hardware submittal)
2. Structured data extracted from that PDF by an automated tool (pdfplumber)

Your job is to REVIEW the extracted data against the actual PDF and return ONLY corrections needed. Do NOT re-extract everything — just identify errors and missing data.

Return valid JSON with this structure:
{
  "hardware_sets_corrections": [
    {
      "set_id": "DH1",
      "heading": "corrected heading if wrong",
      "items_to_add": [{"qty": 1, "name": "Missing Item", "manufacturer": "MFR", "model": "MDL", "finish": "FIN"}],
      "items_to_remove": ["Item Name That Shouldnt Be There"],
      "items_to_fix": [{"name": "Item Name", "field": "qty", "old_value": "2", "new_value": "3"}]
    }
  ],
  "doors_corrections": [
    {"door_number": "110-01A", "field": "hw_set", "old_value": "DH1", "new_value": "DH2"}
  ],
  "missing_doors": [
    {"door_number": "110-05A", "hw_set": "DH1", "location": "Office", "door_type": "WD", "frame_type": "HM", "fire_rating": "20Min", "hand": "LHR"}
  ],
  "missing_sets": [
    {"set_id": "DH5", "heading": "Storage Room", "items": [{"qty": 3, "name": "Hinges", "manufacturer": "IV", "model": "5BB1", "finish": "626"}]}
  ],
  "notes": "Optional notes about extraction quality"
}

If the extraction is accurate and complete, return: {"notes": "Extraction looks correct"}

CRITICAL RULES:
- Only report REAL errors you can see in the PDF. Do not hallucinate corrections.
- qty must be PER INDIVIDUAL DOOR/OPENING (not totals). Typical: hinges=3-4, closers=1, locksets=1.
- Focus on: missing items/doors, wrong set assignments, incorrect quantities, misread text.
- Do NOT correct formatting differences (e.g. "HM" vs "Hollow Metal" are both fine).

${getTaxonomyPromptText()}`

  const extractedSummary = JSON.stringify({
    hardware_sets: pdfplumberResult.hardware_sets.map(s => ({
      set_id: s.set_id,
      heading: s.heading,
      item_count: s.items.length,
      items: s.items,
    })),
    doors_count: pdfplumberResult.openings.length,
    doors: pdfplumberResult.openings,
  }, null, 2)

  try {
    // Use streaming to avoid timeout on large PDF document processing
    const stream = await client.messages.stream({
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
            {
              type: 'text',
              text: `Here is the automated extraction result. Review it against the PDF and return corrections as JSON:\n\n${extractedSummary}`,
            },
          ],
        },
      ],
    })

    const response = await stream.finalMessage()

    const textBlock = response.content.find((b) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      return { notes: 'LLM review returned no text' }
    }

    let text = textBlock.text.trim()
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
    }

    return JSON.parse(text) as LLMCorrections
  } catch (err) {
    console.error('LLM review failed:', err instanceof Error ? err.message : String(err))
    return { notes: `LLM review failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

function applyCorrections(
  hardwareSets: HardwareSet[],
  doors: DoorEntry[],
  corrections: LLMCorrections
): { hardwareSets: HardwareSet[]; doors: DoorEntry[] } {
  if (corrections.hardware_sets_corrections) {
    for (const corr of corrections.hardware_sets_corrections) {
      const set = hardwareSets.find(s => s.set_id === corr.set_id)
      if (!set) continue

      if (corr.heading) set.heading = corr.heading

      if (corr.items_to_remove) {
        set.items = set.items.filter(
          item => !corr.items_to_remove!.includes(item.name)
        )
      }

      if (corr.items_to_fix) {
        for (const fix of corr.items_to_fix) {
          const item = set.items.find(i => i.name === fix.name)
          if (item && fix.field in item) {
            const val = fix.new_value
            if (fix.field === 'qty') {
              (item as any)[fix.field] = parseInt(val, 10) || 1
            } else {
              (item as any)[fix.field] = val
            }
          }
        }
      }

      if (corr.items_to_add) {
        for (const newItem of corr.items_to_add) {
          if (!set.items.some(i => i.name === newItem.name)) {
            set.items.push(newItem)
          }
        }
      }
    }
  }

  if (corrections.missing_sets) {
    for (const newSet of corrections.missing_sets) {
      if (!hardwareSets.some(s => s.set_id === newSet.set_id)) {
        hardwareSets.push({
          set_id: newSet.set_id,
          heading: newSet.heading,
          items: newSet.items,
        })
      }
    }
  }

  if (corrections.doors_corrections) {
    for (const corr of corrections.doors_corrections) {
      const door = doors.find(d => d.door_number === corr.door_number)
      if (door && corr.field in door) {
        (door as any)[corr.field] = corr.new_value
      }
    }
  }

  if (corrections.missing_doors) {
    for (const newDoor of corrections.missing_doors) {
      if (!doors.some(d => d.door_number === newDoor.door_number)) {
        doors.push(newDoor)
      }
    }
  }

  return { hardwareSets, doors }
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
        // STEP 1: Pdfplumber deterministic extraction
        // ==========================================
        send(8, 'Extracting tables (deterministic)...')

        let pdfplumberResult: PdfplumberResult | null = null
        let pdfplumberWorked = false

        try {
          pdfplumberResult = await callPdfplumber(base64)
          // Require DOORS found, not just sets. Sets-only means door schedule wasn't parsed.
          pdfplumberWorked = pdfplumberResult.openings.length > 0
          console.log(
            `Pdfplumber: ${pdfplumberResult.hw_sets_found} sets, ` +
            `${pdfplumberResult.openings.length} doors, ` +
            `text_layer=${pdfplumberResult.has_text_layer ?? 'unknown'}, ` +
            `pages_with_text=${pdfplumberResult.pages_with_text ?? '?'}/${pdfplumberResult.total_pages ?? '?'}`
          )

          if (pdfplumberWorked) {
            send(30, `Found ${pdfplumberResult.hw_sets_found} hardware sets, ${pdfplumberResult.openings.length} doors. Running quality review...`)
          } else {
            send(15, 'Table extraction found no data. Switching to AI vision extraction...')
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('Pdfplumber extraction failed:', msg)
          send(15, `Table extraction failed (${msg}). Switching to AI vision extraction...`)
        }

        let hardwareSets: HardwareSet[] = []
        let allDoors: DoorEntry[] = []
        let reviewNotes = ''

        if (pdfplumberWorked && pdfplumberResult) {
          // ==========================================
          // PATH A: Pdfplumber found data → LLM review for corrections
          // ==========================================
          hardwareSets = (pdfplumberResult.hardware_sets || []).map(s => ({
            set_id: s.set_id,
            heading: s.heading,
            items: s.items.map(i => ({
              qty: i.qty,
              name: i.name,
              manufacturer: i.manufacturer,
              model: i.model,
              finish: i.finish,
            })),
          }))
          allDoors = pdfplumberResult.openings || []

          send(35, 'Running AI quality review...')
          const corrections = await callLLMReview(client, base64, pdfplumberResult)
          const corrected = applyCorrections(hardwareSets, allDoors, corrections)
          hardwareSets = corrected.hardwareSets
          allDoors = corrected.doors
          reviewNotes = corrections.notes || ''
        } else {
          // ==========================================
          // PATH B: Pdfplumber failed → LLM full extraction (cloud OCR via vision)
          // This is the highest fidelity path for image-based / scanned PDFs
          // ==========================================
          send(20, 'Running AI vision extraction (reading PDF directly)...')

          const fullResult = await callLLMFullExtraction(client, base64)

          hardwareSets = (fullResult.hardware_sets || []).map(s => ({
            set_id: s.set_id,
            heading: s.heading,
            items: (s.items || []).map(i => ({
              qty: i.qty || 1,
              name: i.name || '',
              manufacturer: i.manufacturer || '',
              model: i.model || '',
              finish: i.finish || '',
            })),
          }))
          allDoors = fullResult.doors || []
          reviewNotes = fullResult.notes || 'Extracted via AI vision (pdfplumber found no data)'

          console.log(
            `LLM full extraction: ${hardwareSets.length} sets, ${allDoors.length} doors. ` +
            `Notes: ${reviewNotes}`
          )
        }

        const setCount = hardwareSets.length
        const totalItems = hardwareSets.reduce((sum, s) => sum + (s.items?.length || 0), 0)

        console.log(`Final: ${setCount} sets (${totalItems} items), ${allDoors.length} doors`)

        if (setCount === 0) {
          send(0, 'Error', 'No hardware sets found in the document. The PDF may not be a hardware submittal.')
          controller.close()
          return
        }

        if (allDoors.length === 0) {
          send(0, 'Error', 'No doors found in the document. The PDF may not contain a door schedule.')
          controller.close()
          return
        }

        send(55, `Verified: ${setCount} hardware sets (${totalItems} items), ${allDoors.length} doors. Saving to database...`)

        const setMap = new Map<string, HardwareSet>()
        for (const set of hardwareSets) {
          setMap.set(set.set_id, set)
        }

        // ==========================================
        // STEP 3: COMBINE & BATCH INSERT
        // ==========================================

        send(60, `Saving ${allDoors.length} doors to database...`)

        const { error: deleteError } = await (supabase as any)
          .from('openings')
          .delete()
          .eq('project_id', projectId)

        if (deleteError) {
          console.error('Error deleting existing openings:', deleteError)
        }

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

        const CHUNK_SIZE = 200
        const insertedOpenings: Array<{ id: string; door_number: string; hw_set: string }> = []

        for (let i = 0; i < openingRows.length; i += CHUNK_SIZE) {
          const chunk = openingRows.slice(i, i + CHUNK_SIZE)
          const progress = 60 + Math.round((i / openingRows.length) * 15)
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

        send(77, `Saved ${insertedOpenings.length} doors. Loading hardware items...`)

        const allHardwareRows: Array<Record<string, unknown>> = []

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

          const hwSet = setMap.get(opening.hw_set)
          const heading = (hwSet?.heading || '').toLowerCase()
          const doorType = (doorInfo?.door_type || '').toLowerCase()
          const isPair = heading.includes('pair') || heading.includes('double') ||
                         doorType.includes('pr') || doorType.includes('pair')

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

          allHardwareRows.push({
            opening_id: opening.id,
            name: `Frame`,
            qty: 1,
            manufacturer: null,
            model: doorInfo?.frame_type || null,
            finish: null,
            sort_order: sortOrder++,
          })

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
          const progress = 77 + Math.round((i / allHardwareRows.length) * 18)
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
          reviewNotes,
        })

        // Auto-trigger submittal sync (fire-and-forget)
        const syncBaseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
        fetch(`${syncBaseUrl}/api/projects/${projectId}/sync-submittal`, {
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
