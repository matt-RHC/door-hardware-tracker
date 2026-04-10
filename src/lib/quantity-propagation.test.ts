import { describe, it, expect } from 'vitest'
import {
  classifyItemCategory,
  propagateQuantityDecision,
  buildDecisionFromAnswer,
} from './quantity-propagation'
import type { HardwareSet } from '@/lib/types'

// ── Helpers ──

function makeSet(id: string, items: Array<{ name: string; qty: number; qty_source?: string }>): HardwareSet {
  return {
    set_id: id,
    heading: `Set ${id}`,
    items: items.map(i => ({
      name: i.name,
      qty: i.qty,
      qty_source: i.qty_source,
      model: '',
      finish: '',
      manufacturer: '',
    })),
  }
}

// ── classifyItemCategory ──

describe('classifyItemCategory', () => {
  it('classifies hinges', () => {
    expect(classifyItemCategory('Butt Hinge 4.5x4.5')).toBe('hinges')
    expect(classifyItemCategory('Continuous Hinge')).toBe('hinges')
    expect(classifyItemCategory('Spring Hinge')).toBe('hinges')
  })

  it('classifies closers', () => {
    expect(classifyItemCategory('Door Closer LCN 4040XP')).toBe('closer')
    expect(classifyItemCategory('Floor Closer')).toBe('closer')
  })

  it('classifies locksets', () => {
    expect(classifyItemCategory('Mortise Lockset')).toBe('lockset')
    expect(classifyItemCategory('Passage Set')).toBe('lockset')
    expect(classifyItemCategory('Deadbolt')).toBe('lockset')
  })

  it('classifies exit devices', () => {
    expect(classifyItemCategory('Exit Device Von Duprin 98')).toBe('exit_device')
    expect(classifyItemCategory('Panic Hardware')).toBe('exit_device')
  })

  it('classifies coordinators', () => {
    expect(classifyItemCategory('Coordinator')).toBe('coordinator')
  })

  it('classifies thresholds', () => {
    expect(classifyItemCategory('Threshold NGP 896N')).toBe('threshold')
  })

  it('returns null for unknown items', () => {
    expect(classifyItemCategory('Widget XYZ-123')).toBeNull()
  })
})

// ── buildDecisionFromAnswer ──

describe('buildDecisionFromAnswer', () => {
  it('extracts qty from answer starting with a number', () => {
    const d = buildDecisionFromAnswer('DH5', 'Hinges', '4 per leaf (tall/heavy)')
    expect(d).not.toBeNull()
    expect(d?.resolved_qty).toBe(4)
    expect(d?.item_category).toBe('hinges')
    expect(d?.source_set_id).toBe('DH5')
  })

  it('extracts single digit', () => {
    const d = buildDecisionFromAnswer('DH1', 'Closer', '1')
    expect(d?.resolved_qty).toBe(1)
    expect(d?.item_category).toBe('closer')
  })

  it('returns null if answer has no leading number', () => {
    expect(buildDecisionFromAnswer('DH1', 'Hinge', 'Skip')).toBeNull()
    expect(buildDecisionFromAnswer('DH1', 'Hinge', 'Other')).toBeNull()
  })

  it('returns null if item name is unclassifiable', () => {
    expect(buildDecisionFromAnswer('DH1', 'Widget', '3')).toBeNull()
  })
})

// ── propagateQuantityDecision ──

describe('propagateQuantityDecision', () => {
  it('applies decision across matching items in other sets', () => {
    const sets = [
      makeSet('DH1', [{ name: 'Hinge', qty: 6 }]),
      makeSet('DH2', [{ name: 'Butt Hinge', qty: 6 }]),
      makeSet('DH3', [{ name: 'Hinge 4.5x4.5', qty: 9 }]),
    ]

    const result = propagateQuantityDecision(
      { item_category: 'hinges', resolved_qty: 3, source_set_id: 'DH1', reason: 'test' },
      sets,
    )

    // DH1 skipped (source), DH2 and DH3 updated
    expect(result.appliedCount).toBe(2)
    expect(result.modifiedSetIds).toEqual(['DH2', 'DH3'])
    expect(result.updatedSets[1].items[0].qty).toBe(3)
    expect(result.updatedSets[2].items[0].qty).toBe(3)
  })

  it('skips the source set', () => {
    const sets = [
      makeSet('DH1', [{ name: 'Hinge', qty: 6 }]),
      makeSet('DH2', [{ name: 'Hinge', qty: 6 }]),
    ]

    const result = propagateQuantityDecision(
      { item_category: 'hinges', resolved_qty: 3, source_set_id: 'DH1', reason: 'test' },
      sets,
    )

    expect(result.updatedSets[0].items[0].qty).toBe(6) // DH1 unchanged
    expect(result.updatedSets[1].items[0].qty).toBe(3) // DH2 updated
  })

  it('skips already-divided items', () => {
    const sets = [
      makeSet('DH1', [{ name: 'Hinge', qty: 3, qty_source: 'divided' }]),
      makeSet('DH2', [{ name: 'Hinge', qty: 6 }]),
    ]

    const result = propagateQuantityDecision(
      { item_category: 'hinges', resolved_qty: 3, source_set_id: 'DH99', reason: 'test' },
      sets,
    )

    expect(result.updatedSets[0].items[0].qty).toBe(3) // unchanged (divided)
    expect(result.updatedSets[1].items[0].qty).toBe(3) // updated
    expect(result.appliedCount).toBe(1)
  })

  it('skips items that already match the resolved qty', () => {
    const sets = [
      makeSet('DH1', [{ name: 'Hinge', qty: 3 }]),
      makeSet('DH2', [{ name: 'Hinge', qty: 6 }]),
    ]

    const result = propagateQuantityDecision(
      { item_category: 'hinges', resolved_qty: 3, source_set_id: 'DH99', reason: 'test' },
      sets,
    )

    expect(result.appliedCount).toBe(1) // only DH2 changed
    expect(result.modifiedSetIds).toEqual(['DH2'])
  })

  it('only affects items matching the category', () => {
    const sets = [
      makeSet('DH1', [
        { name: 'Hinge', qty: 6 },
        { name: 'Closer', qty: 2 },
      ]),
    ]

    const result = propagateQuantityDecision(
      { item_category: 'hinges', resolved_qty: 3, source_set_id: 'DH99', reason: 'test' },
      sets,
    )

    expect(result.updatedSets[0].items[0].qty).toBe(3)  // hinge updated
    expect(result.updatedSets[0].items[1].qty).toBe(2)  // closer unchanged
  })

  it('returns zero changes when nothing matches', () => {
    const sets = [
      makeSet('DH1', [{ name: 'Widget', qty: 5 }]),
    ]

    const result = propagateQuantityDecision(
      { item_category: 'hinges', resolved_qty: 3, source_set_id: 'DH99', reason: 'test' },
      sets,
    )

    expect(result.appliedCount).toBe(0)
    expect(result.modifiedSetIds).toEqual([])
  })
})
