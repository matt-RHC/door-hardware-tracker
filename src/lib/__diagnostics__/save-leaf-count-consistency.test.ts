/**
 * Save-path leaf-count consistency regression (2026-04-18 Radius DC
 * demo-blocker).
 *
 * Downgraded from an integration test against `POST /api/parse-pdf/save`
 * because the repo has no Supabase mock harness for that route. Instead
 * this simulates the save-route pair-decision + item-generation pipeline
 * in-memory and asserts the contrapositive invariant that was violated in
 * production: no staging opening with `leaf_count=1` may have any
 * `staging_hardware_items` row with `leaf_side='inactive'` (the
 * unambiguous pair signal — 'active' is legitimate on single-door bare
 * Door rows per parse-pdf-helpers.ts:2746).
 *
 * The fixture matches the Radius DC shape: 4 doors (2 pair, 2 single),
 * `door_type='A'`, `location='45Min'`, `heading_leaf_count=4` /
 * `heading_door_count=2` for the pair set, `heading_leaf_count=2` /
 * `heading_door_count=2` for the single set.
 */

import { describe, it, expect } from 'vitest'
import {
  buildPerOpeningItems,
  buildSetLookupMap,
  buildDoorToSetMap,
  detectIsPair,
  normalizeDoorNumber,
} from '@/lib/parse-pdf-helpers'
import type { HardwareSet, DoorEntry } from '@/lib/types'

function radiusShapedDoors(): { doors: DoorEntry[]; hardwareSets: HardwareSet[] } {
  const pairSet: HardwareSet = {
    set_id: 'DH4A.0',
    heading: 'Heading #DH4A.0',
    heading_door_count: 2,
    heading_leaf_count: 4, // pair signal
    heading_doors: ['110-01B', '110-02B'],
    items: [
      { name: 'Butt Hinge 5BB1', qty: 4, model: '5BB1', finish: '652', manufacturer: 'IV' },
    ],
  }
  const singleSet: HardwareSet = {
    set_id: 'DH1.0',
    heading: 'Heading #DH1.0',
    heading_door_count: 2,
    heading_leaf_count: 2, // single signal
    heading_doors: ['101', '102'],
    items: [
      { name: 'Butt Hinge 5BB1', qty: 3, model: '5BB1', finish: '652', manufacturer: 'IV' },
    ],
  }
  const doors: DoorEntry[] = (
    [
      ['110-01B', 'DH4A.0'],
      ['110-02B', 'DH4A.0'],
      ['101', 'DH1.0'],
      ['102', 'DH1.0'],
    ] as const
  ).map(([door_number, hw_set]) => ({
    door_number,
    hw_set,
    door_type: 'A',
    frame_type: 'F1',
    location: '45Min',
  })) as DoorEntry[]
  return { doors, hardwareSets: [pairSet, singleSet] }
}

