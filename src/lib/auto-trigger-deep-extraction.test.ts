import { describe, it, expect } from 'vitest'
import {
  shouldAutoTriggerDeepExtraction,
  DEEP_EXTRACTION_AUTO_TRIGGER_THRESHOLD,
} from '@/lib/types/confidence'
import type { ExtractionConfidence } from '@/lib/types/confidence'
import { calculateExtractionConfidence } from '@/lib/parse-pdf-helpers'
import type { HardwareSet, DoorEntry, PunchyCorrections } from '@/lib/types'

// ── Helpers ──────────────────────────────────────────────────────

function makeConfidence(overrides: Partial<ExtractionConfidence> = {}): ExtractionConfidence {
  return {
    overall: 'high',
    score: 85,
    signals: [],
    item_confidence: {},
    suggest_deep_extraction: false,
    deep_extraction_reasons: [],
    ...overrides,
  }
}

function makeItem(
  name: string,
  opts: {
    qty?: number
    manufacturer?: string
    model?: string
    finish?: string
    qty_source?: string
  } = {},
) {
  return {
    name,
    qty: opts.qty ?? 1,
    manufacturer: opts.manufacturer ?? 'Hager',
    model: opts.model ?? '5BB1',
    finish: opts.finish ?? '626',
    qty_source: opts.qty_source,
  }
}

function makeSet(set_id: string, items: ReturnType<typeof makeItem>[]): HardwareSet {
  return {
    set_id,
    heading: `Set ${set_id}`,
    items,
  }
}

function makeDoor(door_number: string, hw_set: string): DoorEntry {
  return {
    door_number,
    hw_set,
    door_type: '',
    frame_type: '',
    fire_rating: '',
    hand: '',
    location: '',
  } as DoorEntry
}

const emptyCorrections: PunchyCorrections = {
  hardware_sets_corrections: [],
  doors_corrections: [],
  missing_doors: [],
  missing_sets: [],
  notes: '',
}

// ── shouldAutoTriggerDeepExtraction unit tests ───────────────────

describe('shouldAutoTriggerDeepExtraction', () => {
  it('test_auto_trigger_low_confidence — score=30 triggers deep extraction', () => {
    const confidence = makeConfidence({
      score: 30,
      overall: 'low',
      suggest_deep_extraction: true,
      deep_extraction_reasons: ['50% of items have empty manufacturer + model (threshold: 30%)'],
    })

    expect(shouldAutoTriggerDeepExtraction(confidence)).toBe(true)
  })

  it('test_no_auto_trigger_high_confidence — score=85 does NOT trigger', () => {
    const confidence = makeConfidence({
      score: 85,
      overall: 'high',
      suggest_deep_extraction: false,
      deep_extraction_reasons: [],
    })

    expect(shouldAutoTriggerDeepExtraction(confidence)).toBe(false)
  })

  it('returns true when suggest_deep_extraction is true even with moderate score', () => {
    const confidence = makeConfidence({
      score: 55,
      overall: 'medium',
      suggest_deep_extraction: true,
      deep_extraction_reasons: ['Punchy flagged 25% of items (threshold: 20%)'],
    })

    expect(shouldAutoTriggerDeepExtraction(confidence)).toBe(true)
  })

  it('returns true when score is below threshold even without suggest_deep_extraction', () => {
    const confidence = makeConfidence({
      score: 35,
      overall: 'low',
      suggest_deep_extraction: false,
      deep_extraction_reasons: [],
    })

    expect(shouldAutoTriggerDeepExtraction(confidence)).toBe(true)
    expect(confidence.score).toBeLessThan(DEEP_EXTRACTION_AUTO_TRIGGER_THRESHOLD.overall_score_below)
  })

  it('does not trigger at score=40 (threshold is strictly below 40)', () => {
    const confidence = makeConfidence({
      score: 40,
      overall: 'low',
      suggest_deep_extraction: false,
      deep_extraction_reasons: [],
    })

    expect(shouldAutoTriggerDeepExtraction(confidence)).toBe(false)
  })

  it('does not trigger at score=41 with no suggestions', () => {
    const confidence = makeConfidence({
      score: 41,
      overall: 'medium',
      suggest_deep_extraction: false,
      deep_extraction_reasons: [],
    })

    expect(shouldAutoTriggerDeepExtraction(confidence)).toBe(false)
  })
})

// ── Integration: calculateExtractionConfidence → shouldAutoTriggerDeepExtraction ──

