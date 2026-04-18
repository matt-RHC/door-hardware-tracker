/**
 * Leaf-count invariant regression guard (2026-04-18 Radius DC demo-blocker).
 *
 * The bug: on the Radius DC PDF promotion, `detectIsPair` returned `true`
 * when called from `buildPerOpeningItems` (25 openings got Door-leaf rows)
 * but `false` when called from `save/route.ts:175` for the staging
 * `leaf_count` write (all 80 openings got `leaf_count=1`). Same function,
 * same request, different answers.
 *
 * This test pins down the invariant that both call sites must agree, by
 * driving `buildPerOpeningItems` with and without the `isPairByDoor` map
 * and asserting the structural row set and the staging-style `leaf_count`
 * line up for the Radius DC shape (heading_leaf_count > heading_door_count).
 */

import { describe, it, expect } from 'vitest'
import {
  buildPerOpeningItems,
  buildSetLookupMap,
  buildDoorToSetMap,
  detectIsPair,
} from '@/lib/parse-pdf-helpers'
import type { HardwareSet } from '@/lib/types'

function radiusDCFixture() {
  const DOOR_NUMBERS = ['110-01B', '110-02B']
  const hwSet: HardwareSet = {
    set_id: 'DH4A.0',
    heading: 'Heading #DH4A.0',
    heading_door_count: 2,
    heading_leaf_count: 4, // > heading_door_count → primary pair signal
    heading_doors: DOOR_NUMBERS,
    items: [
      { name: 'Butt Hinge 5BB1', qty: 4, model: '5BB1', finish: '652', manufacturer: 'IV' },
      { name: 'Flush Bolt', qty: 2, model: 'FB457', finish: '626', manufacturer: 'IV' },
    ],
  }
  const setMap = buildSetLookupMap([hwSet])
  const doorToSetMap = buildDoorToSetMap([hwSet])
  const doorInfoMap = new Map<string, { door_type: string; frame_type: string }>()
  for (const d of DOOR_NUMBERS) {
    doorInfoMap.set(d, { door_type: 'A', frame_type: 'F1' })
  }
  const openings = DOOR_NUMBERS.map((d, i) => ({
    id: `op-${i}`,
    door_number: d,
    hw_set: 'DH4A.0',
  }))
  return { DOOR_NUMBERS, hwSet, setMap, doorToSetMap, doorInfoMap, openings }
}

describe('leaf-count invariant — save path single source of truth', () => {
  it('detectIsPair and buildPerOpeningItems agree on Radius DC pair shape', () => {
    const { hwSet, doorInfoMap } = radiusDCFixture()
    const doorInfo = doorInfoMap.get('110-01B')
    expect(detectIsPair(hwSet, doorInfo)).toBe(true)
  })

  it('staging-style leaf_count derived from isPairByDoor matches the leaf rows emitted by buildPerOpeningItems', () => {
    const { DOOR_NUMBERS, hwSet, setMap, doorToSetMap, doorInfoMap, openings } = radiusDCFixture()

    // This mirrors the save-route flow: compute isPair ONCE upstream, write
    // leaf_count from the map, then hand the same map to buildPerOpeningItems.
    const isPairByDoor = new Map<string, boolean>()
    const stagingLeafCountByDoor = new Map<string, number>()
    for (const d of DOOR_NUMBERS) {
      const isPair = detectIsPair(hwSet, doorInfoMap.get(d))
      isPairByDoor.set(d, isPair)
      stagingLeafCountByDoor.set(d, isPair ? 2 : 1)
    }

    const rows = buildPerOpeningItems(
      openings,
      doorInfoMap,
      setMap,
      doorToSetMap,
      'staging_opening_id',
      {},
      isPairByDoor,
    )

    // Contrapositive invariant (the bug): if staging leaf_count=1 for a door,
    // there must be zero 'active'/'inactive' rows for that opening.
    const byOpening = new Map<string, typeof rows>()
    for (const r of rows) {
      const arr = byOpening.get(r.staging_opening_id as string) ?? []
      arr.push(r)
      byOpening.set(r.staging_opening_id as string, arr)
    }

    for (const opening of openings) {
      const itemsForOpening = byOpening.get(opening.id) ?? []
      const leafCount = stagingLeafCountByDoor.get(opening.door_number)!
      // Canary for the Radius DC bug: leaf_side='inactive' is the unambiguous
      // pair-only signal (single doors carry 'active' on their bare Door row
      // by design — see parse-pdf-helpers.ts:2746).
      const hasInactiveLeafItem = itemsForOpening.some(r => r.leaf_side === 'inactive')
      if (leafCount === 1) {
        expect(
          hasInactiveLeafItem,
          `door ${opening.door_number}: leaf_count=1 but has leaf_side='inactive' items`,
        ).toBe(false)
      }
      if (leafCount === 2) {
        const activeRow = itemsForOpening.find(r => r.leaf_side === 'active' && r.name === 'Door (Active Leaf)')
        const inactiveRow = itemsForOpening.find(r => r.leaf_side === 'inactive' && r.name === 'Door (Inactive Leaf)')
        expect(activeRow, `door ${opening.door_number}: missing Active Leaf row`).toBeDefined()
        expect(inactiveRow, `door ${opening.door_number}: missing Inactive Leaf row`).toBeDefined()
      }
    }
  })

  it('buildPerOpeningItems throws when isPairByDoor is provided but missing a door_number', () => {
    const { setMap, doorToSetMap, doorInfoMap, openings } = radiusDCFixture()
    const incompleteMap = new Map<string, boolean>([['110-01B', true]]) // missing 110-02B
    expect(() =>
      buildPerOpeningItems(
        openings,
        doorInfoMap,
        setMap,
        doorToSetMap,
        'staging_opening_id',
        {},
        incompleteMap,
      ),
    ).toThrow(/missing decision for door_number=110-02B/)
  })

  it('buildPerOpeningItems falls back to detectIsPair when isPairByDoor is omitted (apply-revision compat)', () => {
    const { setMap, doorToSetMap, doorInfoMap, openings } = radiusDCFixture()
    // Omitting isPairByDoor exercises the legacy path used by apply-revision.
    const rows = buildPerOpeningItems(openings, doorInfoMap, setMap, doorToSetMap, 'opening_id', {})
    const activeLeaves = rows.filter(r => r.name === 'Door (Active Leaf)')
    const inactiveLeaves = rows.filter(r => r.name === 'Door (Inactive Leaf)')
    // Primary signal (heading_leaf_count > heading_door_count) fires →
    // both openings are pairs even without the map.
    expect(activeLeaves).toHaveLength(2)
    expect(inactiveLeaves).toHaveLength(2)
  })
})
