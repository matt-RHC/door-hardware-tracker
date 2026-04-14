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
import { normalizeDoorNumber } from '@/lib/parse-pdf-helpers'
import { generateTriageQuestions, type PunchQuestion } from '@/lib/punch-messages'

// ── Card data types ──

export type CardKind =
  | 'summary'
  | 'empty_sets'
  | 'calibration'
  | 'auto_correction'
  | 'question'
  | 'question_batch'
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

/**
 * Find the first door_schedule page (0-based index).
 * Used for triage questions where the relevant context is the opening list.
 */
export function findFirstDoorSchedulePage(
  pages: PageClassification[],
): number | null {
  const page = pages.find(p => p.page_type === 'door_schedule')
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
    /** 0-based PDF page index for the set's definition, or null. Used
     *  by the calibration card to render a PDF preview so the user can
     *  verify Punchy's extraction against the source document. */
    pdf_page?: number | null
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

  // Best sample: populated set with the most items.
  //
  // The sample door MUST come from this specific sub-heading's heading_doors
  // list when available. Falling back to "any door whose hw_set matches the
  // generic_set_id" was the previous behavior and caused wrong-door pairings
  // when a parent set had multiple sub-headings (e.g., DH4A.0 pair doors and
  // DH4A.1 single doors both share generic_set_id "DH4A"). The wizard would
  // show a single door next to a pair-door item list, and normalization math
  // would produce nonsense quantities.
  let bestSample: ExtractionHealth['bestSample'] = null
  if (populatedSets.length > 0) {
    const best = populatedSets.reduce((a, b) =>
      (a.items?.length ?? 0) >= (b.items?.length ?? 0) ? a : b,
    )
    const headingDoorKeys = new Set(
      (best.heading_doors ?? [])
        .map(d => normalizeDoorNumber(d).toUpperCase())
        .filter(k => k.length > 0),
    )
    let sampleDoor: DoorEntry | undefined = undefined
    if (headingDoorKeys.size > 0) {
      sampleDoor = doors.find(d =>
        headingDoorKeys.has(normalizeDoorNumber(d.door_number).toUpperCase()),
      )
    }
    if (!sampleDoor) {
      // Fallback: heading_doors empty or no match — pick any door on the
      // generic set id. This preserves the old behavior for single-heading
      // sets where heading_doors was never populated.
      sampleDoor = doors.find(
        d => (d.hw_set ?? '').toUpperCase() === (best.generic_set_id ?? best.set_id).toUpperCase(),
      )
    }
    bestSample = {
      set_id: best.set_id,
      heading: best.heading,
      items: best.items,
      door: sampleDoor,
      pdf_page: best.pdf_page ?? null,
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
    // Prefer the pdf_page value already computed on the HardwareSet by
    // StepTriage (which uses the same generic_set_id fallback chain as
    // StepReview). Fall back to findPageForSet on both the specific
    // sub-set id and the generic set id so multi-heading sets like
    // DH4A.0/DH4A.1 always resolve to a page when one is known.
    const samplePageIdx =
      health.bestSample.pdf_page ??
      findPageForSet(health.bestSample.set_id, pages) ??
      null
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

  // ── 5. Quantity questions (batched by item category) ──
  // Group questions that ask the same thing about different sets into one card.
  // e.g., 8 sets with "hinge qty" questions → 1 card, 1 answer, 8 fixes.
  const qtyQuestions = qtyCheck?.questions ?? []
  if (qtyQuestions.length > 0) {
    const groups = new Map<string, typeof qtyQuestions>()
    for (const q of qtyQuestions) {
      // Group key: item_name (lowercased) + same options = same question type
      const key = `${(q.item_name ?? '').toLowerCase()}|${(q.options ?? []).join('|')}`
      const group = groups.get(key) ?? []
      group.push(q)
      groups.set(key, group)
    }

    for (const [, group] of groups) {
      const representative = group[0]
      const setIds = group.map(q => q.set_id)
      const pageIdx = findPageForSet(representative.set_id, pages)

      if (group.length === 1) {
        // Single question — show as individual card
        cards.push({
          id: representative.id,
          kind: 'question',
          title: `${representative.set_id}: ${representative.item_name}`,
          required: true,
          pdfPageIndex: pageIdx,
          payload: { question: representative },
        })
      } else {
        // Batch — one card for N sets with the same question
        cards.push({
          id: `batch-${(representative.item_name ?? '').toLowerCase().replace(/\s+/g, '-')}`,
          kind: 'question_batch',
          title: `${representative.item_name} — ${group.length} sets`,
          required: true,
          pdfPageIndex: pageIdx,
          payload: {
            representative,
            questions: group,
            setIds,
          },
        })
      }
    }
  }

  // ── 6. Compliance issues (batched into one card) ──
  const complianceIssues = qtyCheck?.compliance_issues ?? []
  if (complianceIssues.length > 0) {
    const firstPageIdx = findPageForSet(complianceIssues[0].set_id, pages)
    cards.push({
      id: 'compliance',
      kind: 'compliance',
      title: `${complianceIssues.length} Compliance Issue${complianceIssues.length !== 1 ? 's' : ''}`,
      required: false,
      pdfPageIndex: firstPageIdx,
      payload: { issues: complianceIssues },
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

  // ── 8. Triage questions (batched into one card) ──
  const triageQs = generateTriageQuestions(doors)
  if (triageQs.length > 0) {
    cards.push({
      id: 'triage-questions',
      kind: 'triage_question',
      title: `${triageQs.length} Validation Question${triageQs.length !== 1 ? 's' : ''}`,
      required: false,
      pdfPageIndex: findFirstDoorSchedulePage(pages),
      payload: { questions: triageQs },
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
