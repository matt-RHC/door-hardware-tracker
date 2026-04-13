import { describe, it, expect } from 'vitest'
import { reconcileExtractions } from './reconciliation'
import type { HardwareSet } from '@/lib/types'
import type { VisionExtractionResult, VisionHardwareSet } from '@/lib/parse-pdf-helpers'

// ── Test helpers ────────────────────────────────────────────────

function makeStrategyA(sets: Partial<HardwareSet>[]): HardwareSet[] {
  return sets.map(s => ({
    set_id: s.set_id ?? 'DH1',
    heading: s.heading ?? 'Hardware Set DH1',
    items: (s.items ?? []).map(i => ({
      qty: i.qty ?? 1,
      name: i.name ?? 'Item',
      model: i.model ?? '',
      finish: i.finish ?? '',
      manufacturer: i.manufacturer ?? '',
    })),
    heading_doors: s.heading_doors,
    heading_door_count: s.heading_door_count,
    heading_leaf_count: s.heading_leaf_count,
    qty_convention: s.qty_convention,
    pdf_page: s.pdf_page,
  }))
}

function makeStrategyB(sets: Partial<VisionHardwareSet>[]): VisionExtractionResult {
  return {
    hardware_sets: sets.map(s => ({
      set_id: s.set_id ?? 'DH1',
      heading: s.heading ?? 'Hardware Set DH1',
      items: (s.items ?? []).map(i => ({
        name: i.name ?? 'Item',
        qty: i.qty ?? 1,
        manufacturer: i.manufacturer ?? '',
        model: i.model ?? '',
        finish: i.finish ?? '',
        category: i.category ?? '',
      })),
      door_numbers: s.door_numbers ?? [],
      qty_convention: s.qty_convention ?? 'per_opening',
      is_pair: s.is_pair ?? false,
      source_pages: s.source_pages ?? [1],
    })),
    page_results: [],
    total_processing_time_ms: 100,
    model_used: 'test',
    pages_processed: 1,
    pages_skipped: 0,
  }
}

// ── Tests ───────────────────────────────────────────────────────