describe('save-path leaf-count consistency — contrapositive invariant', () => {
  it('no staging opening with leaf_count=1 has any item with leaf_side="inactive"', () => {
    const { doors, hardwareSets } = radiusShapedDoors()

    // Mirror save/route.ts lookup map construction.
    const setMap = buildSetLookupMap(hardwareSets)
    const doorToSetMap = buildDoorToSetMap(hardwareSets)
    const doorInfoMap = new Map<string, { door_type: string; frame_type: string }>()
    for (const d of doors) {
      doorInfoMap.set(d.door_number, {
        door_type: d.door_type || '',
        frame_type: d.frame_type || '',
      })
    }

    // Step 1: compute isPair ONCE per door (single source of truth).
    const isPairByDoor = new Map<string, boolean>()
    const stagingLeafCountByDoor = new Map<string, number>()
    for (const d of doors) {
      const doorKey = normalizeDoorNumber(d.door_number)
      const hwSet = doorToSetMap.get(doorKey) ?? setMap.get(d.hw_set ?? '')
      const isPair = detectIsPair(hwSet, doorInfoMap.get(d.door_number))
      isPairByDoor.set(d.door_number, isPair)
      stagingLeafCountByDoor.set(d.door_number, isPair ? 2 : 1)
    }

    // Step 2: simulate the DB round-trip by constructing stagingOpeningRows.
    const stagingOpeningRows = doors.map((d, i) => ({
      id: `staging-${i}`,
      door_number: d.door_number,
      hw_set: d.hw_set ?? null,
    }))

    // Step 3: build hardware items with the SAME isPairByDoor.
    const allItems = buildPerOpeningItems(
      stagingOpeningRows,
      doorInfoMap,
      setMap,
      doorToSetMap,
      'staging_opening_id',
      { extraction_run_id: 'run-test' },
      isPairByDoor,
    )

    // Invariant: the contrapositive of the Radius DC bug.
    const itemsByOpening = new Map<string, typeof allItems>()
    for (const item of allItems) {
      const openingId = item.staging_opening_id as string
      const arr = itemsByOpening.get(openingId) ?? []
      arr.push(item)
      itemsByOpening.set(openingId, arr)
    }

    for (const row of stagingOpeningRows) {
      const leafCount = stagingLeafCountByDoor.get(row.door_number)!
      const itemsForOpening = itemsByOpening.get(row.id) ?? []
      const leafSideItems = itemsForOpening.filter(i => i.leaf_side === 'inactive')
      if (leafCount === 1) {
        expect(
          leafSideItems.length,
          `door ${row.door_number}: leaf_count=1 must not produce leaf_side='inactive' items (found ${leafSideItems.length})`,
        ).toBe(0)
      }
    }

    // Positive assertion: the 2 pair doors ARE detected as pairs.
    expect(stagingLeafCountByDoor.get('110-01B')).toBe(2)
    expect(stagingLeafCountByDoor.get('110-02B')).toBe(2)
    // And the 2 singles stay singles.
    expect(stagingLeafCountByDoor.get('101')).toBe(1)
    expect(stagingLeafCountByDoor.get('102')).toBe(1)
  })
})

describe('jobs-runner leaf-count consistency — contrapositive invariant', () => {
  it('jobs path: no staging opening with leaf_count=1 has any item with leaf_side="inactive"', () => {
    // Jobs runner (src/app/api/jobs/[id]/run/route.ts) and save/route.ts
    // share the same detectIsPair + buildPerOpeningItems pipeline and build
    // isPairByDoor from `filteredDoors`. The invariant must hold for both
    // paths — this test mirrors the jobs runner's code shape (filteredDoors
    // instead of activeDoors) but the assertion is identical.
    const { doors, hardwareSets } = radiusShapedDoors()
    const filteredDoors = doors // jobs runner filters orphans — same fixture has none.

    const setMap = buildSetLookupMap(hardwareSets)
    const doorToSetMap = buildDoorToSetMap(hardwareSets)
    const doorInfoMap = new Map<string, { door_type: string; frame_type: string }>()
    for (const d of filteredDoors) {
      doorInfoMap.set(d.door_number, { door_type: d.door_type || '', frame_type: d.frame_type || '' })
    }

    const isPairByDoor = new Map<string, boolean>()
    const stagingLeafCountByDoor = new Map<string, number>()
    for (const d of filteredDoors) {
      const doorKey = normalizeDoorNumber(d.door_number)
      const hwSet = doorToSetMap.get(doorKey) ?? setMap.get(d.hw_set ?? '')
      const isPair = detectIsPair(hwSet, doorInfoMap.get(d.door_number))
      isPairByDoor.set(d.door_number, isPair)
      stagingLeafCountByDoor.set(d.door_number, isPair ? 2 : 1)
    }

    const stagingOpeningRows = filteredDoors.map((d, i) => ({
      id: `job-staging-${i}`,
      door_number: d.door_number,
      hw_set: d.hw_set ?? null,
    }))

    const allItems = buildPerOpeningItems(
      stagingOpeningRows,
      doorInfoMap,
      setMap,
      doorToSetMap,
      'staging_opening_id',
      { extraction_run_id: 'job-run-test' },
      isPairByDoor,
    )

    for (const row of stagingOpeningRows) {
      const leafCount = stagingLeafCountByDoor.get(row.door_number)!
      const itemsForOpening = allItems.filter(i => i.staging_opening_id === row.id)
      const leafSideItems = itemsForOpening.filter(i => i.leaf_side === 'inactive')
      if (leafCount === 1) {
        expect(
          leafSideItems.length,
          `job door ${row.door_number}: leaf_count=1 but produced ${leafSideItems.length} leaf_side='inactive' items`,
        ).toBe(0)
      }
    }
  })
})
