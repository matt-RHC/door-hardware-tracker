/**
 * Pair-handling contract tests — PR-A of PR #300 chain
 *
 * Test 5: Regression guard — DH4A.0-shaped pair fixture (6 pair doors) must emit
 *   exactly 12 Door rows (6 Active Leaf + 6 Inactive Leaf) and 6 Frame rows, with
 *   zero bare "Door" or "Frame" tokens. PR #291 fixed bare-token emission; this is
 *   the permanent regression gate.
 *
 * Test 6: Single-leaf control — a heading_leaf_count=1 / heading_door_count=1 set
 *   must emit exactly 1 bare "Door" row (no suffix) and 1 "Frame" row.
 *
 * Test 7: P1 contract (intentional failure) — caller's leafCountByDoor should
 *   override heading_leaf_count=0 and produce pair-style rows. Currently fails
 *   because buildPerOpeningItems calls detectIsPair internally and has no
 *   leafCountByDoor parameter.
 *   UNSKIP AFTER PR-C (P1 REFACTOR) LANDS.
 */

import { describe, it, expect } from 'vitest'
import {
  buildPerOpeningItems,
  buildSetLookupMap,
  buildDoorToSetMap,
} from '@/lib/parse-pdf-helpers'
import type { HardwareSet } from '@/lib/types'

// ─── Test 5 — pair-door structural count ─────────────────────────────────────

