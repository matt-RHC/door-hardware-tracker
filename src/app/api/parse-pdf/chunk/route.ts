import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
import { extractFireRatings } from '@/lib/fire-rating'
import {
  getPostExtractionReviewPrompt,
  getQuantityCheckPrompt,
  getColumnMappingReviewPrompt,
} from '@/lib/punchy-prompts'
import type {
  DoorEntry,
  HardwareItem,
  HardwareSet,
  PdfplumberFlaggedDoor,
  PunchyCorrections,
  PunchyQuantityCheck,
  PunchyColumnReview,
  PunchyObservation,
} from '@/lib/types'
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
  flagged_doors: PdfplumberFlaggedDoor[]
  expected_door_count: number
  tables_found: number
  hw_sets_found: number
  method: string
  error: string
}

// Legacy LLMCorrections type kept for applyCorrections compatibility
// PunchyCorrections extends this with confidence scoring
interface LLMCorrections {
  hardware_sets_corrections?: Array<{
    set_id: string
    heading?: string
    items_to_add?: HardwareItem[]
    items_to_remove?: string[]
    items_to_fix?: Array<{ name: string; field: string; old_value: string; new_value: string; confidence?: string }>
  }>
  doors_corrections?: Array<{
    door_number: string
    field: string
    old_value: string
    new_value: string
    confidence?: string
  }>
  missing_doors?: Array<DoorEntry & { confidence?: string }>
  missing_sets?: Array<{
    set_id: string
    heading: string
    items: HardwareItem[]
    confidence?: string
  }>
  overall_confidence?: string
  notes?: string
}

// --- Helpers ---