describe('auto-trigger integration with calculateExtractionConfidence', () => {
  it('test_auto_trigger_empty_fields — >30% empty mfr fields triggers deep extraction', () => {
    // Create 10 items, 4 with empty manufacturer + model (40% > 30% threshold)
    const items = [
      makeItem('Hinge', { manufacturer: '', model: '' }),
      makeItem('Closer', { manufacturer: '', model: '' }),
      makeItem('Lockset', { manufacturer: '', model: '' }),
      makeItem('Kick Plate', { manufacturer: '', model: '' }),
      makeItem('Exit Device', { manufacturer: 'Von Duprin', model: '99EO' }),
      makeItem('Door Stop', { manufacturer: 'Ives', model: 'FS41' }),
      makeItem('Seal', { manufacturer: 'Pemko', model: 'S44' }),
      makeItem('Threshold', { manufacturer: 'Pemko', model: '272' }),
      makeItem('Smoke Seal', { manufacturer: 'Pemko', model: 'SS10' }),
      makeItem('Weatherstrip', { manufacturer: 'Pemko', model: '315' }),
    ]
    const sets = [makeSet('DH1', items)]
    const doors = [makeDoor('101', 'DH1')]

    const confidence = calculateExtractionConfidence(sets, doors, emptyCorrections)

    expect(confidence.suggest_deep_extraction).toBe(true)
    expect(confidence.deep_extraction_reasons.length).toBeGreaterThan(0)
    expect(confidence.deep_extraction_reasons.some(r => r.includes('empty manufacturer'))).toBe(true)
    expect(shouldAutoTriggerDeepExtraction(confidence)).toBe(true)
  })

  it('high-quality extraction does not trigger deep extraction', () => {
    const sets = [
      makeSet('DH1', [
        makeItem('Hinge', { manufacturer: 'Hager', model: '5BB1', finish: '626' }),
        makeItem('Closer', { manufacturer: 'LCN', model: '4040XP', finish: '689' }),
        makeItem('Lockset', { manufacturer: 'Schlage', model: 'L9010', finish: '626' }),
      ]),
    ]
    const doors = [makeDoor('101', 'DH1'), makeDoor('102', 'DH1')]

    const confidence = calculateExtractionConfidence(sets, doors, emptyCorrections)

    expect(confidence.suggest_deep_extraction).toBe(false)
    expect(confidence.score).toBeGreaterThanOrEqual(80)
    expect(shouldAutoTriggerDeepExtraction(confidence)).toBe(false)
  })

  it('test_job_upgrade_in_place — fuzzy corrections >50% triggers deep extraction', () => {
    const sets = [
      makeSet('DH1', [
        makeItem('Hinge'),
        makeItem('Closer'),
      ]),
    ]
    const doors = [makeDoor('101', 'DH1')]

    // All corrections are fuzzy (low confidence)
    const corrections: PunchyCorrections = {
      hardware_sets_corrections: [{
        set_id: 'DH1',
        items_to_fix: [
          { name: 'Hinge', field: 'model', old_value: '5B1', new_value: '5BB1', confidence: 'low' },
          { name: 'Closer', field: 'model', old_value: '404XP', new_value: '4040XP', confidence: 'low' },
        ],
      }],
    }

    const confidence = calculateExtractionConfidence(sets, doors, corrections)

    // 100% of corrections are fuzzy, well above 50% threshold
    expect(confidence.suggest_deep_extraction).toBe(true)
    expect(confidence.deep_extraction_reasons.some(r => r.includes('fuzzy matching'))).toBe(true)
    expect(shouldAutoTriggerDeepExtraction(confidence)).toBe(true)
  })

  it('Punchy flagging >20% of items triggers deep extraction', () => {
    // 3 items, all 3 flagged (100% > 20% threshold)
    const sets = [
      makeSet('DH1', [
        makeItem('Hinge'),
        makeItem('Closer'),
        makeItem('Lockset'),
      ]),
    ]
    const doors = [makeDoor('101', 'DH1')]

    const corrections: PunchyCorrections = {
      hardware_sets_corrections: [{
        set_id: 'DH1',
        items_to_fix: [
          { name: 'Hinge', field: 'qty', old_value: '6', new_value: '3' },
        ],
        items_to_add: [
          { name: 'Weatherstrip', qty: 1, manufacturer: 'Pemko', model: '315', finish: '626' },
        ],
        items_to_remove: ['Lockset'],
      }],
    }

    const confidence = calculateExtractionConfidence(sets, doors, corrections)

    expect(confidence.suggest_deep_extraction).toBe(true)
    expect(confidence.deep_extraction_reasons.some(r => r.includes('flagged'))).toBe(true)
    expect(shouldAutoTriggerDeepExtraction(confidence)).toBe(true)
  })

  it('borderline case: exactly 30% empty mfr does NOT trigger (threshold is strictly >30%)', () => {
    // 10 items, exactly 3 with empty mfr+model = 30% (not >30%)
    const items = [
      makeItem('Hinge', { manufacturer: '', model: '' }),
      makeItem('Closer', { manufacturer: '', model: '' }),
      makeItem('Lockset', { manufacturer: '', model: '' }),
      makeItem('Exit Device', { manufacturer: 'Von Duprin', model: '99EO' }),
      makeItem('Door Stop', { manufacturer: 'Ives', model: 'FS41' }),
      makeItem('Seal', { manufacturer: 'Pemko', model: 'S44' }),
      makeItem('Threshold', { manufacturer: 'Pemko', model: '272' }),
      makeItem('Smoke Seal', { manufacturer: 'Pemko', model: 'SS10' }),
      makeItem('Weatherstrip', { manufacturer: 'Pemko', model: '315' }),
      makeItem('Kick Plate', { manufacturer: 'Ives', model: 'KP10' }),
    ]
    const sets = [makeSet('DH1', items)]
    const doors = [makeDoor('101', 'DH1')]

    const confidence = calculateExtractionConfidence(sets, doors, emptyCorrections)

    // Exactly 30% — the check is > 0.3, so this should NOT trigger the empty-field reason
    expect(confidence.deep_extraction_reasons.some(r => r.includes('empty manufacturer'))).toBe(false)
  })
})

// ── Threshold constants validation ──────────────────────────────

describe('DEEP_EXTRACTION_AUTO_TRIGGER_THRESHOLD', () => {
  it('has expected threshold values', () => {
    expect(DEEP_EXTRACTION_AUTO_TRIGGER_THRESHOLD.empty_field_pct).toBe(0.30)
    expect(DEEP_EXTRACTION_AUTO_TRIGGER_THRESHOLD.fuzzy_correction_pct).toBe(0.50)
    expect(DEEP_EXTRACTION_AUTO_TRIGGER_THRESHOLD.punchy_flag_pct).toBe(0.20)
    expect(DEEP_EXTRACTION_AUTO_TRIGGER_THRESHOLD.overall_score_below).toBe(40)
  })
})
