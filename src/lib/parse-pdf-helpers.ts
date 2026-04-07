/**
 * Shared helpers for the PDF extraction pipeline.
 * Canonical implementations extracted from chunk/route.ts (S-067 consolidation).
 */
import Anthropic from '@anthropic-ai/sdk'
import {
  getPostExtractionReviewPrompt,
  getQuantityCheckPrompt,
} from '@/lib/punchy-prompts'
import type {
  DoorEntry,
  ExtractedHardwareItem,
  HardwareSet,
  PdfplumberFlaggedDoor,
  PunchyCorrections,
  PunchyQuantityCheck,
} from '@/lib/types'
import { extractJSON } from '@/lib/extractJSON'

// --- Shared types ---

export interface PdfplumberResult {
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
  reference_codes?: Array<{
    code_type: string
    code: string
    full_name: string
  }>
  flagged_doors?: PdfplumberFlaggedDoor[]
  expected_door_count: number
  tables_found: number
  hw_sets_found: number
  method: string
  error: string
}

// --- Pipeline helpers ---

export async function callPdfplumber(
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
      const rawText = await response.text()
      console.error('[callPdfplumber] Non-OK response:', response.status, rawText.slice(0, 500))
      throw new Error(`Pdfplumber extraction failed: ${response.status} ${response.statusText}`)
    }

    return response.json()
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Python endpoint timed out after 280s')
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

export async function callPunchyPostExtraction(
  client: Anthropic,
  base64: string,
  pdfplumberResult: PdfplumberResult,
  knownSetIds?: string[]
): Promise<PunchyCorrections> {
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

    return extractJSON(text) as PunchyCorrections
  } catch (err) {
    console.error('Punchy post-extraction review failed:', err instanceof Error ? err.message : String(err))
    return { notes: `Punchy review failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export async function callPunchyQuantityCheck(
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

export function applyCorrections(
  hardwareSets: HardwareSet[],
  doors: DoorEntry[],
  corrections: PunchyCorrections
): { hardwareSets: HardwareSet[]; doors: DoorEntry[] } {
  // Apply hardware set corrections
  if (corrections.hardware_sets_corrections) {
    for (const corr of corrections.hardware_sets_corrections) {
      const set = hardwareSets.find(s => s.set_id === corr.set_id)
      if (!set) continue

      if (corr.heading) set.heading = corr.heading

      // Remove items
      if (corr.items_to_remove) {
        set.items = (set.items ?? []).filter(
          item => !corr.items_to_remove!.includes(item.name)
        )
      }

      // Fix items
      if (corr.items_to_fix) {
        for (const fix of corr.items_to_fix) {
          const item = (set.items ?? []).find(i => i.name === fix.name)
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
          if (!(set.items ?? []).some(i => i.name === newItem.name)) {
            if (!set.items) set.items = []
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
          items: newSet.items ?? [],
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

/**
 * Post-Punchy quantity re-normalization.
 * Punchy may revert normalized quantities back to PDF totals.
 * This re-divides them using the Opening List door counts as ground truth.
 */
export function normalizeQuantities(
  hardwareSets: HardwareSet[],
  doors: DoorEntry[],
): void {
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
}

// --- Hardware item builder (Phase 3) ---

/**
 * Build per-opening hardware item rows (Door/Frame + set items).
 * Used by save/route.ts and apply-revision/route.ts.
 */
export function buildPerOpeningItems(
  openings: Array<{ id: string; door_number: string; hw_set: string | null }>,
  doorInfoMap: Map<string, { door_type: string; frame_type: string }>,
  setMap: Map<string, HardwareSet>,
  fkColumn: 'opening_id' | 'staging_opening_id' = 'opening_id',
  extraFields?: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []

  for (const opening of openings) {
    let sortOrder = 0
    const doorInfo = doorInfoMap.get(opening.door_number)
    const base = { [fkColumn]: opening.id, ...extraFields }

    // Determine if pair (two doors) based on door_type or hw_heading
    const hwSet = setMap.get(opening.hw_set ?? '')
    const heading = (hwSet?.heading ?? '').toLowerCase()
    const doorType = (doorInfo?.door_type ?? '').toLowerCase()
    const isPair = heading.includes('pair') || heading.includes('double') ||
                   doorType.includes('pr') || doorType.includes('pair')

    // Add door(s) only when door_type is known
    const doorModel = doorInfo?.door_type?.trim() || null
    if (doorModel) {
      if (isPair) {
        rows.push({ ...base, name: 'Door (Active Leaf)', qty: 1, manufacturer: null, model: doorModel, finish: null, sort_order: sortOrder++ })
        rows.push({ ...base, name: 'Door (Inactive Leaf)', qty: 1, manufacturer: null, model: doorModel, finish: null, sort_order: sortOrder++ })
      } else {
        rows.push({ ...base, name: 'Door', qty: 1, manufacturer: null, model: doorModel, finish: null, sort_order: sortOrder++ })
      }
    }

    // Frame — only when frame_type is known
    const frameModel = doorInfo?.frame_type?.trim() || null
    if (frameModel) {
      rows.push({ ...base, name: 'Frame', qty: 1, manufacturer: null, model: frameModel, finish: null, sort_order: sortOrder++ })
    }

    // Hardware set items
    if ((hwSet?.items?.length ?? 0) > 0) {
      for (const item of hwSet?.items ?? []) {
        rows.push({
          ...base,
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

  return rows
}