describe('pair-handling contract', () => {
  it('Test 5 — DH4A.0 pair fixture emits 12 Door rows (6 active + 6 inactive) and 6 Frame rows', () => {
    // Mirrors the real DH4A.0 shape (Radius DC, 6 pair doors, 12 leaves).
    // heading_leaf_count=12 > heading_door_count=6 triggers primary pair detection.
    const DOOR_NUMBERS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']

    const hwSet: HardwareSet = {
      set_id: 'DH4A.0',
      heading: 'Heading #DH4A.0',
      heading_door_count: 6,
      heading_leaf_count: 12,
      heading_doors: DOOR_NUMBERS,
      items: [
        { name: 'Butt Hinge 5BB1 4.5x4.5', qty: 4, model: '5BB1 4.5x4.5', finish: '652', manufacturer: 'Ives' },
        { name: 'Mortise Lock', qty: 1, model: 'L9050 RHR', finish: '626', manufacturer: 'Schlage' },
        { name: 'Door Closer', qty: 1, model: '4040XP EDA', finish: 'AL', manufacturer: 'LCN' },
        { name: 'Coordinator', qty: 1, model: 'COR100', finish: '628', manufacturer: 'Ives' },
        { name: 'Flush Bolt', qty: 2, model: 'FB457', finish: '626', manufacturer: 'Ives' },
        { name: 'Astragal', qty: 1, model: 'NGP2840', finish: 'BLK', manufacturer: 'NGP' },
      ],
    }

    // leafCountByDoor — internal contract reference; each door is a pair (2 leaves).
    // Not yet passed to buildPerOpeningItems (P1 refactor, PR-C).
    const leafCountByDoor = new Map<string, number>(DOOR_NUMBERS.map(d => [d, 2]))

    const setMap = buildSetLookupMap([hwSet])
    const doorToSetMap = buildDoorToSetMap([hwSet])

    const doorInfoMap = new Map<string, { door_type: string; frame_type: string }>()
    for (const doorNum of DOOR_NUMBERS) {
      doorInfoMap.set(doorNum, { door_type: 'A', frame_type: 'F1' })
    }

    const openings = DOOR_NUMBERS.map((d, i) => ({
      id: `stub-dh4a0-${i}`,
      door_number: d,
      hw_set: 'DH4A.0',
    }))

    const rows = buildPerOpeningItems(
      openings,
      doorInfoMap,
      setMap,
      doorToSetMap,
      'staging_opening_id',
      {},
    )

    const activeLeafRows = rows.filter(r => r.name === 'Door (Active Leaf)')
    const inactiveLeafRows = rows.filter(r => r.name === 'Door (Inactive Leaf)')
    const frameRows = rows.filter(r => r.name === 'Frame')
    // bare-token guard: /^(Door|Frame)$/ catches phantom rows that Python might
    // leak via hwSet.items (the PR #291 regression). On a pair fixture, any bare
    // "Door" row is wrong (pairs use "Door (Active|Inactive Leaf)"). Frame rows
    // ARE legitimate structural rows — they are asserted separately via frameRows.
    const bareDoorRows = rows.filter(r => r.name === 'Door')

    expect(activeLeafRows, '6 active-leaf Door rows (one per pair opening)').toHaveLength(6)
    expect(inactiveLeafRows, '6 inactive-leaf Door rows (one per pair opening)').toHaveLength(6)
    expect(frameRows, '6 Frame rows (one per opening)').toHaveLength(6)
    expect(bareDoorRows, 'zero bare "Door" tokens on a pair fixture (PR #291 regression guard)').toHaveLength(0)

    // Satisfy the unused-variable linter while documenting the P1 intent.
    expect(leafCountByDoor.get('D1')).toBe(2)
  })

  // ─── Test 6 — single-leaf opening ──────────────────────────────────────────

  it('Test 6 — single-leaf opening emits exactly 1 bare Door row and 1 Frame row', () => {
    const hwSet: HardwareSet = {
      set_id: 'AD11-IS',
      heading: 'Heading #AD11-IS',
      heading_door_count: 1,
      heading_leaf_count: 1,
      heading_doors: ['1400'],
      items: [
        { name: 'Continuous Hinge', qty: 1, model: 'HG315HD', finish: '630', manufacturer: 'Select' },
        { name: 'Storeroom Lock', qty: 1, model: 'ND80PD RHO', finish: '626', manufacturer: 'Schlage' },
      ],
    }

    // leafCountByDoor — 1 leaf, single door.
    const leafCountByDoor = new Map<string, number>([['1400', 1]])

    const setMap = buildSetLookupMap([hwSet])
    const doorToSetMap = buildDoorToSetMap([hwSet])

    const doorInfoMap = new Map<string, { door_type: string; frame_type: string }>([
      ['1400', { door_type: 'A', frame_type: 'F1' }],
    ])

    const openings = [{ id: 'stub-single-0', door_number: '1400', hw_set: 'AD11-IS' }]

    const rows = buildPerOpeningItems(
      openings,
      doorInfoMap,
      setMap,
      doorToSetMap,
      'staging_opening_id',
      {},
    )

    const doorRows = rows.filter(r => /^Door/.test(r.name as string))
    const frameRows = rows.filter(r => r.name === 'Frame')
    const activeLeafRows = rows.filter(r => r.name === 'Door (Active Leaf)')

    expect(doorRows, 'exactly 1 Door row').toHaveLength(1)
    expect(doorRows[0]?.name, 'Door row has no leaf suffix').toBe('Door')
    expect(frameRows, 'exactly 1 Frame row').toHaveLength(1)
    expect(activeLeafRows, 'no Active Leaf rows on single-leaf opening').toHaveLength(0)

    expect(leafCountByDoor.get('1400')).toBe(1)
  })

  // ─── Test 7 — caller's leafCount wins (P1 contract) ───────────────────────
  //
  // UNSKIP AFTER PR-C (P1 REFACTOR) LANDS.
  //
  // Contract: when buildPerOpeningItems receives a leafCountByDoor map from the
  // caller (P1 refactor), it should use that value instead of recomputing via
  // detectIsPair. This test exercises the case where heading_leaf_count=0
  // (primary detection blind) but the caller knows the door is a pair
  // (leafCountByDoor.get('D1') === 2). After P1, the function should emit
  // "Door (Active Leaf)" + "Door (Inactive Leaf)" rather than bare "Door".
  //
  // Currently FAILS because buildPerOpeningItems has no leafCountByDoor param
  // and detectIsPair returns false (heading_leaf_count=0, no keywords, no size).

  it.fails('Test 7 — caller leafCountByDoor=2 overrides heading_leaf_count=0 (P1 contract — PR-C)', () => {
    const hwSet: HardwareSet = {
      set_id: 'DH4A.0',
      // No "pair"/"double"/"pr" keyword → tertiary detection blind.
      // door_type='A' → no size signal → secondary detection blind.
      // heading_leaf_count=0 → primary detection blind.
      heading: 'Heading #DH4A.0',
      heading_door_count: 1,
      heading_leaf_count: 0,
      heading_doors: ['D1'],
      items: [
        { name: 'Butt Hinge 5BB1', qty: 4, model: '5BB1', finish: '652', manufacturer: 'Ives' },
      ],
    }

    // Caller knows this door is a pair even though the heading says 0 leaves.
    // After P1 refactor: pass leafCountByDoor to buildPerOpeningItems.
    const leafCountByDoor = new Map<string, number>([['D1', 2]])

    const setMap = buildSetLookupMap([hwSet])
    const doorToSetMap = buildDoorToSetMap([hwSet])

    const doorInfoMap = new Map<string, { door_type: string; frame_type: string }>([
      ['D1', { door_type: 'A', frame_type: 'F1' }],
    ])

    const openings = [{ id: 'stub-p1-0', door_number: 'D1', hw_set: 'DH4A.0' }]

    // TODO(PR-C): pass leafCountByDoor as a parameter once the P1 signature lands.
    const rows = buildPerOpeningItems(
      openings,
      doorInfoMap,
      setMap,
      doorToSetMap,
      'staging_opening_id',
      {},
    )

    // After P1: caller's leafCount=2 should drive pair-style output.
    expect(rows.find(r => r.name === 'Door (Active Leaf)'), 'Active Leaf row present').toBeDefined()
    expect(rows.find(r => r.name === 'Door (Inactive Leaf)'), 'Inactive Leaf row present').toBeDefined()
    expect(rows.filter(r => r.name === 'Door'), 'no bare Door row on pair opening').toHaveLength(0)

    // Confirm the caller's intent is captured in the map.
    expect(leafCountByDoor.get('D1')).toBe(2)
  })
})
