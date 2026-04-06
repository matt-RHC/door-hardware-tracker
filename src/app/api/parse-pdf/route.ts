import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
import { getTaxonomyPromptText } from '@/lib/hardware-taxonomy'
import { extractFireRatings } from '@/lib/fire-rating'
import type { DoorEntry, HardwareItem, HardwareSet } from '@/lib/types'
import { extractJSON } from '@/lib/extractJSON'

// Vercel Fluid Compute: 800s timeout (Pro plan max)
export const maxDuration = 800

interface PdfplumberResult {
  success: boolean
  openings: DoorEntry[]
  hardware_sets: Array<{
    set_id: string
    heading: string
    items: Array<{
      qty: number
      qty_total?: number
      qty_door_count?: number
      qty_source?: string
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
    if (process.env.NODE_ENV === 'development') {
      console.debug('[parse-pdf] Sending user_column_mapping to extract-tables:', JSON.stringify(userColumnMapping))
    }
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 280_000)

  let response: Response
  let responseText: string
  try {
    response = await fetch(`${baseUrl}/api/extract-tables`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    // Read raw text first — if the Python function crashes, response.json()
    // throws "Unexpected end of JSON input" with no diagnostic info
    responseText = await response.text()
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Python endpoint timed out after 280s')
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }

  if (!response.ok) {
    console.error(`[parse-pdf] extract-tables returned ${response.status}:`, responseText.slice(0, 500))
    throw new Error(`Pdfplumber extraction failed: ${response.status} — ${responseText.slice(0, 200)}`)
  }

  try {
    return JSON.parse(responseText) as PdfplumberResult
  } catch {
    console.error(`[parse-pdf] extract-tables returned invalid JSON (${responseText.length} bytes):`, responseText.slice(0, 500))
    throw new Error(`extract-tables returned invalid JSON (${responseText.length} bytes): ${responseText.slice(0, 200)}`)
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
- DO NOT "fix" item quantities. The quantities shown have ALREADY been normalized from PDF totals to per-opening values by dividing by the number of doors in each set. If the PDF shows "8" for closers across 8 doors, the correct per-opening qty is 1, and the extracted data will show 1. Do NOT change it back to 8.
- Focus on: missing items/doors, wrong set assignments, misread text (names, manufacturers, models, finishes).
- Do NOT correct formatting differences (e.g. "HM" vs "Hollow Metal" are both fine).
- FIELD SPLITTING: The name field should contain ONLY the hardware category name (e.g., "Closer", "Hinges", "Exit Device"). If an item's name still contains model numbers, finish codes, or manufacturer abbreviations (e.g., name="Closer 4040XP AL LC" with empty model/finish/mfr), report it as items_to_fix. Split: name=category only, model=catalog/model number, finish=finish code, manufacturer=company abbreviation. Common codes: IV=Ives, SC=Schlage, ZE=Zero, LC=LCN, AB=ABH, VO=Von Duprin, NA=NGP, ME=Medeco.

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
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16384,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 },
              cache_control: { type: 'ephemeral' },
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

    return extractJSON(text) as LLMCorrections
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

async function extractFromPDF(base64: string, filteredPdfBase64?: string, userColumnMapping?: Record<string, number> | null): Promise<{
  hardwareSets: HardwareSet[]
  doors: DoorEntry[]
  corrections: LLMCorrections
  stats: { tables_found: number; hw_sets_found: number; method: string }
}> {
  let pdfplumberResult: PdfplumberResult | null = null
  try {
    pdfplumberResult = await callPdfplumber(base64, userColumnMapping)
    console.debug(
      `Pdfplumber: ${pdfplumberResult.hw_sets_found} hardware sets, ` +
      `${pdfplumberResult.openings.length} doors, ` +
      `${pdfplumberResult.reference_codes.length} reference codes`
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('Pdfplumber extraction failed:', msg)
  }

  // Python layer now handles qty normalization (total ÷ door_count = per-opening).
  // Pass through qty metadata fields as-is.
  let hardwareSets: HardwareSet[] = (pdfplumberResult?.hardware_sets || []).map(s => ({
    set_id: s.set_id,
    heading: s.heading,
    items: s.items.map(i => ({
      qty: i.qty,
      qty_total: i.qty_total,
      qty_door_count: i.qty_door_count,
      qty_source: i.qty_source,
      name: i.name,
      manufacturer: i.manufacturer,
      model: i.model,
      finish: i.finish,
    })),
  }))

  let allDoors: DoorEntry[] = pdfplumberResult?.openings || []

  const client = new Anthropic()
  // Use filtered PDF for LLM review if available (fewer pages = cheaper + faster)
  const reviewPdf = filteredPdfBase64 ?? base64
  const corrections = await callLLMReview(client, reviewPdf, pdfplumberResult || {
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

  // --- Post-LLM qty re-normalization ---
  // The LLM may "correct" already-normalized quantities back to PDF totals.
  // Use heading-based counts from Python, fall back to Opening List counting.
  const doorsPerSet = new Map<string, number>()
  for (const door of allDoors) {
    if (door.hw_set) {
      doorsPerSet.set(door.hw_set.toUpperCase(), (doorsPerSet.get(door.hw_set.toUpperCase()) ?? 0) + 1)
    }
  }
  for (const set of hardwareSets) {
    // Skip items already normalized by Python
    // Prefer heading-based counts; fall back to Opening List
    const leafCount = (set.heading_leaf_count ?? 0) > 1
      ? (set.heading_leaf_count ?? 0)
      : 0
    const doorCount = (set.heading_door_count ?? 0) > 1
      ? (set.heading_door_count ?? 0)
      : (doorsPerSet.get((set.generic_set_id ?? set.set_id).toUpperCase()) ?? 0)
    if (leafCount <= 1 && doorCount <= 1) continue

    for (const item of set.items) {
      if (item.qty_source === 'divided' || item.qty_source === 'flagged' || item.qty_source === 'capped') {
        continue
      }
      // Try leaf count first, then opening count (same strategy as Python)
      let divided = false
      if (leafCount > 1 && item.qty >= leafCount) {
        const perLeaf = item.qty / leafCount
        if (Number.isInteger(perLeaf)) {
          item.qty_total = item.qty
          item.qty_door_count = leafCount
          item.qty = perLeaf
          item.qty_source = 'divided'
          divided = true
        }
      }
      if (!divided && doorCount > 1 && doorCount !== leafCount && item.qty >= doorCount) {
        const perOpening = item.qty / doorCount
        if (Number.isInteger(perOpening)) {
          item.qty_total = item.qty
          item.qty_door_count = doorCount
          item.qty = perOpening
          item.qty_source = 'divided'
        }
      }
    }
  }

  // Extract fire ratings embedded in hw_heading/location fields
  extractFireRatings(allDoors)

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

      // Client may send a filtered PDF (opening list + hardware schedule pages only)
      // for cheaper LLM review. pdfplumber still gets the full PDF.
      const filteredPdfBase64: string | undefined = body.filteredPdfBase64 ?? undefined

      const userColumnMapping = body.userColumnMapping ?? null
      const { hardwareSets, doors, corrections, stats } = await extractFromPDF(base64, filteredPdfBase64, userColumnMapping)

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

        console.debug(
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

          // Add door(s) only when door_type is known
          const doorModel = doorInfo?.door_type?.trim() || null
          if (doorModel) {
            if (isPair) {
              allHardwareRows.push({
                opening_id: opening.id,
                name: `Door (Active Leaf)`,
                qty: 1,
                manufacturer: null,
                model: doorModel,
                finish: null,
                sort_order: sortOrder++,
              })
              allHardwareRows.push({
                opening_id: opening.id,
                name: `Door (Inactive Leaf)`,
                qty: 1,
                manufacturer: null,
                model: doorModel,
                finish: null,
                sort_order: sortOrder++,
              })
            } else {
              allHardwareRows.push({
                opening_id: opening.id,
                name: `Door`,
                qty: 1,
                manufacturer: null,
                model: doorModel,
                finish: null,
                sort_order: sortOrder++,
              })
            }
          }

          // Frame — only when frame_type is known
          const frameModel = doorInfo?.frame_type?.trim() || null
          if (frameModel) {
            allHardwareRows.push({
              opening_id: opening.id,
              name: `Frame`,
              qty: 1,
              manufacturer: null,
              model: frameModel,
              finish: null,
              sort_order: sortOrder++,
            })
          }

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

        console.debug(`PDF parse complete: ${insertedOpenings.length} openings, ${itemsInserted} hardware items`)

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
