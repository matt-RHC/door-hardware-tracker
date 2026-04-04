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
 * LLM Full Extraction — used when pdfplumber finds nothing.
 * Claude vision reads the PDF chunk directly (cloud OCR via vision).
 */
async function callLLMFullExtraction(
  client: Anthropic,
  base64: string,
  knownSetIds?: string[]
): Promise<LLMFullExtraction> {
  const systemPrompt = `You are a precision data extractor for door hardware submittal PDFs.

You will receive a PDF document (or a section of one) containing door hardware submittal data.
Your job is to extract ALL data with maximum accuracy.

Extract TWO things:

1. HARDWARE SETS — Each set has:
   - set_id: The set identifier (e.g. "DH1", "DH2-R", "EX1")
   - heading: Description (e.g. "Interior Single Door - Office")
   - items: Array of hardware items, each with:
     - qty: Quantity PER INDIVIDUAL DOOR (not totals). Typical: hinges=3-4, closers=1, locksets=1
     - name: Item name/description
     - manufacturer: Manufacturer abbreviation
     - model: Model/catalog number
     - finish: Finish code

2. DOORS (Opening List / Door Schedule) — Each door has:
   - door_number: The opening/door number (e.g. "110-01A", "ST-1A")
   - hw_set: Which hardware set applies
   - location: Room/area description
   - door_type: Door type code (e.g. "WD", "HM")
   - frame_type: Frame type code
   - fire_rating: Fire rating (e.g. "20Min", "45Min", "" for none)
   - hand: Handing (e.g. "LHR", "RHR")

${knownSetIds?.length ? `\nAlready discovered hardware set IDs from other chunks: ${knownSetIds.join(', ')}\nDo NOT re-extract these sets unless this chunk has additional items for them.\n` : ''}

Return valid JSON:
{
  "hardware_sets": [...],
  "doors": [...],
  "notes": "Any observations"
}

CRITICAL RULES:
- Extract EVERY door and hardware set you can find. Do not skip any.
- qty must be PER INDIVIDUAL DOOR/OPENING (not totals).
- Be precise with model numbers, finish codes — copy exactly as shown.
- If a value is unclear, use empty string "".
- Do NOT hallucinate data.

${getTaxonomyPromptText()}`

  try {
    // Use streaming to avoid "Streaming is required for operations >10min" error
    // Large PDF chunks sent as documents can take a long time to process
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
              text: 'Extract all hardware sets and doors from this PDF section. Return the complete data as JSON.',
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
  pdfplumberResult: PdfplumberResult,
  knownSetIds?: string[]
): Promise<LLMCorrections> {
  const systemPrompt = `You are a quality reviewer for door hardware submittal PDF extraction.

You will receive:
1. A PDF document (door hardware submittal)
2. Structured data extracted from that PDF by an automated tool (pdfplumber)

Your job is to REVIEW the extracted data against the actual PDF and return ONLY corrections needed.

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
- qty must be PER INDIVIDUAL DOOR/OPENING (not totals).
- Focus on: missing items/doors, wrong set assignments, incorrect quantities, misread text.

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

// --- Chunk handler: processes one PDF chunk, returns JSON (no DB writes) ---

export async function POST(request: NextRequest) {
  try {
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
      knownSetIds?: string[]
    }

    if (!chunkBase64) {
      return NextResponse.json({ error: 'Missing chunkBase64' }, { status: 400 })
    }

    const client = new Anthropic()

    // ==========================================
    // Step 1: Pdfplumber deterministic extraction
    // ==========================================
    let pdfplumberResult: PdfplumberResult | null = null
    let pdfplumberWorked = false

    try {
      pdfplumberResult = await callPdfplumber(chunkBase64)
      // Require DOORS found, not just sets. If pdfplumber finds sets but no doors,
      // the door schedule table format is likely different — fall through to LLM full extraction.
      pdfplumberWorked = pdfplumberResult.openings.length > 0
      console.log(
        `Chunk ${chunkIndex + 1}/${totalChunks}: pdfplumber: ` +
        `${pdfplumberResult.hw_sets_found} sets, ${pdfplumberResult.openings.length} doors, ` +
        `text_layer=${pdfplumberResult.has_text_layer ?? 'unknown'}`
      )
    } catch (err) {
      console.error(
        `Chunk ${chunkIndex + 1}/${totalChunks}: pdfplumber failed:`,
        err instanceof Error ? err.message : String(err)
      )
    }

    let hardwareSets: HardwareSet[] = []
    let doors: DoorEntry[] = []
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
      doors = pdfplumberResult.openings || []

      const corrections = await callLLMReview(client, chunkBase64, pdfplumberResult, knownSetIds)
      const corrected = applyCorrections(hardwareSets, doors, corrections)
      hardwareSets = corrected.hardwareSets
      doors = corrected.doors
      reviewNotes = corrections.notes || ''
    } else {
      // ==========================================
      // PATH B: Pdfplumber found no doors → LLM full extraction (cloud OCR via vision)
      // If pdfplumber found hardware sets but not doors, preserve the sets
      // ==========================================
      const pdfplumberSets = pdfplumberResult?.hardware_sets || []
      console.log(
        `Chunk ${chunkIndex + 1}/${totalChunks}: switching to LLM full extraction` +
        (pdfplumberSets.length > 0 ? ` (preserving ${pdfplumberSets.length} pdfplumber sets)` : '')
      )

      const fullResult = await callLLMFullExtraction(client, chunkBase64, knownSetIds)

      // Merge: prefer pdfplumber sets (deterministic), supplement with LLM sets
      const pdfplumberSetIds = new Set(pdfplumberSets.map(s => s.set_id))
      const llmOnlySets = (fullResult.hardware_sets || []).filter(s => !pdfplumberSetIds.has(s.set_id))

      hardwareSets = [
        ...pdfplumberSets.map(s => ({
          set_id: s.set_id,
          heading: s.heading,
          items: (s.items || []).map(i => ({
            qty: i.qty || 1,
            name: i.name || '',
            manufacturer: i.manufacturer || '',
            model: i.model || '',
            finish: i.finish || '',
          })),
        })),
        ...llmOnlySets.map(s => ({
          set_id: s.set_id,
          heading: s.heading,
          items: (s.items || []).map(i => ({
            qty: i.qty || 1,
            name: i.name || '',
            manufacturer: i.manufacturer || '',
            model: i.model || '',
            finish: i.finish || '',
          })),
        })),
      ]
      doors = fullResult.doors || []
      reviewNotes = fullResult.notes || 'Doors extracted via AI vision (pdfplumber found sets only)'
    }

    console.log(
      `Chunk ${chunkIndex + 1}/${totalChunks}: final: ` +
      `${hardwareSets.length} sets, ${doors.length} doors. ` +
      `Notes: ${reviewNotes || 'none'}`
    )

    return NextResponse.json({
      chunkIndex,
      hardwareSets,
      doors,
      reviewNotes,
    })
  } catch (error) {
    console.error('Chunk processing error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