async function callPdfplumber(
  base64: string,
  userColumnMapping?: Record<string, number> | null,
): Promise<PdfplumberResult> {
  // S-064: Fix operator precedence bug (was missing parens around ternary)
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000')

  const payload: Record<string, unknown> = { pdf_base64: base64 }
  if (userColumnMapping) {
    payload.user_column_mapping = userColumnMapping
  }

  // S-064: Add 280s timeout matching route.ts (was missing entirely)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 280_000)

  try {
    const response = await fetch(`${baseUrl}/api/extract-tables`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    if (!response.ok) {
      // Read raw text for diagnostics before throwing
      const rawText = await response.text()
      console.error('[chunk/callPdfplumber] Non-OK response:', response.status, rawText.slice(0, 500))
      throw new Error(`Pdfplumber extraction failed: ${response.status} ${response.statusText}`)
    }

    return response.json()
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Python endpoint timed out after 280s (chunk route)')
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

// ── Punchy Checkpoint 2: Post-Extraction Review ──────────────────

async function callPunchyPostExtraction(
  client: Anthropic,
  base64: string,
  pdfplumberResult: PdfplumberResult,
  knownSetIds?: string[]
): Promise<LLMCorrections> {
  const systemPrompt = getPostExtractionReviewPrompt()

  const extractedSummary = JSON.stringify({
    hardware_sets: (pdfplumberResult?.hardware_sets ?? []).map(s => ({
      set_id: s.set_id,
      heading: s.heading,
      item_count: s.items?.length ?? 0,
      items: s.items ?? [],
    })),
    doors_count: pdfplumberResult?.openings?.length ?? 0,
    doors_sample: (pdfplumberResult?.openings ?? []).slice(0, 10),
    total_doors: pdfplumberResult?.openings?.length ?? 0,
    known_set_ids: knownSetIds ?? [],
  }, null, 2)

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
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

    const textBlock = response.content.find((b: { type: string }) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      return { notes: 'Punchy returned no text' }
    }

    let text = textBlock.text.trim()
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
    }

    return extractJSON(text) as LLMCorrections
  } catch (err) {
    console.error('Punchy post-extraction review failed:', err instanceof Error ? err.message : String(err))
    return { notes: `Punchy review failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ── Punchy Checkpoint 1: Column Mapping Review ───────────────────

async function callPunchyColumnReview(
  client: Anthropic,
  base64: string,
  columnMapping: Record<string, number> | null | undefined,
): Promise<PunchyColumnReview> {
  const systemPrompt = getColumnMappingReviewPrompt()

  const mappingSummary = columnMapping
    ? JSON.stringify(columnMapping, null, 2)
    : 'No column mapping provided (auto-detection will be used)'

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
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
              text: `Here is the user's column mapping for the opening list table:\n\n${mappingSummary}\n\nReview the PDF and check if any expected fields are unmapped or incorrectly mapped. Return corrections as JSON.`,
            },
          ],
        },
      ],
    })

    const textBlock = response.content.find((b: { type: string }) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      return { unmapped_fields: [], mapping_issues: [], notes: 'Punchy returned no text' }
    }

    let text = textBlock.text.trim()
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
    }

    return extractJSON(text) as PunchyColumnReview
  } catch (err) {
    console.error('Punchy column review failed:', err instanceof Error ? err.message : String(err))
    return { unmapped_fields: [], mapping_issues: [], notes: `Punchy column review failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ── Punchy Checkpoint 3: Quantity Sanity Check ───────────────────

async function callPunchyQuantityCheck(
  client: Anthropic,
  base64: string,
  hardwareSets: HardwareSet[],
  doors: DoorEntry[],
): Promise<PunchyQuantityCheck> {
  const systemPrompt = getQuantityCheckPrompt()

  const dataSummary = JSON.stringify({
    hardware_sets: hardwareSets.map(s => ({
      set_id: s.set_id,
      heading: s.heading,
      items: (s.items ?? []).map(i => ({
        name: i.name,
        qty: i.qty,
        qty_source: i.qty_source,
        manufacturer: i.manufacturer,
        model: i.model,
        finish: i.finish,
      })),
    })),
    doors: doors.slice(0, 20).map(d => ({
      door_number: d.door_number,
      hw_set: d.hw_set,
      fire_rating: d.fire_rating,
      door_type: d.door_type,
      hand: d.hand,
    })),
    total_doors: doors.length,
  }, null, 2)

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
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
              text: `Here are the normalized hardware quantities and door assignments. Check quantities against DFH standards and flag any compliance issues:\n\n${dataSummary}`,
            },
          ],
        },
      ],
    })

    const textBlock = response.content.find((b: { type: string }) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      return { flags: [], compliance_issues: [], notes: 'Punchy returned no text' }
    }

    let text = textBlock.text.trim()
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
    }

    return extractJSON(text) as PunchyQuantityCheck
  } catch (err) {
    console.error('Punchy quantity check failed:', err instanceof Error ? err.message : String(err))
    return { flags: [], compliance_issues: [], notes: `Punchy quantity check failed: ${err instanceof Error ? err.message : String(err)}` }
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
              // S-064: Reset qty_source so post-LLM re-normalization catches this
              ;(item as any).qty_source = 'llm_override'
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
      console.debug(
        `Chunk ${chunkIndex + 1}/${totalChunks}: pdfplumber extracted ` +
        `${pdfplumberResult.hw_sets_found} sets, ${pdfplumberResult.openings.length} doors`
      )
    } catch (err) {
      console.error(
        `Chunk ${chunkIndex + 1}/${totalChunks}: pdfplumber failed:`,
        err instanceof Error ? err.message : String(err)
      )
    }

    // Convert pdfplumber result to our types — Python layer handles qty normalization
    let hardwareSets: HardwareSet[] = (pdfplumberResult?.hardware_sets || []).map(s => ({
      set_id: s.set_id,
      heading: s.heading,
      items: (s.items ?? []).map(i => ({
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

    let doors: DoorEntry[] = pdfplumberResult?.openings || []
    const flaggedDoors: PdfplumberFlaggedDoor[] = pdfplumberResult?.flagged_doors || []

    // ==========================================
    // Step 2: Punchy Checkpoint 1 — Column Mapping Review
    // (only on first chunk when user provided a mapping)
    // ==========================================
    const client = new Anthropic()
    const punchyObservations: PunchyObservation[] = []

    if (chunkIndex === 0 && userColumnMapping) {
      try {
        const columnReview = await callPunchyColumnReview(client, chunkBase64, userColumnMapping)
        if ((columnReview.unmapped_fields?.length ?? 0) > 0 || (columnReview.mapping_issues?.length ?? 0) > 0) {
          punchyObservations.push({
            checkpoint: 'column_mapping',
            message: columnReview.notes ?? 'Column mapping review complete',
            confidence: (columnReview.unmapped_fields?.length ?? 0) > 0 ? 'medium' : 'high',
            field_suggestions: (columnReview.unmapped_fields ?? []).map(f => ({
              field: f.field,
              suggestion: f.suggestion,
              confidence: f.confidence,
            })),
          })
        }
        console.debug(`Chunk ${chunkIndex + 1}: Punchy column review: ${columnReview.unmapped_fields?.length ?? 0} unmapped fields, ${columnReview.mapping_issues?.length ?? 0} issues`)
      } catch (err) {
        console.error('Punchy column review error:', err instanceof Error ? err.message : String(err))
      }
    }

    // ==========================================
    // Step 3: Punchy Checkpoint 2 — Post-Extraction Review
    // ==========================================
    const corrections = await callPunchyPostExtraction(client, chunkBase64, pdfplumberResult ?? {
      success: false,
      openings: [],
      hardware_sets: [],
      reference_codes: [],
      flagged_doors: [],
      expected_door_count: 0,
      tables_found: 0,
      hw_sets_found: 0,
      method: 'none',
      error: 'pdfplumber failed',
    }, knownSetIds)

    // Track Punchy's post-extraction observations
    if (corrections.notes) {
      punchyObservations.push({
        checkpoint: 'post_extraction',
        message: corrections.notes,
        confidence: (corrections.overall_confidence as PunchyObservation['confidence']) ?? 'medium',
      })
    }

    // Apply corrections
    const corrected = applyCorrections(hardwareSets, doors, corrections)
    hardwareSets = corrected.hardwareSets
    doors = corrected.doors

    // --- Post-LLM qty re-normalization ---
    // Punchy may revert normalized quantities back to PDF totals.
    // Build doorsPerSet from Opening List as fallback (parity with route.ts)
    const doorsPerSet = new Map<string, number>()
    for (const door of doors) {
      if (door.hw_set) {
        doorsPerSet.set(door.hw_set.toUpperCase(), (doorsPerSet.get(door.hw_set.toUpperCase()) ?? 0) + 1)
      }
    }
    for (const set of hardwareSets) {
      const leafCount = (set.heading_leaf_count ?? 0) > 1 ? (set.heading_leaf_count ?? 0) : 0
      const doorCount = (set.heading_door_count ?? 0) > 1
        ? (set.heading_door_count ?? 0)
        : (doorsPerSet.get((set.generic_set_id ?? set.set_id).toUpperCase()) ?? 0)
      if (leafCount <= 1 && doorCount <= 1) continue

      for (const item of set.items ?? []) {
        if (item.qty_source === 'divided' || item.qty_source === 'flagged' || item.qty_source === 'capped') {
          continue
        }
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
    extractFireRatings(doors)

    // ==========================================
    // Step 4: Punchy Checkpoint 3 — Quantity Sanity Check
    // ==========================================
    let quantityCheck: PunchyQuantityCheck | null = null
    try {
      quantityCheck = await callPunchyQuantityCheck(client, chunkBase64, hardwareSets, doors)
      if ((quantityCheck.flags?.length ?? 0) > 0 || (quantityCheck.compliance_issues?.length ?? 0) > 0) {
        punchyObservations.push({
          checkpoint: 'quantity_check',
          message: quantityCheck.notes ?? 'Quantity check complete',
          confidence: (quantityCheck.compliance_issues?.length ?? 0) > 0 ? 'medium' : 'high',
        })
      }
      console.debug(
        `Chunk ${chunkIndex + 1}: Punchy qty check: ${quantityCheck.flags?.length ?? 0} flags, ` +
        `${quantityCheck.compliance_issues?.length ?? 0} compliance issues`
      )
    } catch (err) {
      console.error('Punchy quantity check error:', err instanceof Error ? err.message : String(err))
    }

    console.debug(
      `Chunk ${chunkIndex + 1}/${totalChunks}: Punchy pipeline complete: ` +
      `${hardwareSets.length} sets, ${doors.length} doors, ` +
      `${punchyObservations.length} observations`
    )

    return NextResponse.json({
      chunkIndex,
      hardwareSets,
      doors,
      flaggedDoors,
      reviewNotes: corrections.notes,
      punchyObservations,
      punchyQuantityCheck: quantityCheck,
    })
  } catch (error) {
    console.error('Chunk processing error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
