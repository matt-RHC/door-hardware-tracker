/**
 * DIAGNOSIS — reproduce the 110-01B / DH1 pair-leaf ghost bug in isolation.
 *
 * This test is a throwaway instrument to confirm the hypothesis that
 * `buildPerOpeningItems` double-emits hinge rows onto both leaves of a pair
 * opening when `hwSet.items` carries TWO standard-hinge entries (one
 * representing Leaf 1's count, one representing Leaf 2's). It should be
 * removed or replaced with a proper regression test once the fix ships.
 *
 * Observed (Matthew, 2026-04-18): On 110-01B / DH1, Leaf 2 (inactive)
 * showed BOTH a qty=3 row and a qty=4 row of identical model
 * `5BB1 HW 4 1/2 × 4 1/2 NRP`. Ground truth: Leaf 2 should have a single
 * qty=4 row; the qty=3 is Leaf 1's count leaking across.
 */

import { describe, it, expect } from 'vitest'
import { buildPerOpeningItems } from './parse-pdf-helpers'
import type { HardwareSet } from '@/lib/types'

describe('DIAGNOSIS: pair-leaf hinge ghost on 110-01B DH1', () => {
  it('reproduces the qty-3 + qty-4 duplicate rows on inactive leaf', () => {
    // Approximates DH1's extracted shape. Matthew's ground truth:
    //   Leaf 1 (active):   3 std hinges + 1 electric hinge = 4 total
    //   Leaf 2 (inactive): 4 std hinges
    //
    // Hypothesis: Python emits two standard-hinge entries in hwSet.items —
    // one with qty=3 (representing Leaf 1's reduced count) and one with
    // qty=4 (representing Leaf 2's). buildPerOpeningItems then runs its
    // hinge-split branch on BOTH entries, emitting active+inactive rows for
    // each, which yields 2+2=4 hinge rows on the opening instead of 2.
    const hwSet: HardwareSet = {
      set_id: 'DH1',
      generic_set_id: 'DH1',
      heading: 'Set DH1',
      heading_door_count: 1,
      heading_leaf_count: 2,
      heading_doors: ['110-01B'],
      items: [
        { qty: 3, name: 'Hinges', model: '5BB1 HW 4 1/2 × 4 1/2 NRP', finish: '626', manufacturer: 'Ives' },
        { qty: 4, name: 'Hinges', model: '5BB1 HW 4 1/2 × 4 1/2 NRP', finish: '626', manufacturer: 'Ives' },
        { qty: 1, name: 'Hinges', model: '5BB1 HW 4 1/2 × 4 1/2 CON TW8', finish: '626', manufacturer: 'Ives' },
      ],
    }

    const opening = { id: 'op-110-01B', door_number: '110-01B', hw_set: 'DH1' }
    const doorInfoMap = new Map([['110-01B', { door_type: 'A', frame_type: 'HM' }]])
    const setMap = new Map([['DH1', hwSet]])
    const doorToSetMap = new Map([['110-01B', hwSet]])

    const rows = buildPerOpeningItems([opening], doorInfoMap, setMap, doorToSetMap)

    // Summarize for diagnosis.
    const hingeRows = rows.filter(r => String(r['name'] ?? '').toLowerCase().includes('hinge'))
    const byLeaf: Record<string, Array<{ qty: unknown; model: unknown }>> = {}
    for (const r of hingeRows) {
      const side = String(r['leaf_side'] ?? 'unknown')
      byLeaf[side] = byLeaf[side] ?? []
      byLeaf[side].push({ qty: r['qty'], model: r['model'] })
    }
    // eslint-disable-next-line no-console
    console.log('DIAGNOSIS: hinge rows by leaf_side =', JSON.stringify(byLeaf, null, 2))
    // eslint-disable-next-line no-console
    console.log('DIAGNOSIS: total hinge rows =', hingeRows.length)

    // Leaf 2 (inactive): ground truth expects ONE row at qty=4.
    const inactiveStdHingeRows = (byLeaf['inactive'] ?? []).filter(
      r => String(r.model ?? '').includes('NRP'),
    )
    // EXPECTED if the bug is present: two rows, qty 3 and qty 4.
    // If this expectation holds, hypothesis confirmed.
    expect(inactiveStdHingeRows).toHaveLength(2)
    const inactiveQtys = inactiveStdHingeRows.map(r => r.qty).sort()
    expect(inactiveQtys).toEqual([3, 4])
  })
})