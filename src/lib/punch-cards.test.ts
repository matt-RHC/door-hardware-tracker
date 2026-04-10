import { describe, it, expect } from 'vitest'
import {
  generatePunchCards,
  computeExtractionHealth,
  findPageForSet,
} from './punch-cards'
import type { DoorEntry, HardwareSet, PunchyQuantityCheck, PageClassification } from '@/lib/types'

// ── Helpers ──

function makeSet(id: string, itemCount: number, heading = ''): HardwareSet {
  return {
    set_id: id,
    heading: heading || `Heading ${id}`,
    items: Array.from({ length: itemCount }, (_, i) => ({
      name: `Item ${i + 1}`,
      qty: 1,
      model: '',
      finish: '',
      manufacturer: '',
    })),
  }
}

function makeDoor(num: string, hwSet: string): DoorEntry {
  return {
    door_number: num,
    hw_set: hwSet,
    location: '',
    door_type: '',
    frame_type: '',
    fire_rating: '',
    hand: '',
  } as DoorEntry
}

const NO_QTY_CHECK: PunchyQuantityCheck = {
  flags: [],
  compliance_issues: [],
}

// ── Tests ──

describe('computeExtractionHealth', () => {
  it('reports grade "good" when all sets have items', () => {
    const sets = [makeSet('DH1', 5), makeSet('DH2', 3)]
    const doors = [makeDoor('101', 'DH1'), makeDoor('102', 'DH2')]
    const health = computeExtractionHealth(doors, sets)

    expect(health.grade).toBe('good')
    expect(health.emptySets).toHaveLength(0)
    expect(health.totalItems).toBe(8)
  })

  it('reports grade "warning" when some sets are empty', () => {
    const sets = [makeSet('DH1', 5), makeSet('DH2', 0)]
    const doors = [makeDoor('101', 'DH1'), makeDoor('102', 'DH2')]
    const health = computeExtractionHealth(doors, sets)

    expect(health.grade).toBe('warning')
    expect(health.emptySets).toHaveLength(1)
  })

  it('reports grade "critical" when ALL sets are empty', () => {
    const sets = [makeSet('DH1', 0), makeSet('DH2', 0)]
    const doors = [makeDoor('101', 'DH1')]
    const health = computeExtractionHealth(doors, sets)

    expect(health.grade).toBe('critical')
  })

  it('detects missing set IDs referenced by doors but not extracted', () => {
    const sets = [makeSet('DH1', 5)]
    const doors = [makeDoor('101', 'DH1'), makeDoor('102', 'DH3')]
    const health = computeExtractionHealth(doors, sets)

    expect(health.missingSetIds).toContain('DH3')
    expect(health.grade).toBe('warning')
  })

  it('picks the best sample as the set with the most items', () => {
    const sets = [makeSet('DH1', 3), makeSet('DH2', 10), makeSet('DH3', 5)]
    const doors = [makeDoor('101', 'DH1'), makeDoor('102', 'DH2')]
    const health = computeExtractionHealth(doors, sets)

    expect(health.bestSample?.set_id).toBe('DH2')
  })
})

describe('findPageForSet', () => {
  const pages: PageClassification[] = [
    { page_number: 0, page_type: 'door_schedule', confidence: 1 },
    { page_number: 5, page_type: 'hardware_set', confidence: 1, hw_set_ids: ['DH1', 'DH2'] },
    { page_number: 8, page_type: 'hardware_set', confidence: 1, hw_set_ids: ['DH3'] },
  ]

  it('finds the page containing a set ID', () => {
    expect(findPageForSet('DH1', pages)).toBe(5)
    expect(findPageForSet('DH3', pages)).toBe(8)
  })

  it('is case-insensitive', () => {
    expect(findPageForSet('dh2', pages)).toBe(5)
  })

  it('returns null for unknown sets', () => {
    expect(findPageForSet('DH99', pages)).toBeNull()
  })
})