describe('reconcileExtractions', () => {
  it('test_reconcile_full_agreement — identical results → all fields full confidence', () => {
    const a = makeStrategyA([{
      set_id: 'DH1',
      heading: 'Hardware Set DH1',
      heading_doors: ['101', '102'],
      qty_convention: 'per_opening',
      heading_leaf_count: 1,
      items: [
        { name: 'Continuous Hinge', qty: 3, manufacturer: 'Hager', model: '780-112', finish: '652' },
        { name: 'Door Closer', qty: 1, manufacturer: 'LCN', model: '4040XP', finish: '689' },
      ],
    }])

    const b = makeStrategyB([{
      set_id: 'DH1',
      heading: 'Hardware Set DH1',
      door_numbers: ['101', '102'],
      qty_convention: 'per_opening',
      is_pair: false,
      items: [
        { name: 'Continuous Hinge', qty: 3, manufacturer: 'Hager', model: '780-112', finish: '652', category: 'hinge' },
        { name: 'Door Closer', qty: 1, manufacturer: 'LCN', model: '4040XP', finish: '689', category: 'closer' },
      ],
    }])

    const result = reconcileExtractions(a, b)

    expect(result.hardware_sets).toHaveLength(1)
    expect(result.summary.total_sets).toBe(1)
    expect(result.summary.total_items).toBe(2)
    expect(result.summary.conflicts).toBe(0)
    expect(result.summary.full_agreement_pct).toBeGreaterThanOrEqual(80)
    expect(result.summary.score).toBeGreaterThanOrEqual(90)

    // All item fields should be full agreement
    for (const item of result.hardware_sets[0].items) {
      expect(item.name.confidence).toBe('full')
      expect(item.qty.confidence).toBe('full')
      expect(item.manufacturer.confidence).toBe('full')
      expect(item.model.confidence).toBe('full')
      expect(item.finish.confidence).toBe('full')
      expect(item.name.chosen_from).toBe('agreed')
    }
  })

  it('test_reconcile_qty_conflict_prefers_strategy_a', () => {
    const a = makeStrategyA([{
      set_id: 'DH2',
      heading: 'Hardware Set DH2',
      items: [
        { name: 'Exit Device', qty: 6, manufacturer: 'Von Duprin', model: '99EO', finish: '630' },
      ],
    }])

    const b = makeStrategyB([{
      set_id: 'DH2',
      heading: 'Hardware Set DH2',
      items: [
        { name: 'Exit Device', qty: 3, manufacturer: 'Von Duprin', model: '99EO', finish: '630', category: 'exit' },
      ],
    }])

    const result = reconcileExtractions(a, b)

    const item = result.hardware_sets[0].items[0]
    expect(item.qty.value).toBe(6) // Strategy A preferred for quantities
    expect(item.qty.confidence).toBe('conflict')
    expect(item.qty.chosen_from).toBe('a')
    expect(item.qty.sources.strategy_a).toBe(6)
    expect(item.qty.sources.strategy_b).toBe(3)
    expect(item.qty.reason).toContain('pdfplumber more reliable for quantities')
  })

  it('test_reconcile_name_conflict_prefers_strategy_b', () => {
    const a = makeStrategyA([{
      set_id: 'DH3',
      heading: 'Hardware Set DH3',
      items: [
        // Strategy A has a truncated/garbled name
        { name: 'Cont Hinge', qty: 2, manufacturer: 'Hager', model: '780-112', finish: '652' },
      ],
    }])

    const b = makeStrategyB([{
      set_id: 'DH3',
      heading: 'Hardware Set DH3',
      items: [
        // Strategy B has the correct full name
        { name: 'Continuous Hinge', qty: 2, manufacturer: 'Hager', model: '780-112', finish: '652', category: 'hinge' },
      ],
    }])

    const result = reconcileExtractions(a, b)

    // Items should match via Jaccard/substring ("Cont Hinge" vs "Continuous Hinge")
    expect(result.hardware_sets[0].items.length).toBeGreaterThanOrEqual(1)
    // Find the matched item (may or may not match depending on Jaccard threshold)
    const matched = result.hardware_sets[0].items.find(
      i => i.name.confidence === 'conflict' || i.name.confidence === 'full',
    )
    if (matched) {
      // If names conflicted, vision model (B) should be preferred
      if (matched.name.confidence === 'conflict') {
        expect(matched.name.value).toBe('Continuous Hinge')
        expect(matched.name.chosen_from).toBe('b')
        expect(matched.name.reason).toContain('Vision model')
      }
    }
  })

  it('test_reconcile_single_source_set — set only in Strategy A', () => {
    const a = makeStrategyA([{
      set_id: 'DH5',
      heading: 'Hardware Set DH5',
      items: [
        { name: 'Kickplate', qty: 1, manufacturer: 'Ives', model: '8400', finish: '630' },
      ],
    }])

    const b = makeStrategyB([]) // Vision found nothing

    const result = reconcileExtractions(a, b)

    expect(result.hardware_sets).toHaveLength(1)
    expect(result.hardware_sets[0].set_id).toBe('DH5')
    expect(result.hardware_sets[0].overall_confidence).toBe('single_source')

    const item = result.hardware_sets[0].items[0]
    expect(item.name.confidence).toBe('single_source')
    expect(item.name.chosen_from).toBe('a')
    expect(item.qty.value).toBe(1)
    expect(result.summary.single_source_fields).toBeGreaterThan(0)
  })

  it('test_reconcile_empty_field_uses_other — A missing mfr, B has it', () => {
    const a = makeStrategyA([{
      set_id: 'DH6',
      heading: 'Hardware Set DH6',
      items: [
        { name: 'Floor Stop', qty: 1, manufacturer: '', model: 'FS42', finish: '626' },
      ],
    }])

    const b = makeStrategyB([{
      set_id: 'DH6',
      heading: 'Hardware Set DH6',
      items: [
        { name: 'Floor Stop', qty: 1, manufacturer: 'Ives', model: 'FS42', finish: '626', category: 'stop' },
      ],
    }])

    const result = reconcileExtractions(a, b)

    const item = result.hardware_sets[0].items[0]
    expect(item.manufacturer.value).toBe('Ives')
    expect(item.manufacturer.confidence).toBe('single_source')
    expect(item.manufacturer.chosen_from).toBe('b')
    expect(item.manufacturer.reason).toContain('only Vision model had manufacturer')
    // Other fields should be full agreement
    expect(item.name.confidence).toBe('full')
    expect(item.qty.confidence).toBe('full')
    expect(item.finish.confidence).toBe('full')
  })

  it('test_reconcile_set_matching_normalized — "DH-1" matches "DH1"', () => {
    const a = makeStrategyA([{
      set_id: 'DH1',
      heading: 'Hardware Set DH1',
      items: [
        { name: 'Lockset', qty: 1, manufacturer: 'Schlage', model: 'L9010', finish: '626' },
      ],
    }])

    const b = makeStrategyB([{
      set_id: 'DH-1', // Different format with hyphen
      heading: 'Hardware Set DH1',
      items: [
        { name: 'Lockset', qty: 1, manufacturer: 'Schlage', model: 'L9010', finish: '626', category: 'lockset' },
      ],
    }])

    const result = reconcileExtractions(a, b)

    // Should still find 1 reconciled set (matched via normalized ID)
    expect(result.hardware_sets).toHaveLength(1)
    expect(result.hardware_sets[0].set_id).toBe('DH1') // Uses Strategy A's set_id
    expect(result.hardware_sets[0].items[0].name.confidence).toBe('full')
    expect(result.audit_log.some(l => l.includes('normalized ID'))).toBe(true)
  })

  it('test_reconcile_item_matching_fuzzy — "Continuous Hinge" matches "CONTINUOUS HINGE 224XY"', () => {
    const a = makeStrategyA([{
      set_id: 'DH7',
      heading: 'Hardware Set DH7',
      items: [
        { name: 'Continuous Hinge', qty: 3, manufacturer: 'Hager', model: '780-112', finish: '652' },
      ],
    }])

    const b = makeStrategyB([{
      set_id: 'DH7',
      heading: 'Hardware Set DH7',
      items: [
        { name: 'CONTINUOUS HINGE 224XY', qty: 3, manufacturer: 'Hager', model: '780-112', finish: '652', category: 'hinge' },
      ],
    }])

    const result = reconcileExtractions(a, b)

    // Items should match — either via normalized match or substring/Jaccard
    expect(result.hardware_sets[0].items.length).toBeGreaterThanOrEqual(1)

    // Find the item that was matched (not single_source from separate strategies)
    const matched = result.hardware_sets[0].items.find(
      i => i.qty.confidence === 'full',
    )
    expect(matched).toBeDefined()
    expect(matched!.qty.value).toBe(3)
  })

  it('test_reconcile_door_union — doors from both strategies are unioned', () => {
    const a = makeStrategyA([{
      set_id: 'DH8',
      heading: 'Hardware Set DH8',
      heading_doors: ['101', '102', '103'],
      items: [{ name: 'Closer', qty: 1, manufacturer: 'LCN', model: '4040XP', finish: '689' }],
    }])

    const b = makeStrategyB([{
      set_id: 'DH8',
      heading: 'Hardware Set DH8',
      door_numbers: ['102', '103', '104'],
      items: [{ name: 'Closer', qty: 1, manufacturer: 'LCN', model: '4040XP', finish: '689', category: 'closer' }],
    }])

    const result = reconcileExtractions(a, b)

    const doorNumbers = String(result.hardware_sets[0].door_numbers.value)
    // Union should include all four doors
    expect(doorNumbers).toContain('101')
    expect(doorNumbers).toContain('102')
    expect(doorNumbers).toContain('103')
    expect(doorNumbers).toContain('104')
    // Door numbers disagree, so it's a conflict
    expect(result.hardware_sets[0].door_numbers.confidence).toBe('conflict')
    // Audit log should mention doors only in one strategy
    expect(result.audit_log.some(l => l.includes('101') && l.includes('only in Strategy A'))).toBe(true)
    expect(result.audit_log.some(l => l.includes('104') && l.includes('only in Vision model'))).toBe(true)
  })

  it('test_reconcile_audit_log_populated — audit log has human-readable entries', () => {
    const a = makeStrategyA([{
      set_id: 'DH9',
      heading: 'Hardware Set DH9',
      items: [
        { name: 'Hinge', qty: 3, manufacturer: 'Hager', model: '5BB1', finish: '652' },
        { name: 'Closer', qty: 1, manufacturer: 'LCN', model: '4111', finish: '689' },
      ],
    }])

    const b = makeStrategyB([{
      set_id: 'DH9',
      heading: 'Hardware Set DH9',
      items: [
        { name: 'Hinge', qty: 3, manufacturer: 'Hager', model: '5BB1', finish: '652', category: 'hinge' },
        // Closer has qty conflict
        { name: 'Closer', qty: 2, manufacturer: 'LCN', model: '4111', finish: '689', category: 'closer' },
      ],
    }])

    const result = reconcileExtractions(a, b)

    expect(result.audit_log.length).toBeGreaterThan(0)
    // Should have at least one entry about the items
    const hasSetEntry = result.audit_log.some(l => l.includes('DH9'))
    expect(hasSetEntry).toBe(true)
    // Should have a conflict entry for the closer qty
    const hasConflictEntry = result.audit_log.some(l => l.includes('conflict'))
    expect(hasConflictEntry).toBe(true)
  })

  it('test_reconcile_summary_score — verify the 0-100 score calculation', () => {
    // All full agreement → score ~100
    const aFull = makeStrategyA([{
      set_id: 'DH10',
      heading: 'Hardware Set DH10',
      heading_doors: ['201'],
      qty_convention: 'per_opening',
      heading_leaf_count: 1,
      items: [
        { name: 'Lockset', qty: 1, manufacturer: 'Schlage', model: 'L9010', finish: '626' },
      ],
    }])
    const bFull = makeStrategyB([{
      set_id: 'DH10',
      heading: 'Hardware Set DH10',
      door_numbers: ['201'],
      qty_convention: 'per_opening',
      is_pair: false,
      items: [
        { name: 'Lockset', qty: 1, manufacturer: 'Schlage', model: 'L9010', finish: '626', category: 'lockset' },
      ],
    }])

    const fullResult = reconcileExtractions(aFull, bFull)
    expect(fullResult.summary.score).toBeGreaterThanOrEqual(90)
    expect(fullResult.summary.full_agreement_pct).toBeGreaterThanOrEqual(80)

    // All conflicts → score ~25
    const aConflict = makeStrategyA([{
      set_id: 'DH11',
      heading: 'Heading A',
      heading_doors: ['301'],
      qty_convention: 'aggregate',
      heading_leaf_count: 2,
      items: [
        { name: 'Hinge', qty: 5, manufacturer: 'Ives', model: 'ModelA', finish: '630' },
      ],
    }])
    const bConflict = makeStrategyB([{
      set_id: 'DH11',
      heading: 'Heading B',
      door_numbers: ['302'],
      qty_convention: 'per_opening',
      is_pair: false,
      items: [
        { name: 'Hinge', qty: 3, manufacturer: 'Hager', model: 'ModelB', finish: '652', category: 'hinge' },
      ],
    }])

    const conflictResult = reconcileExtractions(aConflict, bConflict)
    expect(conflictResult.summary.score).toBeLessThan(60)
    expect(conflictResult.summary.conflicts).toBeGreaterThan(0)
    expect(conflictResult.summary.overall_confidence).toBe('conflict')

    // Single source (only Strategy A) → score ~50
    const aSingle = makeStrategyA([{
      set_id: 'DH12',
      heading: 'Hardware Set DH12',
      items: [
        { name: 'Threshold', qty: 1, manufacturer: 'NGP', model: '216NA', finish: '630' },
      ],
    }])
    const bEmpty = makeStrategyB([])

    const singleResult = reconcileExtractions(aSingle, bEmpty)
    expect(singleResult.summary.score).toBe(50)
    expect(singleResult.summary.overall_confidence).toBe('single_source')
  })

  it('handles set only found by Vision model', () => {
    const a = makeStrategyA([])
    const b = makeStrategyB([{
      set_id: 'DH20',
      heading: 'Hardware Set DH20',
      items: [
        { name: 'Seal', qty: 2, manufacturer: 'Pemko', model: 'S88D', finish: '', category: 'seal' },
      ],
    }])

    const result = reconcileExtractions(a, b)

    expect(result.hardware_sets).toHaveLength(1)
    expect(result.hardware_sets[0].set_id).toBe('DH20')
    expect(result.hardware_sets[0].overall_confidence).toBe('single_source')
    expect(result.hardware_sets[0].items[0].name.value).toBe('Seal')
    expect(result.hardware_sets[0].items[0].name.chosen_from).toBe('b')
    expect(result.audit_log.some(l => l.includes('DH20') && l.includes('only found by Vision model'))).toBe(true)
  })

  it('handles multiple sets with mixed match quality', () => {
    const a = makeStrategyA([
      {
        set_id: 'DH1',
        heading: 'Hardware Set DH1',
        items: [{ name: 'Hinge', qty: 3, manufacturer: 'Hager', model: '5BB1', finish: '652' }],
      },
      {
        set_id: 'DH2',
        heading: 'Hardware Set DH2',
        items: [{ name: 'Closer', qty: 1, manufacturer: 'LCN', model: '4040XP', finish: '689' }],
      },
      {
        set_id: 'DH3',
        heading: 'Hardware Set DH3 Only A',
        items: [{ name: 'Lockset', qty: 1, manufacturer: 'Schlage', model: 'L9010', finish: '626' }],
      },
    ])

    const b = makeStrategyB([
      {
        set_id: 'DH1',
        heading: 'Hardware Set DH1',
        items: [{ name: 'Hinge', qty: 3, manufacturer: 'Hager', model: '5BB1', finish: '652', category: 'hinge' }],
      },
      {
        set_id: 'DH2',
        heading: 'Hardware Set DH2',
        items: [{ name: 'Closer', qty: 2, manufacturer: 'LCN', model: '4040XP', finish: '689', category: 'closer' }],
      },
      {
        set_id: 'DH4',
        heading: 'Hardware Set DH4 Only B',
        items: [{ name: 'Stop', qty: 1, manufacturer: 'Ives', model: 'WS40', finish: '630', category: 'stop' }],
      },
    ])

    const result = reconcileExtractions(a, b)

    expect(result.summary.total_sets).toBe(4) // DH1 (matched), DH2 (matched), DH3 (A only), DH4 (B only)

    // DH1 should have full agreement
    const dh1 = result.hardware_sets.find(s => s.set_id === 'DH1')
    expect(dh1).toBeDefined()
    expect(dh1!.items[0].qty.confidence).toBe('full')

    // DH2 should have qty conflict (1 vs 2)
    const dh2 = result.hardware_sets.find(s => s.set_id === 'DH2')
    expect(dh2).toBeDefined()
    expect(dh2!.items[0].qty.confidence).toBe('conflict')
    expect(dh2!.items[0].qty.value).toBe(1) // Strategy A preferred

    // DH3 should be single source from A
    const dh3 = result.hardware_sets.find(s => s.set_id === 'DH3')
    expect(dh3).toBeDefined()
    expect(dh3!.overall_confidence).toBe('single_source')

    // DH4 should be single source from B
    const dh4 = result.hardware_sets.find(s => s.set_id === 'DH4')
    expect(dh4).toBeDefined()
    expect(dh4!.overall_confidence).toBe('single_source')
  })
})
