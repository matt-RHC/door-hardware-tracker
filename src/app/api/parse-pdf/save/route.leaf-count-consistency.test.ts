/**
 * Test 1 — leaf_count consistency between staging-opening loop and buildPerOpeningItems.
 *
 * Invariant: for any opening where buildPerOpeningItems emits a 'Door (Inactive Leaf)'
 * row (i.e. isPair=true inside the helper), the staging opening's leaf_count MUST
 * be 2. Equivalently: no staging opening with leaf_count=1 may have any
 * hardware_items row with leaf_side IN ('active','inactive').
 *
 * This test reproduces the Radius DC grid-RR shape (door_type='A',
 * heading_leaf_count=8, heading_door_count=4) with 4 openings — 2 pair, 2 single.
 *
 * Both the jobs/[id]/run/route.ts and save/route.ts staging paths are exercised via
 * the shared helper logic they delegate to; the test validates consistency between
 * the two calls within a single request lifecycle.
 */
import { describe, it, expect } from 'vitest'
import {
  buildSetLookupMap,
  buildDoorToSetMap,
  detectIsPair,
  buildPerOpeningItems,
} from '@/lib/parse-pdf-helpers'
import type { HardwareSet, DoorEntry } from '@/lib/types'

// ── Radius DC grid-RR shape fixture ─────────────────────────────────────────
//
// Two pair sets (heading_leaf_count > heading_door_count) and one single set.
// Mirrors what Python emits for the grid-RR PDF.

const PAIR_SET_A: HardwareSet = {
  set_id: 'DH4A.1',
  generic_set_id: 'DH4A',
  heading: 'Heading #DH4A.1',
  heading_door_count: 4,
  heading_leaf_count: 8,
  heading_doors: ['110-01A', '110-01B'],
  items: [
    { name: 'Butt Hinge 5BB1 4.5x4.5', qty: 4, model: '5BB1 4.5x4.5', finish: '652', manufacturer: 'Ives' },
    { name: 'Mortise Lock', qty: 1, model: 'L9050 RHR', finish: '626', manufacturer: 'Schlage' },
    { name: 'Coordinator', qty: 1, model: 'COR100', finish: '628', manufacturer: 'Ives' },
  ],
}

const SINGLE_SET: HardwareSet = {
  set_id: 'AD11-IS',
  heading: 'Heading #AD11-IS',
  heading_door_count: 1,
  heading_leaf_count: 1,
  heading_doors: ['1400', '1401'],
  items: [
    { name: 'Continuous Hinge', qty: 1, model: 'HG315HD', finish: '630', manufacturer: 'Select' },
    { name: 'Storeroom Lock', qty: 1, model: 'ND80PD RHO', finish: '626', manufacturer: 'Schlage' },
  ],
}

const DOORS: DoorEntry[] = [
  { door_number: '110-01A', hw_set: 'DH4A.1', location: '45Min', door_type: 'A', frame_type: 'F2', fire_rating: '45 min', hand: 'LHR' },
  { door_number: '110-01B', hw_set: 'DH4A.1', location: '45Min', door_type: 'A', frame_type: 'F2', fire_rating: '45 min', hand: 'RHR' },
  { door_number: '1400',    hw_set: 'AD11-IS', location: 'Mech Room', door_type: 'A', frame_type: 'F1', fire_rating: '90 min', hand: 'RH' },
  { door_number: '1401',    hw_set: 'AD11-IS', location: 'Storage',   door_type: 'A', frame_type: 'F1', fire_rating: '',        hand: 'LH' },
]

