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
    items_to_remove?: string[]  // item names to remove
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
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000'

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
  pdfplumberResult: PdfplumberResult,
  knownSetIds?: string[]
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
    doors_sample: pdfplumberResult.openings.slice(0, 10),
    total_doors: pdfplumberResult.openings.length,
    known_set_ids: knownSetIds || [],
  }, null, 2)

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
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
  // Apply hardware set corrections
  if (corrections.hardware_sets_corrections) {
    for (const corr of corrections.hardware_sets_corrections) {
      const set = hardwareSets.find(s => s.set_id === corr.set_id)
      if (!set) continue

      if (corr.heading) set.heading = corr.heading

      // Remove items
      if (corr.items_to_remove) {
        set.items = set.items.filter(
          item => !corr.items_to_remove!.includes(item.name)
        )
      }

      // Fix items
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

      // Add missing items
      if (corr.items_to_add) {
        for (const newItem of corr.items_to_add) {
          // Only add if not already present
          if (!set.items.some(i => i.name === newItem.name)) {
            set.items.push(newItem)
          }
        }
      }
    }
  }

  // Add missing sets
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

  // Apply door corrections
  if (corrections.doors_corrections) {
    for (const corr of corrections.doors_corrections) {
      const door = doors.find(d => d.door_number === corr.door_number)
      if (door && corr.field in door) {
        (door as any)[corr.field] = corr.new_value
      }
    }
  }

  // Add missing doors
  if (corrections.missing_doors) {
    for (const newDoor of corrections.missing_doors) {
      if (!doors.some(d => d.door_number === newDoor.door_number)) {
        doors.push(newDoor)
      }
    }
  }

  return { hardwareSets, doors }
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
    const { chunkBase64, chunkIndex, totalChunks, knownSetIds, userColumnMapping } = body as {
      chunkBase64: string
      chunkIndex: number
      totalChunks: number
      knownSetIds?: string[]
      userColumnMapping?: Record<string, number> | null
    }

    if (!chunkBase64) {
      return NextResponse.json({ error: 'Missing chunkBase64' }, { status: 400 })
    }

    // ==========================================
    // Step 1: Pdfplumber deterministic extraction
    // ==========================================
    let pdfplumberResult: PdfplumberResult | null = null
    try {
      pdfplumberResult = await callPdfplumber(chunkBase64, userColumnMapping)
      console.log(
        `Chunk ${chunkIndex + 1}/${totalChunks}: pdfplumber extracted ` +
        `${pdfplumberResult.hw_sets_found} sets, ${pdfplumberResult.openings.length} doors`
      )
    } catch (err) {
      console.error(
        `Chunk ${chunkIndex + 1}/${totalChunks}: pdfplumber failed:`,
        err instanceof Error ? err.message : String(err)
      )
    }

    // Convert pdfplumber result to our types
    let hardwareSets: HardwareSet[] = (pdfplumberResult?.hardware_sets || []).map(s => ({
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

    let doors: DoorEntry[] = pdfplumberResult?.openings || []

    // ==========================================
    // Step 2: LLM review pass (always)
    // ==========================================
    const client = new Anthropic()
    const corrections = await callLLMReview(client, chunkBase64, pdfplumberResult || {
      success: false,
      openings: [],
      hardware_sets: [],
      reference_codes: [],
      expected_door_count: 0,
      tables_found: 0,
      hw_sets_found: 0,
      method: 'none',
      error: 'pdfplumber failed',
    }, knownSetIds)

    // Apply corrections
    const corrected = applyCorrections(hardwareSets, doors, corrections)
    hardwareSets = corrected.hardwareSets
    doors = corrected.doors

    console.log(
      `Chunk ${chunkIndex + 1}/${totalChunks}: after LLM review: ` +
      `${hardwareSets.length} sets, ${doors.length} doors. ` +
      `Notes: ${corrections.notes || 'none'}`
    )

    return NextResponse.json({
      chunkIndex,
      hardwareSets,
      doors,
      reviewNotes: corrections.notes,
    })
  } catch (error) {
    console.error('Chunk processing error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
