import { NextRequest, NextResponse } from 'next/server'
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

// --- Helpers ---

// Category-aware qty cap: prevents aggregate totals from reaching UI
const QTY_MAX_MAP: Record<string, number> = {
  hinge: 5, continuous: 2, pivot: 2,
  lockset: 1, latch: 1, passage: 1, privacy: 1, storeroom: 1,
  classroom: 1, entrance: 1, mortise: 1, cylindrical: 1, deadbolt: 2,
  exit: 2, panic: 2, 'flush bolt': 2, 'surface bolt': 2,
  closer: 2, coordinator: 1, stop: 2, holder: 2,
  silencer: 4, bumper: 4, threshold: 1, 'kick plate': 2,
  seal: 3, gasket: 3, sweep: 1, 'door bottom': 1,
  astragal: 1, cylinder: 2, core: 2, strike: 2,
  pull: 2, push: 2, lever: 1, knob: 1,
}

function capItemQty(qty: number, name: string): number {
  if (qty <= 0) return 1
  const lower = name.toLowerCase()
  for (const [keyword, max] of Object.entries(QTY_MAX_MAP)) {
    if (lower.includes(keyword)) return Math.min(qty, max)
  }
  return Math.min(qty, 4)
}

async function callPdfplumber(
  base64: string,
  userColumnMapping?: Record<string, number> | null,
): Promise<PdfplumberResult> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000')

  const payload: Record<string, unknown> = { pdf_base64: base64 }
  if (userColumnMapping) {
    payload.user_column_mapping = userColumnMapping
  }

  const response = await fetch(`${baseUrl}/api/extract-tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(`Pdfplumber extraction failed: ${response.status} ${response.statusText}`)
  }

  return response.json()
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
    const response = await client.messages.create({
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

// --- Core extraction logic (shared by streaming and parse-only modes) ---

async function extractFromPDF(base64: string): Promise<{
  hardwareSets: HardwareSet[]
  doors: DoorEntry[]
  corrections: LLMCorrections
  stats: { tables_found: number; hw_sets_found: number; method: string }
}> {
  let pdfplumberResult: PdfplumberResult | null = null
  try {
    pdfplumberResult = await callPdfplumber(base64)
    console.log(
      `Pdfplumber: ${pdfplumberResult.hw_sets_found} hardware sets, ` +
      `${pdfplumberResult.openings.length} doors, ` +
      `${pdfplumberResult.reference_codes.length} reference codes`
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('Pdfplumber extraction failed:', msg)
  }

  let hardwareSets: HardwareSet[] = (pdfplumberResult?.hardware_sets || []).map(s => ({
    set_id: s.set_id,
    heading: s.heading,
    items: s.items.map(i => ({
      qty: capItemQty(i.qty, i.name),
      name: i.name,
      manufacturer: i.manufacturer,
      model: i.model,
      finish: i.finish,
    })),
  }))

  let allDoors: DoorEntry[] = pdfplumberResult?.openings || []

  const client = new Anthropic()
  const corrections = await callLLMReview(client, base64, pdfplumberResult || {
    success: false,
    openings: [],
    hardware_sets: [],
    reference_codes: [],
    expected_door_count: 0,
    tables_found: 0,
    hw_sets_found: 0,
    method: 'none',
    error: 'pdfplumber failed',
  })

  const corrected = applyCorrections(hardwareSets, allDoors, corrections)
  hardwareSets = corrected.hardwareSets
  allDoors = corrected.doors

  // --- Final programmatic qty cap (safety net after all corrections) ---
  for (const set of hardwareSets) {
    for (const item of set.items) {
      const capped = capItemQty(item.qty, item.name)
      if (capped !== item.qty) {
        console.log(`[final-qty-cap] ${set.set_id}: "${item.name}" qty ${item.qty} → ${capped}`)
        item.qty = capped
      }
    }
  }

  // --- Extract fire ratings from hw_heading if misplaced ---
  const fireRatingPattern = /\b(\d{1,3}\s*[Mm]in|[123]\s*[Hh]r)\b/
  for (const door of allDoors) {
    if (!door.fire_rating) {
      const match = fireRatingPattern.exec(door.hw_heading || '')
      if (match) {
        door.fire_rating = match[1]
        door.hw_heading = (door.hw_heading || '').replace(match[0], '').trim()
      }
      const locMatch = fireRatingPattern.exec(door.location || '')
      if (!door.fire_rating && locMatch) {
        door.fire_rating = locMatch[1]
        door.location = (door.location || '').replace(locMatch[0], '').trim()
      }
    }
  }

  return {
    hardwareSets,
    doors: allDoors,
    corrections,
    stats: {
      tables_found: pdfplumberResult?.tables_found || 0,
      hw_sets_found: pdfplumberResult?.hw_sets_found || 0,
      method: pdfplumberResult?.method || 'none',
    },
  }
}

// --- Main handler (streaming progress + parse-only mode) ---

export async function POST(request: NextRequest) {
  // Parse-only mode: return JSON instead of streaming + saving
  const parseOnly = request.nextUrl.searchParams.get('parseOnly') === 'true'

  if (parseOnly) {
    try {
      const supabase = await createServerSupabaseClient()
      const { data: { user }, error: authError } = await supabase.auth.getUser()
      if (authError || !user) {
        return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
      }

      const body = await request.json()
      const base64 = body.pdfBase64
      if (!base64) {
        return NextResponse.json({ error: 'Missing pdfBase64' }, { status: 400 })
      }

      const { hardwareSets, doors, corrections, stats } = await extractFromPDF(base64)

      return NextResponse.json({
        success: true,
        doors,
        sets: hardwareSets,
        flaggedDoors: [],
        stats,
        reviewNotes: corrections.notes,
      })
    } catch (error) {
      console.error('Parse-only PDF error:', error)
      const message = error instanceof Error ? error.message : 'Internal server error'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  // --- Streaming mode (original behavior) ---
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

        // ==========================================
        // STEP 1+2: Pdfplumber extraction + LLM review
        // ==========================================
        send(8, 'Extracting tables (deterministic)...')

        const { hardwareSets, doors: allDoors, corrections } = await extractFromPDF(base64)

        const setCount = hardwareSets.length
        const totalItems = hardwareSets.reduce((sum, s) => sum + (s.items?.length || 0), 0)

        console.log(
          `After extraction: ${setCount} sets (${totalItems} items), ${allDoors.length} doors. ` +
          `Notes: ${corrections.notes || 'none'}`
        )

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

        // Build all hardware item rows
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

          // Determine if pair (two doors) based on door_type or hw_heading
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
          reviewNotes: corrections.notes,
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
