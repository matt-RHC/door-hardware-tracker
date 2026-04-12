import { describe, it, expect } from 'vitest'
import {
  normalizeQuantities,
  normalizeDoorNumber,
  buildDoorToSetMap,
  buildDefinedSetIds,
  findDoorsWithUnmatchedSets,
} from './parse-pdf-helpers'
import type { HardwareSet, DoorEntry } from '@/lib/types'

/**
 * Helper: build a minimal HardwareSet with items for testing.
 * heading_door_count = how many doors this set covers (from PDF heading, e.g., "For 4 Doors")
 * heading_leaf_count = how many leaves (pair doors have 2 leaves per opening)
 */
function makeSet(
  set_id: string,
  items: Array<{ name: string; qty: number; qty_source?: string }>,
  opts: { heading_door_count?: number; heading_leaf_count?: number } = {},
): HardwareSet {
  return {
    set_id,
    heading: `Set ${set_id}`,
    heading_door_count: opts.heading_door_count,
    heading_leaf_count: opts.heading_leaf_count,
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

/** Helper: build a minimal door entry assigned to a set. */
function makeDoor(door_number: string, hw_set: string): DoorEntry {
  return {
    door_number,
    hw_set,
    door_type: null,
    frame_type: null,
    fire_rating: null,
    hand: null,
    location: null,
  } as DoorEntry
}

// ─── Tests ───

describe('normalizeQuantities — category-aware division', () => {

  // === per_leaf items (hinges, pivots) ===

  it('divides hinges by leaf count (per_leaf)', () => {
    // Pair door: 2 leaves. PDF shows 6 hinges total → should become 3 per leaf.
    const sets = [makeSet('DH1', [
      { name: 'Butt Hinge 4.5" x 4.5"', qty: 6 },
    ], { heading_leaf_count: 2, heading_door_count: 1 })]
    const doors = [makeDoor('101', 'DH1')]

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(3)
    expect(sets[0].items[0].qty_total).toBe(6)
    expect(sets[0].items[0].qty_door_count).toBe(2)
    expect(sets[0].items[0].qty_source).toBe('divided')
  })

  it('divides continuous hinges by leaf count (per_leaf)', () => {
    const sets = [makeSet('DH2', [
      { name: 'Continuous Hinge', qty: 4 },
    ], { heading_leaf_count: 4 })]
    const doors = [makeDoor('201', 'DH2'), makeDoor('202', 'DH2')]

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(1)
    expect(sets[0].items[0].qty_source).toBe('divided')
  })

  // Regression for the "42 hinges on 12 leaves" pair-door bug
  // (Radius DC DH4A.0 screenshot, 2026-04-11).
  //
  // Old behavior: 42 hinges / 12 leaves = 3.5 (non-integer) → rejected →
  // fell back to 42 / 6 doors = 7 per opening → silently wrong.
  //
  // New behavior: always divide by leafCount for per_leaf items when
  // leafCount > 1, using Math.round and flagging the item if the
  // division isn't clean.
  it('rounds and flags pair-door hinges when qty does not divide cleanly by leafCount', () => {
    // Pair-door set with 6 pairs (12 leaves). 42 standard hinges is a
    // real-world pattern: 3 hinges on each of 12 leaves = 36, plus 6
    // "extra" (e.g., mid-height pivots, transfer prep) that show on the
    // same line. The correct per-leaf answer is roughly 4 (42/12≈3.5
    // → rounds up to 4) — NOT 7 (42/6) which was the old incorrect
    // fallback.
    const sets = [makeSet('DH4A', [
      { name: 'Butt Hinge 5BB1 HW 4.5" x 4.5"', qty: 42 },
    ], { heading_leaf_count: 12, heading_door_count: 6 })]
    const doors = Array.from({ length: 6 }, (_, i) =>
      makeDoor(`DH4A-PR-${i + 1}`, 'DH4A'),
    )

    normalizeQuantities(sets, doors)

    // 42 / 12 = 3.5, rounds to 4. NOT 7 (the old buggy fallback).
    expect(sets[0].items[0].qty).toBe(4)
    expect(sets[0].items[0].qty_total).toBe(42)
    expect(sets[0].items[0].qty_door_count).toBe(12)
    // Flagged so Punchy + the UI know this is a non-clean division.
    expect(sets[0].items[0].qty_source).toBe('flagged')
  })

  it('divides pair-door hinges cleanly when qty is a multiple of leafCount', () => {
    // Clean case: 48 hinges across 12 leaves = 4 per leaf.
    // Should be marked 'divided' (not flagged) because the math is exact.
    const sets = [makeSet('DH4A_CLEAN', [
      { name: 'Butt Hinge 5BB1', qty: 48 },
    ], { heading_leaf_count: 12, heading_door_count: 6 })]
    const doors = Array.from({ length: 6 }, (_, i) =>
      makeDoor(`CLEAN-PR-${i + 1}`, 'DH4A_CLEAN'),
    )

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(4)
    expect(sets[0].items[0].qty_total).toBe(48)
    expect(sets[0].items[0].qty_door_count).toBe(12)
    expect(sets[0].items[0].qty_source).toBe('divided')
  })

  it('never silently falls back to doorCount for per_leaf items when leafCount is known', () => {
    // Safety net: regardless of whether the per_leaf division is clean,
    // a per_leaf item with a known leafCount must NEVER divide by
    // doorCount alone. This is the exact mask-the-bug behavior we're
    // killing.
    const sets = [makeSet('DH_SAFETY', [
      { name: 'Hinge', qty: 14 }, // 14/4=3.5 → rounds to 4; 14/2=7 would be "plausible"
    ], { heading_leaf_count: 4, heading_door_count: 2 })]
    const doors = [makeDoor('S01', 'DH_SAFETY'), makeDoor('S02', 'DH_SAFETY')]

    normalizeQuantities(sets, doors)

    // Must round from leafCount division, NOT fall back to doorCount.
    expect(sets[0].items[0].qty).toBe(4) // NOT 7
    expect(sets[0].items[0].qty_door_count).toBe(4) // leafCount, not doorCount
    expect(sets[0].items[0].qty_source).toBe('flagged')
  })

  // === per_opening items (closers, locksets) ===

  it('divides closers by door count, not leaf count (per_opening)', () => {
    // 4 leaves, 2 doors. PDF shows 2 closers total → per opening = 1.
    // Old behavior would try leafCount first (4), fail (2/4 not integer), then doorCount.
    // New behavior skips leafCount entirely for per_opening items.
    const sets = [makeSet('DH3', [
      { name: 'Door Closer LCN 4040XP', qty: 2 },
    ], { heading_leaf_count: 4, heading_door_count: 2 })]
    const doors = [makeDoor('301', 'DH3'), makeDoor('302', 'DH3')]

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(1)
    expect(sets[0].items[0].qty_door_count).toBe(2)
    expect(sets[0].items[0].qty_source).toBe('divided')
  })

  it('divides locksets by door count (per_opening)', () => {
    // 4 doors, 8 leaves. PDF shows 4 locksets → 1 per opening.
    const sets = [makeSet('DH4', [
      { name: 'Mortise Lockset Schlage L9453', qty: 4 },
    ], { heading_leaf_count: 8, heading_door_count: 4 })]
    const doors = [
      makeDoor('401', 'DH4'), makeDoor('402', 'DH4'),
      makeDoor('403', 'DH4'), makeDoor('404', 'DH4'),
    ]

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(1)
    expect(sets[0].items[0].qty_source).toBe('divided')
  })

  it('divides exit devices by door count (per_opening)', () => {
    const sets = [makeSet('DH5', [
      { name: 'Exit Device Von Duprin 98-EO', qty: 6 },
    ], { heading_door_count: 3 })]
    const doors = [makeDoor('501', 'DH5'), makeDoor('502', 'DH5'), makeDoor('503', 'DH5')]

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(2)
    expect(sets[0].items[0].qty_source).toBe('divided')
  })

  // === per_pair items (coordinators, flush bolts, astragals) ===

  it('never divides coordinators (per_pair)', () => {
    // Coordinator should stay at qty 1 regardless of door/leaf counts.
    const sets = [makeSet('DH6', [
      { name: 'Coordinator', qty: 1 },
    ], { heading_leaf_count: 2, heading_door_count: 4 })]
    const doors = [
      makeDoor('601', 'DH6'), makeDoor('602', 'DH6'),
      makeDoor('603', 'DH6'), makeDoor('604', 'DH6'),
    ]

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(1)
    expect(sets[0].items[0].qty_source).toBeUndefined()
  })

  it('never divides flush bolts (per_pair)', () => {
    const sets = [makeSet('DH7', [
      { name: 'Flush Bolt Ives FB51P', qty: 2 },
    ], { heading_leaf_count: 4, heading_door_count: 2 })]
    const doors = [makeDoor('701', 'DH7'), makeDoor('702', 'DH7')]

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(2)
    expect(sets[0].items[0].qty_source).toBeUndefined()
  })

  it('never divides astragals (per_pair)', () => {
    const sets = [makeSet('DH8', [
      { name: 'Astragal', qty: 1 },
    ], { heading_leaf_count: 2, heading_door_count: 2 })]
    const doors = [makeDoor('801', 'DH8'), makeDoor('802', 'DH8')]

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(1)
    expect(sets[0].items[0].qty_source).toBeUndefined()
  })

  // === per_frame items (thresholds, seals, weatherstrip) ===

  it('never divides thresholds (per_frame)', () => {
    const sets = [makeSet('DH9', [
      { name: 'Threshold NGP 896N', qty: 1 },
    ], { heading_door_count: 3 })]
    const doors = [makeDoor('901', 'DH9'), makeDoor('902', 'DH9'), makeDoor('903', 'DH9')]

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(1)
    expect(sets[0].items[0].qty_source).toBeUndefined()
  })

  it('never divides smoke seals (per_frame)', () => {
    const sets = [makeSet('DH10', [
      { name: 'Smoke Seal Pemko S88', qty: 3 },
    ], { heading_door_count: 3 })]
    const doors = [makeDoor('1001', 'DH10'), makeDoor('1002', 'DH10'), makeDoor('1003', 'DH10')]

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(3)
    expect(sets[0].items[0].qty_source).toBeUndefined()
  })

  // === Skip logic ===

  it('skips items already marked as divided', () => {
    const sets = [makeSet('DH11', [
      { name: 'Hinge', qty: 3, qty_source: 'divided' },
    ], { heading_leaf_count: 3 })]
    const doors = [makeDoor('1101', 'DH11')]

    normalizeQuantities(sets, doors)

    // qty stays at 3 — not re-divided
    expect(sets[0].items[0].qty).toBe(3)
    expect(sets[0].items[0].qty_source).toBe('divided')
  })

  it('skips items marked as flagged or capped', () => {
    const sets = [makeSet('DH12', [
      { name: 'Hinge', qty: 6, qty_source: 'flagged' },
      { name: 'Closer', qty: 4, qty_source: 'capped' },
    ], { heading_leaf_count: 2, heading_door_count: 2 })]
    const doors = [makeDoor('1201', 'DH12'), makeDoor('1202', 'DH12')]

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(6)
    expect(sets[0].items[1].qty).toBe(4)
  })

  it('skips sets where both leafCount and doorCount are <= 1', () => {
    const sets = [makeSet('DH13', [
      { name: 'Hinge', qty: 3 },
    ], { heading_leaf_count: 1, heading_door_count: 1 })]
    const doors = [makeDoor('1301', 'DH13')]

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(3)
    expect(sets[0].items[0].qty_source).toBeUndefined()
  })

  // === Unknown items fall back to legacy behavior ===

  it('divides unknown items by leaf then door (legacy fallback)', () => {
    // "Widget XYZ" doesn't match any taxonomy category.
    // Should try leaf (6/2=3 ✓), same as old behavior.
    const sets = [makeSet('DH14', [
      { name: 'Widget XYZ-123', qty: 6 },
    ], { heading_leaf_count: 2, heading_door_count: 3 })]
    const doors = [makeDoor('1401', 'DH14'), makeDoor('1402', 'DH14'), makeDoor('1403', 'DH14')]

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(3)
    expect(sets[0].items[0].qty_door_count).toBe(2) // divided by leafCount
    expect(sets[0].items[0].qty_source).toBe('divided')
  })

  it('falls back to door count if leaf division is not integer', () => {
    // "Widget" qty=9, leafCount=2 (9/2=4.5 ✗), doorCount=3 (9/3=3 ✓)
    const sets = [makeSet('DH15', [
      { name: 'Widget ABC', qty: 9 },
    ], { heading_leaf_count: 2, heading_door_count: 3 })]
    const doors = [makeDoor('1501', 'DH15'), makeDoor('1502', 'DH15'), makeDoor('1503', 'DH15')]

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(3)
    expect(sets[0].items[0].qty_door_count).toBe(3) // divided by doorCount
  })

  // === Door count from doorsPerSet map ===

  it('derives door count from doors list when heading_door_count is missing', () => {
    // No heading_door_count, but 3 doors are assigned to this set.
    const sets = [makeSet('DH16', [
      { name: 'Lockset', qty: 3 },
    ])]
    const doors = [
      makeDoor('1601', 'DH16'),
      makeDoor('1602', 'DH16'),
      makeDoor('1603', 'DH16'),
    ]

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(1)
    expect(sets[0].items[0].qty_source).toBe('divided')
  })

  // === Mixed items in one set ===

  it('applies different division strategies per item in the same set', () => {
    // Pair door set: 2 leaves, 1 opening (pair).
    // Heading says "For 4 Doors" (4 openings are pairs → 8 leaves total? No, let's be specific).
    // Set heading: "For 2 Pair Doors" → heading_door_count=2, heading_leaf_count=4
    const sets = [makeSet('DH17', [
      { name: 'Butt Hinge 4.5x4.5', qty: 12 },   // per_leaf → 12/4 = 3 per leaf ✓
      { name: 'Closer LCN 4040XP', qty: 2 },       // per_opening → 2/2 = 1 per opening ✓
      { name: 'Coordinator Ives COR', qty: 1 },     // per_pair → no division ✓
      { name: 'Threshold Pemko 171A', qty: 1 },     // per_frame → no division ✓
      { name: 'Mortise Lockset', qty: 2 },           // per_opening → 2/2 = 1 per opening ✓
    ], { heading_leaf_count: 4, heading_door_count: 2 })]
    const doors = [makeDoor('1701', 'DH17'), makeDoor('1702', 'DH17')]

    normalizeQuantities(sets, doors)

    // Hinges: 12 → 3 (÷ 4 leaves)
    expect(sets[0].items[0].qty).toBe(3)
    expect(sets[0].items[0].qty_source).toBe('divided')

    // Closer: 2 → 1 (÷ 2 doors)
    expect(sets[0].items[1].qty).toBe(1)
    expect(sets[0].items[1].qty_source).toBe('divided')

    // Coordinator: stays at 1 (per_pair, never divide)
    expect(sets[0].items[2].qty).toBe(1)
    expect(sets[0].items[2].qty_source).toBeUndefined()

    // Threshold: stays at 1 (per_frame, never divide)
    expect(sets[0].items[3].qty).toBe(1)
    expect(sets[0].items[3].qty_source).toBeUndefined()

    // Lockset: 2 → 1 (÷ 2 doors)
    expect(sets[0].items[4].qty).toBe(1)
    expect(sets[0].items[4].qty_source).toBe('divided')
  })

  // === No division when qty < divisor ===

  it('does not divide when qty is less than the divisor', () => {
    // 2 closers across 4 doors: 2/4 = 0.5 → not integer → skip
    const sets = [makeSet('DH18', [
      { name: 'Closer', qty: 2 },
    ], { heading_door_count: 4 })]
    const doors = [
      makeDoor('1801', 'DH18'), makeDoor('1802', 'DH18'),
      makeDoor('1803', 'DH18'), makeDoor('1804', 'DH18'),
    ]

    normalizeQuantities(sets, doors)

    // qty stays at 2 — 2 < 4 so division is skipped
    expect(sets[0].items[0].qty).toBe(2)
    expect(sets[0].items[0].qty_source).toBeUndefined()
  })
})

// ─── normalizeDoorNumber ───

describe('normalizeDoorNumber', () => {
  it('leaves clean door numbers unchanged', () => {
    expect(normalizeDoorNumber('110-02A')).toBe('110-02A')
    expect(normalizeDoorNumber('DH1.01')).toBe('DH1.01')
  })

  it('uppercases lowercase characters', () => {
    expect(normalizeDoorNumber('110-02a')).toBe('110-02A')
    expect(normalizeDoorNumber('dh1.01')).toBe('DH1.01')
  })

  it('strips leading/trailing whitespace', () => {
    expect(normalizeDoorNumber('  110-02A ')).toBe('110-02A')
  })

  it('collapses internal whitespace', () => {
    expect(normalizeDoorNumber('110 02A')).toBe('11002A')
    expect(normalizeDoorNumber('110  02 A')).toBe('11002A')
  })

  it('handles empty/nullish input', () => {
    expect(normalizeDoorNumber('')).toBe('')
    // @ts-expect-error — runtime guard accepts null
    expect(normalizeDoorNumber(null)).toBe('')
    // @ts-expect-error — runtime guard accepts undefined
    expect(normalizeDoorNumber(undefined)).toBe('')
  })
})

// ─── buildDoorToSetMap ───

describe('buildDoorToSetMap', () => {
  function makeSetWithDoors(
    set_id: string,
    heading_doors: string[],
    generic_set_id?: string,
  ): HardwareSet {
    return {
      set_id,
      generic_set_id,
      heading: '',
      heading_doors,
      items: [],
    }
  }

  it('returns an empty map when hardwareSets is empty', () => {
    const map = buildDoorToSetMap([])
    expect(map.size).toBe(0)
  })

  it('maps each door to its specific sub-set (multi-heading case)', () => {
    const dh4a0 = makeSetWithDoors('DH4A.0', ['110-08A', '110A-04A', '110A-05A'], 'DH4A')
    const dh4a1 = makeSetWithDoors('DH4A.1', ['110-02A', '110-02B', '110-03A'], 'DH4A')
    const map = buildDoorToSetMap([dh4a0, dh4a1])

    expect(map.get('110-08A')).toBe(dh4a0)
    expect(map.get('110A-04A')).toBe(dh4a0)
    expect(map.get('110-02A')).toBe(dh4a1)
    expect(map.get('110-03A')).toBe(dh4a1)
    expect(map.size).toBe(6)
  })

  it('normalizes door number keys (case + whitespace)', () => {
    const set = makeSetWithDoors('DH1', ['110-02a ', ' 110-02b'])
    const map = buildDoorToSetMap([set])

    // Lookup works with either format
    expect(map.get('110-02A')).toBe(set)
    expect(map.get('110-02B')).toBe(set)
  })

  it('uses first-wins semantics for duplicate door numbers', () => {
    const first = makeSetWithDoors('DH1', ['110-02A'])
    const second = makeSetWithDoors('DH2', ['110-02A'])
    const map = buildDoorToSetMap([first, second])

    expect(map.get('110-02A')).toBe(first)
  })

  it('handles sets without heading_doors gracefully', () => {
    const setWith = makeSetWithDoors('DH1', ['110-02A'])
    const setWithout: HardwareSet = {
      set_id: 'DH2',
      heading: '',
      items: [],
      // no heading_doors field
    }
    const map = buildDoorToSetMap([setWith, setWithout])

    expect(map.get('110-02A')).toBe(setWith)
    expect(map.size).toBe(1)
  })

  it('ignores empty door strings in heading_doors', () => {
    const set = makeSetWithDoors('DH1', ['', '110-02A', '   '])
    const map = buildDoorToSetMap([set])

    expect(map.size).toBe(1)
    expect(map.get('110-02A')).toBe(set)
  })
})

// ─── buildDefinedSetIds + findDoorsWithUnmatchedSets ───
//
// Regression tests for the Radius DC "Cannot save: 6 Door(s) reference
// hardware sets that don't exist" bug from 2026-04-11. The save-path
// validation was comparing door.hw_set against set.set_id only, missing
// the generic_set_id fallback, and was not excluding by_others doors.

describe('buildDefinedSetIds', () => {
  function makeSet(set_id: string, generic_set_id?: string): HardwareSet {
    return {
      set_id,
      generic_set_id,
      heading: `Heading ${set_id}`,
      items: [],
    }
  }

  it('includes both set_id and generic_set_id when they differ', () => {
    const ids = buildDefinedSetIds([
      makeSet('DH4A.0', 'DH4A'),
      makeSet('DH4A.1', 'DH4A'),
    ])

    expect(ids.has('DH4A.0')).toBe(true)
    expect(ids.has('DH4A.1')).toBe(true)
    expect(ids.has('DH4A')).toBe(true)
  })

  it('does not duplicate when set_id equals generic_set_id', () => {
    const ids = buildDefinedSetIds([
      makeSet('DH1', 'DH1'),
    ])

    expect(ids.size).toBe(1)
    expect(ids.has('DH1')).toBe(true)
  })

  it('returns empty set for empty hardwareSets input', () => {
    expect(buildDefinedSetIds([]).size).toBe(0)
  })

  it('handles sets with no generic_set_id', () => {
    const ids = buildDefinedSetIds([makeSet('DH5.0')])

    expect(ids.size).toBe(1)
    expect(ids.has('DH5.0')).toBe(true)
  })
})

describe('findDoorsWithUnmatchedSets', () => {
  function makeDoor(
    door_number: string,
    hw_set: string,
    by_others = false,
  ): DoorEntry {
    return {
      door_number,
      hw_set,
      by_others,
      door_type: null,
      frame_type: null,
      fire_rating: null,
      hand: null,
      location: null,
    } as unknown as DoorEntry
  }

  it('matches doors by generic_set_id when set_id differs (Radius DC regression)', () => {
    // This is the exact scenario from the 2026-04-11 production bug:
    // doors reference the generic parent id "DH4A" while the sets are
    // stored under specific sub-heading ids "DH4A.0" and "DH4A.1".
    const sets: HardwareSet[] = [
      { set_id: 'DH4A.0', generic_set_id: 'DH4A', heading: '', items: [] },
      { set_id: 'DH4A.1', generic_set_id: 'DH4A', heading: '', items: [] },
    ]
    const doors = [
      makeDoor('110-02A', 'DH4A'), // generic reference — must match
      makeDoor('110-08A', 'DH4A'),
    ]
    const definedSetIds = buildDefinedSetIds(sets)
    const unmatched = findDoorsWithUnmatchedSets(doors, definedSetIds)

    expect(unmatched).toHaveLength(0)
  })

  it('excludes by_others doors from the unmatched list', () => {
    const sets: HardwareSet[] = [{ set_id: 'DH1', heading: '', items: [] }]
    const doors = [
      makeDoor('100A', 'DH1'),
      makeDoor('100B', 'N/A', true), // by-others, intentionally unassigned
      makeDoor('100C', '', true), // by-others with empty hw_set
    ]
    const definedSetIds = buildDefinedSetIds(sets)
    const unmatched = findDoorsWithUnmatchedSets(doors, definedSetIds)

    expect(unmatched).toHaveLength(0)
  })

  it('flags genuine unmatched references', () => {
    const sets: HardwareSet[] = [{ set_id: 'DH1', heading: '', items: [] }]
    const doors = [
      makeDoor('100A', 'DH1'),
      makeDoor('100B', 'INVALID-SET'),
    ]
    const definedSetIds = buildDefinedSetIds(sets)
    const unmatched = findDoorsWithUnmatchedSets(doors, definedSetIds)

    expect(unmatched).toHaveLength(1)
    expect(unmatched[0].door_number).toBe('100B')
  })

  it('skips doors with empty hw_set', () => {
    const sets: HardwareSet[] = [{ set_id: 'DH1', heading: '', items: [] }]
    const doors = [
      makeDoor('100A', 'DH1'),
      makeDoor('100B', ''),
    ]
    const definedSetIds = buildDefinedSetIds(sets)
    const unmatched = findDoorsWithUnmatchedSets(doors, definedSetIds)

    expect(unmatched).toHaveLength(0)
  })

  it('handles a mix of matched, by_others, and unmatched doors', () => {
    // This simulates roughly the Radius DC data shape: some doors match
    // via generic_set_id, some are by_others, and a few have genuinely
    // bad references. Only the bad ones should be reported.
    const sets: HardwareSet[] = [
      { set_id: 'DH4A.0', generic_set_id: 'DH4A', heading: '', items: [] },
      { set_id: 'DH1-10', heading: '', items: [] },
    ]
    const doors = [
      makeDoor('110-02A', 'DH4A'), // match via generic
      makeDoor('110-01A', 'DH1-10'), // direct match
      makeDoor('120-04B', 'N/A', true), // by-others
      makeDoor('ORPHAN-1', 'DH99'), // genuinely unmatched
    ]
    const definedSetIds = buildDefinedSetIds(sets)
    const unmatched = findDoorsWithUnmatchedSets(doors, definedSetIds)

    expect(unmatched).toHaveLength(1)
    expect(unmatched[0].door_number).toBe('ORPHAN-1')
  })
})
