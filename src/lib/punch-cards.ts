/**
 * PunchCard generator — turns extraction results into an ordered list of
 * review cards for the Punchy card UI.
 *
 * Each card represents one finding, one decision, one screen.
 */

import type {
  DoorEntry,
  HardwareSet,
  PunchyQuantityCheck,
  PageClassification,
} from '@/lib/types'
import { generateTriageQuestions, type PunchQuestion } from '@/lib/punch-messages'

// ── Card data types ──

export type CardKind =
  | 'summary'
  | 'empty_sets'
  | 'calibration'
  | 'auto_correction'
  | 'question'
  | 'compliance'
  | 'flag'
  | 'triage_question'
  | 'ready'

export interface PunchCardData {
  id: string
  kind: CardKind
  title: string
  /** If true, user must take an action (can't skip). */
  required: boolean
  /** 0-based PDF page index for preview, or null. */
  pdfPageIndex: number | null
  /** Arbitrary payload for the card renderer. */
  payload: Record<string, unknown>
}

// ── Page lookup ──

/**
 * Find the PDF page (0-based index) that contains a given hardware set.
 * Uses the hw_set_ids from classify-pages response.
 */
export function findPageForSet(
  setId: string,
  pages: PageClassification[],
): number | null {
  const upper = setId.toUpperCase()
  const page = pages.find(p =>
    (p.hw_set_ids ?? []).some(id => id.toUpperCase() === upper),
  )
  return page?.page_number ?? null
}

// ── Extraction health (moved from StepTriage) ──

export interface ExtractionHealth {
  totalItems: number
  emptySets: HardwareSet[]
  populatedSets: HardwareSet[]
  assignedDoors: number
  unassignedDoors: number
  missingSetIds: string[]
  grade: 'good' | 'warning' | 'critical'
  bestSample: {
    set_id: string
    heading: string
    items: HardwareSet['items']
    door?: DoorEntry
  } | null
}

export function computeExtractionHealth(
  doors: DoorEntry[],
  hardwareSets: HardwareSet[],
): ExtractionHealth {
  const totalItems = hardwareSets.reduce(
    (sum, s) => sum + (s.items?.length ?? 0), 0,
  )
  const emptySets = hardwareSets.filter(s => (s.items?.length ?? 0) === 0)
  const populatedSets = hardwareSets.filter(s => (s.items?.length ?? 0) > 0)
  const assignedDoors = doors.filter(d => d.hw_set && d.hw_set.trim() !== '').length
  const unassignedDoors = doors.length - assignedDoors

  const doorSetIds = new Set(
    doors.map(d => (d.hw_set ?? '').toUpperCase()).filter(Boolean),
  )
  const extractedSetIds = new Set(
    hardwareSets.map(s => (s.generic_set_id ?? s.set_id).toUpperCase()),
  )
  const missingSetIds = [...doorSetIds].filter(id => !extractedSetIds.has(id))

  const grade: ExtractionHealth['grade'] =
    totalItems === 0 || emptySets.length === hardwareSets.length
      ? 'critical'
      : emptySets.length > 0 || missingSetIds.length > 0
        ? 'warning'
        : 'good'

  // Best sample: populated set with the most items
  let bestSample: ExtractionHealth['bestSample'] = null
  if (populatedSets.length > 0) {
    const best = populatedSets.reduce((a, b) =>
      (a.items?.length ?? 0) >= (b.items?.length ?? 0) ? a : b,
    )
    const sampleDoor = doors.find(
      d => (d.hw_set ?? '').toUpperCase() === (best.generic_set_id ?? best.set_id).toUpperCase(),
    )
    bestSample = {
      set_id: best.set_id,
      heading: best.heading,
      items: best.items,
      door: sampleDoor,
    }
  }

  return {
    totalItems,
    emptySets,
    populatedSets,
    assignedDoors,
    unassignedDoors,
    missingSetIds,
    grade,
    bestSample,
  }
}

// ── Card generator ──

