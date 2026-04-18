/**
 * Regression test — 110-01B / DH1 pair-leaf hinge ghost.
 *
 * Originally written as a diagnosis reproducer; flipped to lock in the
 * consolidatePairLeafHingeRows fix (hardware-taxonomy.ts).
 *
 * Ground truth (Matthew, 2026-04-18): on 110-01B / DH1 the active leaf
 * carries 3 standard + 1 electric hinge = 4 total positions, the inactive
 * leaf carries 4 standard hinges. Opening total = 8 hinge positions.
 */

import { describe, it, expect } from 'vitest'
import { buildPerOpeningItems } from './parse-pdf-helpers'
import { consolidatePairLeafHingeRows } from './hardware-taxonomy'
import type { HardwareSet } from '@/lib/types'

const DH1_HINGE_MODEL = '5BB1 HW 4 1/2 × 4 1/2 NRP'
const ELEC_HINGE_MODEL = '5BB1 HW 4 1/2 × 4 1/2 CON TW8'

function makeDh1LikeSet(): HardwareSet {
  return {
    set_id: 'DH1',
    generic_set_id: 'DH1',
    heading: 'Set DH1',
    heading_door_count: 1,
    heading_leaf_count: 2,
    heading_doors: ['110-01B'],
    items: [
      { qty: 3, name: 'Hinges', model: DH1_HINGE_MODEL, finish: '626', manufacturer: 'Ives' },
      { qty: 4, name: 'Hinges', model: DH1_HINGE_MODEL, finish: '626', manufacturer: 'Ives' },
      { qty: 1, name: 'Hinges', model: ELEC_HINGE_MODEL, finish: '626', manufacturer: 'Ives' },
    ],
  }
}

// ── Integration: full buildPerOpeningItems output after the fix ─────────────

describe('regression: 110-01B / DH1 pair-leaf hinge ghost', () => {
  it('emits exactly one std-hinge row per leaf on a pair with electrified asymmetric hinge schedule', () => {
    const hwSet = makeDh1LikeSet()
    const opening = { id: 'op-110-01B', door_number: '110-01B', hw_set: 'DH1' }
    const doorInfoMap = new Map([['110-01B', { door_type: 'A', frame_type: 'HM' }]])
    const setMap = new Map([['DH1', hwSet]])
    const doorToSetMap = new Map([['110-01B', hwSet]])

    const rows = buildPerOpeningItems([opening], doorInfoMap, setMap, doorToSetMap)

    const stdHinges = rows.filter(r => String(r['model'] ?? '') === DH1_HINGE_MODEL)
    const stdByLeaf: Record<string, Array<{ qty: unknown }>> = {}
    for (const r of stdHinges) {
      const side = String(r['leaf_side'] ?? 'unknown')
      stdByLeaf[side] = stdByLeaf[side] ?? []
      stdByLeaf[side].push({ qty: r['qty'] })
    }

    // Ground truth: 1 active std row (qty=3 = raw 4 − electric 1),
    // 1 inactive std row (qty=4 raw). No duplicates on either leaf.
    expect(stdByLeaf['active']).toHaveLength(1)
    expect(stdByLeaf['inactive']).toHaveLength(1)
    expect(stdByLeaf['active']?.[0].qty).toBe(3)
    expect(stdByLeaf['inactive']?.[0].qty).toBe(4)

    // Electric hinge stays single-row on the active leaf.
    const electricRows = rows.filter(r => String(r['model'] ?? '') === ELEC_HINGE_MODEL)
    expect(electricRows).toHaveLength(1)
    expect(electricRows[0]['leaf_side']).toBe('active')
    expect(electricRows[0]['qty']).toBe(1)

    // Opening total = 8 hinge positions (3+1 active, 4 inactive).
    const allHinges = rows.filter(r => String(r['name'] ?? '').toLowerCase().includes('hinge'))
    const totalPositions = allHinges.reduce((s, r) => s + (typeof r['qty'] === 'number' ? (r['qty'] as number) : 0), 0)
    expect(totalPositions).toBe(8)
  })
})

// ── Helper unit tests ───────────────────────────────────────────────────────

describe('consolidatePairLeafHingeRows', () => {
  const mkHinge = (qty: number, model = DH1_HINGE_MODEL) => ({
    name: 'Hinges' as const,
    model,
    qty,
    finish: null,
    manufacturer: null,
  })

  it('does nothing on single-leaf openings', () => {
    const items = [mkHinge(3), mkHinge(4)]
    const result = consolidatePairLeafHingeRows(items, false, 1)
    expect(result.items).toHaveLength(2)
    expect(result.consolidated).toBe(0)
  })

  it('does nothing when electric-hinge qty is zero', () => {
    const items = [mkHinge(3), mkHinge(4)]
    const result = consolidatePairLeafHingeRows(items, true, 0)
    expect(result.items).toHaveLength(2)
    expect(result.consolidated).toBe(0)
  })

  it('consolidates the canonical DH1 shape: drops the lower-qty row', () => {
    const items = [mkHinge(3), mkHinge(4), { name: 'Hinges', model: ELEC_HINGE_MODEL, qty: 1, finish: null, manufacturer: null }]
    const result = consolidatePairLeafHingeRows(items, true, 1)
    expect(result.consolidated).toBe(1)
    expect(result.items).toHaveLength(2)
    const stdRow = result.items.find(i => i.model === DH1_HINGE_MODEL)
    expect(stdRow?.qty).toBe(4)   // higher-qty kept
  })

  it('does not consolidate when delta does not match electric qty (ambiguous)', () => {
    // electric=1, but qtys differ by 2 — not a per-leaf split shape.
    const items = [mkHinge(2), mkHinge(4)]
    const result = consolidatePairLeafHingeRows(items, true, 1)
    expect(result.consolidated).toBe(0)
    expect(result.items).toHaveLength(2)
  })

  it('does not consolidate three+ rows of the same name+model', () => {
    // Ambiguous — cannot confidently identify which two belong to the split.
    const items = [mkHinge(3), mkHinge(4), mkHinge(4)]
    const result = consolidatePairLeafHingeRows(items, true, 1)
    expect(result.consolidated).toBe(0)
    expect(result.items).toHaveLength(3)
  })

  it('does not cross-consolidate different (name, model) groups', () => {
    // Two separate hinge products, each with a single row — no consolidation.
    const items = [
      mkHinge(4, 'Model-A NRP'),
      mkHinge(3, 'Model-B NRP'),
    ]
    const result = consolidatePairLeafHingeRows(items, true, 1)
    expect(result.consolidated).toBe(0)
    expect(result.items).toHaveLength(2)
  })

  it('leaves non-hinge items alone even when their qtys would match the heuristic', () => {
    const items = [
      { name: 'Closer', model: 'LCN 4040XP', qty: 3, finish: null, manufacturer: null },
      { name: 'Closer', model: 'LCN 4040XP', qty: 4, finish: null, manufacturer: null },
    ]
    const result = consolidatePairLeafHingeRows(items, true, 1)
    expect(result.consolidated).toBe(0)
    expect(result.items).toHaveLength(2)
  })
})