describe('generatePunchCards', () => {
  it('always produces summary as first card and ready as last', () => {
    const cards = generatePunchCards({
      doors: [makeDoor('101', 'DH1')],
      hardwareSets: [makeSet('DH1', 5)],
      qtyCheck: NO_QTY_CHECK,
      pages: [],
    })

    expect(cards[0].kind).toBe('summary')
    expect(cards[cards.length - 1].kind).toBe('ready')
  })

  it('generates empty_sets card when sets have no items', () => {
    const cards = generatePunchCards({
      doors: [makeDoor('101', 'DH1')],
      hardwareSets: [makeSet('DH1', 5), makeSet('DH2', 0)],
      qtyCheck: NO_QTY_CHECK,
      pages: [],
    })

    const emptyCard = cards.find(c => c.kind === 'empty_sets')
    expect(emptyCard).toBeDefined()
    expect(emptyCard?.title).toContain('1 Set')
  })

  it('generates calibration card when empty sets + sample available', () => {
    const cards = generatePunchCards({
      doors: [makeDoor('101', 'DH1')],
      hardwareSets: [makeSet('DH1', 5), makeSet('DH2', 0)],
      qtyCheck: NO_QTY_CHECK,
      pages: [],
    })

    const calCard = cards.find(c => c.kind === 'calibration')
    expect(calCard).toBeDefined()
  })

  it('batches auto-corrections into one card', () => {
    const qtyCheck: PunchyQuantityCheck = {
      auto_corrections: [
        { set_id: 'DH1', item_name: 'Hinges', from_qty: 6, to_qty: 3, reason: 'test', confidence: 'high' },
        { set_id: 'DH2', item_name: 'Hinges', from_qty: 6, to_qty: 3, reason: 'test', confidence: 'high' },
      ],
      flags: [],
      compliance_issues: [],
    }
    const cards = generatePunchCards({
      doors: [makeDoor('101', 'DH1')],
      hardwareSets: [makeSet('DH1', 5)],
      qtyCheck,
      pages: [],
    })

    const corrCard = cards.find(c => c.kind === 'auto_correction')
    expect(corrCard).toBeDefined()
    expect(corrCard?.title).toContain('2 Quantity Corrections')
  })

  // ── Card Batching ──

  it('batches quantity questions with same item+options into one card', () => {
    const qtyCheck: PunchyQuantityCheck = {
      questions: [
        { id: 'q1', set_id: 'DH1', item_name: 'Hinges', text: 'How many?', options: ['3', '4'], current_qty: 6, context: '' },
        { id: 'q2', set_id: 'DH2', item_name: 'Hinges', text: 'How many?', options: ['3', '4'], current_qty: 6, context: '' },
        { id: 'q3', set_id: 'DH3', item_name: 'Hinges', text: 'How many?', options: ['3', '4'], current_qty: 6, context: '' },
      ],
      flags: [],
      compliance_issues: [],
    }
    const cards = generatePunchCards({
      doors: [makeDoor('101', 'DH1')],
      hardwareSets: [makeSet('DH1', 5)],
      qtyCheck,
      pages: [],
    })

    const batchCards = cards.filter(c => c.kind === 'question_batch')
    expect(batchCards).toHaveLength(1)
    expect(batchCards[0].title).toContain('3 sets')
    expect((batchCards[0].payload.setIds as string[])).toEqual(['DH1', 'DH2', 'DH3'])
  })

  it('keeps unique questions as individual cards', () => {
    const qtyCheck: PunchyQuantityCheck = {
      questions: [
        { id: 'q1', set_id: 'DH1', item_name: 'Hinges', text: 'How many hinges?', options: ['3', '4'], current_qty: 6, context: '' },
        { id: 'q2', set_id: 'DH2', item_name: 'Closer', text: 'How many closers?', options: ['1', '2'], current_qty: 4, context: '' },
      ],
      flags: [],
      compliance_issues: [],
    }
    const cards = generatePunchCards({
      doors: [makeDoor('101', 'DH1')],
      hardwareSets: [makeSet('DH1', 5)],
      qtyCheck,
      pages: [],
    })

    const questionCards = cards.filter(c => c.kind === 'question')
    expect(questionCards).toHaveLength(2)
    const batchCards = cards.filter(c => c.kind === 'question_batch')
    expect(batchCards).toHaveLength(0)
  })

  it('batches compliance issues into one card', () => {
    const qtyCheck: PunchyQuantityCheck = {
      compliance_issues: [
        { set_id: 'DH1', issue: 'No closer on fire door', regulation: 'NFPA 80', severity: 'error' },
        { set_id: 'DH3', issue: 'Missing smoke seal', regulation: 'NFPA 80', severity: 'warning' },
      ],
      flags: [],
    }
    const cards = generatePunchCards({
      doors: [makeDoor('101', 'DH1')],
      hardwareSets: [makeSet('DH1', 5)],
      qtyCheck,
      pages: [],
    })

    const compCards = cards.filter(c => c.kind === 'compliance')
    expect(compCards).toHaveLength(1)
    expect(compCards[0].title).toContain('2 Compliance')
  })

  it('batches triage questions into one card', () => {
    // generateTriageQuestions creates questions from doors with suspicious patterns.
    // Give it doors that trigger questions.
    const doors = [
      makeDoor('ABC123', 'DH1'),  // suspicious: looks like a product code
      makeDoor('DEF456', 'DH1'),
      makeDoor('GHI789', 'DH1'),
      makeDoor('101', ''),        // empty hw_set triggers question
    ]
    const cards = generatePunchCards({
      doors,
      hardwareSets: [makeSet('DH1', 5)],
      qtyCheck: NO_QTY_CHECK,
      pages: [],
    })

    const triageCards = cards.filter(c => c.kind === 'triage_question')
    expect(triageCards.length).toBeLessThanOrEqual(1)
  })

  it('produces minimal cards when extraction is clean', () => {
    const cards = generatePunchCards({
      doors: [makeDoor('101', 'DH1'), makeDoor('102', 'DH2')],
      hardwareSets: [makeSet('DH1', 5), makeSet('DH2', 3)],
      qtyCheck: NO_QTY_CHECK,
      pages: [],
    })

    // Should be just: summary + ready (no issues to review)
    expect(cards.length).toBe(2)
    expect(cards[0].kind).toBe('summary')
    expect(cards[1].kind).toBe('ready')
  })
})