export function generatePunchCards(input: {
  doors: DoorEntry[]
  hardwareSets: HardwareSet[]
  qtyCheck: PunchyQuantityCheck | null
  pages: PageClassification[]
}): PunchCardData[] {
  const { doors, hardwareSets, qtyCheck, pages } = input
  const cards: PunchCardData[] = []
  const health = computeExtractionHealth(doors, hardwareSets)

  // ── 1. Summary (always first) ──
  cards.push({
    id: 'summary',
    kind: 'summary',
    title: 'Extraction Summary',
    required: true,
    pdfPageIndex: null,
    payload: {
      doorCount: doors.length,
      setCount: hardwareSets.length,
      itemCount: health.totalItems,
      assignedDoors: health.assignedDoors,
      unassignedDoors: health.unassignedDoors,
      emptySetCount: health.emptySets.length,
      missingSetIds: health.missingSetIds,
      grade: health.grade,
      sets: hardwareSets.map(s => ({
        set_id: s.set_id,
        heading: s.heading,
        itemCount: s.items?.length ?? 0,
      })),
    },
  })

  // ── 2. Empty sets (if any) ──
  if (health.emptySets.length > 0) {
    cards.push({
      id: 'empty-sets',
      kind: 'empty_sets',
      title: `${health.emptySets.length} Set${health.emptySets.length !== 1 ? 's' : ''} Missing Items`,
      required: false,
      pdfPageIndex: null,
      payload: {
        emptySets: health.emptySets.map(s => ({
          set_id: s.set_id,
          heading: s.heading,
        })),
        totalSets: hardwareSets.length,
      },
    })
  }

  // ── 3. Sample calibration (if empty sets + good sample) ──
  if (health.emptySets.length > 0 && health.bestSample) {
    const samplePageIdx = findPageForSet(health.bestSample.set_id, pages)
    cards.push({
      id: 'calibration',
      kind: 'calibration',
      title: `Verify Sample: ${health.bestSample.set_id}`,
      required: false,
      pdfPageIndex: samplePageIdx,
      payload: {
        sample: health.bestSample,
      },
    })
  }

  // ── 4. Auto-corrections (batch) ──
  const autoCorrections = qtyCheck?.auto_corrections ?? []
  if (autoCorrections.length > 0) {
    cards.push({
      id: 'auto-corrections',
      kind: 'auto_correction',
      title: `${autoCorrections.length} Quantity Correction${autoCorrections.length !== 1 ? 's' : ''}`,
      required: true,
      pdfPageIndex: null,
      payload: { corrections: autoCorrections },
    })
  }

  // ── 5. Quantity questions (one per question) ──
  for (const q of qtyCheck?.questions ?? []) {
    const pageIdx = findPageForSet(q.set_id, pages)
    cards.push({
      id: q.id,
      kind: 'question',
      title: `${q.set_id}: ${q.item_name}`,
      required: true,
      pdfPageIndex: pageIdx,
      payload: { question: q },
    })
  }

  // ── 6. Compliance issues ──
  for (const ci of qtyCheck?.compliance_issues ?? []) {
    const pageIdx = findPageForSet(ci.set_id, pages)
    cards.push({
      id: `compliance-${ci.set_id}-${ci.issue.slice(0, 20)}`,
      kind: 'compliance',
      title: `Compliance: ${ci.set_id}`,
      required: false,
      pdfPageIndex: pageIdx,
      payload: { issue: ci },
    })
  }

  // ── 7. Flags (grouped if > 3) ──
  const flags = qtyCheck?.flags ?? []
  if (flags.length > 0) {
    cards.push({
      id: 'flags',
      kind: 'flag',
      title: `${flags.length} Observation${flags.length !== 1 ? 's' : ''}`,
      required: false,
      pdfPageIndex: null,
      payload: { flags },
    })
  }

  // ── 8. Triage questions ──
  const triageQs = generateTriageQuestions(doors)
  for (const q of triageQs) {
    cards.push({
      id: q.id,
      kind: 'triage_question',
      title: 'Validation Question',
      required: false,
      pdfPageIndex: null,
      payload: { question: q },
    })
  }

  // ── 9. Ready (always last) ──
  cards.push({
    id: 'ready',
    kind: 'ready',
    title: 'Ready for Triage',
    required: true,
    pdfPageIndex: null,
    payload: {
      doorCount: doors.length,
      setCount: hardwareSets.length,
    },
  })

  return cards
}