describe('leaf_count consistency: staging loop vs buildPerOpeningItems', () => {
  it('staging leaf_count matches buildPerOpeningItems isPair for every opening (Radius DC shape)', () => {
    const hardwareSets = [PAIR_SET_A, SINGLE_SET]

    // Replicate save/route.ts logic exactly -----------------------------------
    const setMap = buildSetLookupMap(hardwareSets)
    const doorToSetMap = buildDoorToSetMap(hardwareSets)

    // Build doorInfoMap WITH location (the Bug 1 fix)
    const doorInfoMap = new Map<string, { door_type: string; frame_type: string; location: string }>()
    for (const door of DOORS) {
      doorInfoMap.set(door.door_number, {
        door_type: door.door_type || '',
        frame_type: door.frame_type || '',
        location: door.location || '',
      })
    }

    // Staging loop: compute leaf_count per opening (mirrors save/route.ts:170-191)
    const stagingOpenings = DOORS.map((d, i) => {
      const doorKey = (d.door_number ?? '').trim().toUpperCase().replace(/\s+/g, '')
      const hwSet = doorToSetMap.get(doorKey) ?? setMap.get(d.hw_set ?? '')
      const doorInfo = doorInfoMap.get(d.door_number)
      const isPair = detectIsPair(hwSet, doorInfo)
      return {
        id: `stub-${i}`,
        door_number: d.door_number,
        hw_set: d.hw_set ?? null,
        leaf_count: isPair ? 2 : 1,
      }
    })

    // buildPerOpeningItems: generate hardware items (mirrors save/route.ts:207-214)
    const allItems = buildPerOpeningItems(
      stagingOpenings,
      doorInfoMap,
      setMap,
      doorToSetMap,
      'staging_opening_id',
      {},
    )

    // ── INVARIANT: no staging opening with leaf_count=1 may have any item
    //    with leaf_side='inactive'. (leaf_side='active' is used on single-leaf
    //    bare Door rows and is NOT an indicator of a pair.)
    for (const opening of stagingOpenings) {
      const items = allItems.filter(r => r['staging_opening_id'] === opening.id)
      const hasInactiveLeafItems = items.some(r => r['leaf_side'] === 'inactive')

      if (opening.leaf_count === 1) {
        expect(
          hasInactiveLeafItems,
          `Opening ${opening.door_number} has leaf_count=1 but buildPerOpeningItems emitted inactive leaf items — pair detection diverged`,
        ).toBe(false)
      }

      if (hasInactiveLeafItems) {
        expect(
          opening.leaf_count,
          `Opening ${opening.door_number} has inactive leaf items but leaf_count=${opening.leaf_count} (expected 2)`,
        ).toBe(2)
      }
    }
  })

  it('pair openings (heading_leaf_count > heading_door_count) get leaf_count=2', () => {
    const hardwareSets = [PAIR_SET_A, SINGLE_SET]
    const setMap = buildSetLookupMap(hardwareSets)
    const doorToSetMap = buildDoorToSetMap(hardwareSets)
    const doorInfoMap = new Map<string, { door_type: string; frame_type: string; location: string }>()
    for (const door of DOORS) {
      doorInfoMap.set(door.door_number, {
        door_type: door.door_type || '',
        frame_type: door.frame_type || '',
        location: door.location || '',
      })
    }

    const leafCounts = DOORS.map(d => {
      const doorKey = (d.door_number ?? '').trim().toUpperCase().replace(/\s+/g, '')
      const hwSet = doorToSetMap.get(doorKey) ?? setMap.get(d.hw_set ?? '')
      const doorInfo = doorInfoMap.get(d.door_number)
      return { door: d.door_number, isPair: detectIsPair(hwSet, doorInfo) }
    })

    expect(leafCounts.find(x => x.door === '110-01A')?.isPair).toBe(true)
    expect(leafCounts.find(x => x.door === '110-01B')?.isPair).toBe(true)
    expect(leafCounts.find(x => x.door === '1400')?.isPair).toBe(false)
    expect(leafCounts.find(x => x.door === '1401')?.isPair).toBe(false)
  })

  it('single openings get exactly 1 bare Door row (not Active/Inactive Leaf)', () => {
    const hardwareSets = [PAIR_SET_A, SINGLE_SET]
    const setMap = buildSetLookupMap(hardwareSets)
    const doorToSetMap = buildDoorToSetMap(hardwareSets)
    const doorInfoMap = new Map<string, { door_type: string; frame_type: string; location: string }>()
    for (const door of DOORS) {
      doorInfoMap.set(door.door_number, {
        door_type: door.door_type || '',
        frame_type: door.frame_type || '',
        location: door.location || '',
      })
    }

    const openings = DOORS.map((d, i) => ({
      id: `stub-${i}`,
      door_number: d.door_number,
      hw_set: d.hw_set ?? null,
    }))

    const allItems = buildPerOpeningItems(openings, doorInfoMap, setMap, doorToSetMap, 'staging_opening_id', {})

    for (const opening of openings) {
      const items = allItems.filter(r => r['staging_opening_id'] === opening.id)
      const doorRows = items.filter(r => /^Door/.test(String(r['name'] ?? '')))
      const isPairOpening = ['110-01A', '110-01B'].includes(opening.door_number)

      if (!isPairOpening) {
        expect(
          doorRows.filter(r => r['name'] === 'Door (Inactive Leaf)').length,
          `Single opening ${opening.door_number} must have 0 Inactive Leaf rows`,
        ).toBe(0)
        expect(
          doorRows.filter(r => r['name'] === 'Door').length,
          `Single opening ${opening.door_number} must have exactly 1 bare Door row`,
        ).toBe(1)
      } else {
        expect(
          doorRows.filter(r => r['name'] === 'Door (Active Leaf)').length,
          `Pair opening ${opening.door_number} must have 1 Active Leaf row`,
        ).toBe(1)
        expect(
          doorRows.filter(r => r['name'] === 'Door (Inactive Leaf)').length,
          `Pair opening ${opening.door_number} must have 1 Inactive Leaf row`,
        ).toBe(1)
      }
    }
  })
})
