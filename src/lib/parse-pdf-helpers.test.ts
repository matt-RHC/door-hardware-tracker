import { describe, it, expect } from 'vitest'
import {
  normalizeQuantities,
  normalizeDoorNumber,
  buildDoorToSetMap,
  buildDefinedSetIds,
  findDoorsWithUnmatchedSets,
  parseOpeningSize,
  detectIsPair,
  buildPerOpeningItems,
  computeLeafSide,
  applyCorrections,
  findItemFuzzy,
} from './parse-pdf-helpers'
import type { HardwareSet, DoorEntry, PunchyCorrections } from '@/lib/types'

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

  it('does not re-normalize Punchy-corrected or user-authored qty_sources', () => {
    // Regression test for the P0 bug where normalizeQuantities divided qty
    // values that were already final (per-opening) because the skip list
    // only covered 'divided' / 'flagged' / 'capped'. Every terminal
    // qty_source in NEVER_RENORMALIZE must survive a normalize pass unchanged.
    //
    // Scenario: pair-door set with 2 leaves and 2 doors. Each item below has
    // a per-opening qty that, if wrongly re-divided by leafCount=2, would
    // become half its intended value.
    const sets = [makeSet('DH_TERMINAL', [
      { name: 'Hinge', qty: 4, qty_source: 'llm_override' },
      { name: 'Closer', qty: 2, qty_source: 'auto_corrected' },
      { name: 'Exit Device', qty: 2, qty_source: 'deep_extract' },
      { name: 'Lockset', qty: 2, qty_source: 'region_extract' },
      { name: 'Flush Bolt', qty: 2, qty_source: 'propagated' },
      { name: 'Kick Plate', qty: 2, qty_source: 'reverted' },
      { name: 'Wire Harness', qty: 2, qty_source: 'manual_placeholder' },
    ], { heading_leaf_count: 2, heading_door_count: 2 })]
    const doors = [makeDoor('2001', 'DH_TERMINAL'), makeDoor('2002', 'DH_TERMINAL')]

    normalizeQuantities(sets, doors)

    // Every item must keep its original qty and qty_source.
    expect(sets[0].items[0].qty).toBe(4)
    expect(sets[0].items[0].qty_source).toBe('llm_override')
    expect(sets[0].items[1].qty).toBe(2)
    expect(sets[0].items[1].qty_source).toBe('auto_corrected')
    expect(sets[0].items[2].qty).toBe(2)
    expect(sets[0].items[2].qty_source).toBe('deep_extract')
    expect(sets[0].items[3].qty).toBe(2)
    expect(sets[0].items[3].qty_source).toBe('region_extract')
    expect(sets[0].items[4].qty).toBe(2)
    expect(sets[0].items[4].qty_source).toBe('propagated')
    expect(sets[0].items[5].qty).toBe(2)
    expect(sets[0].items[5].qty_source).toBe('reverted')
    expect(sets[0].items[6].qty).toBe(2)
    expect(sets[0].items[6].qty_source).toBe('manual_placeholder')
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

// ─── parseOpeningSize ───
//
// Regression tests for DFH opening-size format parsing. Used as a
// secondary signal in detectIsPair when heading_leaf_count is missing.

describe('parseOpeningSize', () => {
  it('parses explicit feet/inches with quotes and x separator', () => {
    const r = parseOpeningSize('3\'0" x 7\'0"')
    expect(r).toEqual({ widthIn: 36, heightIn: 84 })
  })

  it('parses feet/inches with multiplication sign', () => {
    const r = parseOpeningSize('3\'0" × 7\'0"')
    expect(r).toEqual({ widthIn: 36, heightIn: 84 })
  })

  it('parses feet/inches with dash separator (architectural style)', () => {
    const r = parseOpeningSize('3\'-0" x 7\'-0"')
    expect(r).toEqual({ widthIn: 36, heightIn: 84 })
  })

  it('parses feet/inches with space separator', () => {
    const r = parseOpeningSize('3\' 0" x 7\' 0"')
    expect(r).toEqual({ widthIn: 36, heightIn: 84 })
  })

  it('parses 6\'0" pair door as 72 inches wide', () => {
    const r = parseOpeningSize('6\'0" x 7\'0"')
    expect(r).toEqual({ widthIn: 72, heightIn: 84 })
  })

  it('parses compressed 4-digit format 3070 as 3\'0" x 7\'0"', () => {
    expect(parseOpeningSize('3070')).toEqual({ widthIn: 36, heightIn: 84 })
  })

  it('parses compressed 4-digit 3068 as 3\'0" x 6\'8"', () => {
    expect(parseOpeningSize('3068')).toEqual({ widthIn: 36, heightIn: 80 })
  })

  it('parses compressed 6080 as 6\'0" x 8\'0" (pair)', () => {
    expect(parseOpeningSize('6080')).toEqual({ widthIn: 72, heightIn: 96 })
  })

  it('parses compressed 3470 as 3\'4" x 7\'0"', () => {
    expect(parseOpeningSize('3470')).toEqual({ widthIn: 40, heightIn: 84 })
  })

  it('rejects compressed digits outside plausible range', () => {
    // "1020" → 1'0" × 2'0" = 12" × 24" — too small to be a door
    expect(parseOpeningSize('1020')).toBeNull()
    // "9999" → 9'9" × 9'9" = 117" × 117" height fails (> 144 allowed but
    // 117 is fine, so this should actually parse — bumping to something
    // truly out of range)
    // Actually 9999 parses to {117, 117} which passes the check. Use
    // something that's actually too small:
    expect(parseOpeningSize('0000')).toBeNull()
  })

  it('parses pure inches format "36 x 84"', () => {
    expect(parseOpeningSize('36 x 84')).toEqual({ widthIn: 36, heightIn: 84 })
  })

  it('parses pure inches with quotes "36\" × 84\""', () => {
    expect(parseOpeningSize('36" × 84"')).toEqual({ widthIn: 36, heightIn: 84 })
  })

  it('converts metric millimeters "914 x 2134" to inches', () => {
    // 914mm ≈ 36 in, 2134mm ≈ 84 in — standard commercial door in metric
    const r = parseOpeningSize('914 x 2134')
    expect(r).not.toBeNull()
    expect(r!.widthIn).toBeCloseTo(36, 0)
    expect(r!.heightIn).toBeCloseTo(84, 0)
  })

  it('returns null for unparseable text', () => {
    expect(parseOpeningSize('Type A')).toBeNull()
    expect(parseOpeningSize('HMD')).toBeNull()
    expect(parseOpeningSize('')).toBeNull()
    expect(parseOpeningSize(null)).toBeNull()
    expect(parseOpeningSize(undefined)).toBeNull()
  })
})

// ─── detectIsPair ───
//
// Tests the 3-tier layered pair detection used by buildPerOpeningItems.
// The primary signal (heading_leaf_count > heading_door_count) is the
// Radius DC regression case — the other tiers are fallbacks for PDFs
// where the primary signal is missing.

describe('detectIsPair', () => {
  it('PRIMARY: returns true when heading_leaf_count > heading_door_count', () => {
    // The exact Radius DC DH4A.1 shape: 8 pair doors = 16 leaves
    const set: HardwareSet = {
      set_id: 'DH4A.1',
      heading: 'Heading #DH4A.1', // no "pair" keyword
      heading_door_count: 8,
      heading_leaf_count: 16,
      items: [],
    }
    const doorInfo = { door_type: 'A' } // no "pr" keyword
    expect(detectIsPair(set, doorInfo)).toBe(true)
  })

  it('PRIMARY: returns false when heading_leaf_count equals heading_door_count', () => {
    const set: HardwareSet = {
      set_id: 'DH1',
      heading: 'Heading #DH1',
      heading_door_count: 5,
      heading_leaf_count: 5,
      items: [],
    }
    expect(detectIsPair(set, { door_type: 'A' })).toBe(false)
  })

  it('SECONDARY: returns true when opening size width >= 48" via door_type', () => {
    // The set has no leaf_count info; the door_type field contains a
    // 6070 size code which parses to 72" wide (pair range).
    const set: HardwareSet = {
      set_id: 'GENERIC',
      heading: 'Heading #GENERIC',
      items: [],
    }
    const doorInfo = { door_type: '6070' } // 6'0" x 7'0" = 72" wide
    expect(detectIsPair(set, doorInfo)).toBe(true)
  })

  it('SECONDARY: returns true for explicit "6\'0\" x 7\'0\"" in heading text', () => {
    const set: HardwareSet = {
      set_id: 'X',
      heading: 'Heading #X 6\'0" x 7\'0" HMD',
      items: [],
    }
    expect(detectIsPair(set, { door_type: 'A' })).toBe(true)
  })

  it('SECONDARY: returns false for 3070 single door width', () => {
    const set: HardwareSet = { set_id: 'X', heading: 'H', items: [] }
    expect(detectIsPair(set, { door_type: '3070' })).toBe(false)
  })

  it('TERTIARY: keyword match on heading', () => {
    const set: HardwareSet = {
      set_id: 'X',
      heading: 'Pair Doors Heading',
      items: [],
    }
    expect(detectIsPair(set, { door_type: 'A' })).toBe(true)
  })

  it('TERTIARY: keyword match on door_type "PR"', () => {
    const set: HardwareSet = { set_id: 'X', heading: 'H', items: [] }
    expect(detectIsPair(set, { door_type: 'PR' })).toBe(true)
  })

  it('returns false when none of the signals match', () => {
    const set: HardwareSet = {
      set_id: 'DH1',
      heading: 'Heading #DH1',
      heading_door_count: 3,
      heading_leaf_count: 3,
      items: [],
    }
    expect(detectIsPair(set, { door_type: 'A' })).toBe(false)
  })

  it('handles missing hwSet gracefully', () => {
    expect(detectIsPair(undefined, { door_type: 'A' })).toBe(false)
    expect(detectIsPair(undefined, undefined)).toBe(false)
  })
})

// ─── buildPerOpeningItems (pair-detection regression) ───
//
// Phase 2: buildPerOpeningItems stores per-leaf quantities as-is (no doubling).
// The UI renders Shared / Leaf 1 / Leaf 2 sections and handles the visual split.

describe('buildPerOpeningItems — pair detection', () => {
  it('stores per-leaf quantities without doubling and adds 2 Door rows for pair openings', () => {
    // Exact Radius DC DH4A.1 shape: 8 pair doors, 16 leaves, 56 hinges
    // (which is 56/16=3.5 per leaf, rounded to qty=4 by Python's
    // normalize_quantities fix). Phase 2 stores qty=4 as-is (per-leaf),
    // and the UI shows "4 on Leaf 1 + 4 on Leaf 2".
    // Each item has qty_door_count reflecting what divisor Python used.
    const hwSet: HardwareSet = {
      set_id: 'DH4A.1',
      generic_set_id: 'DH4A',
      heading: 'Heading #DH4A.1', // no "pair" keyword — relies on leaf count
      heading_door_count: 8,
      heading_leaf_count: 16,
      heading_doors: ['120-02A'],
      items: [
        { qty: 4, qty_total: 56, qty_door_count: 16, qty_source: 'flagged', name: 'Hinges 5BB1 4.5x4.5 NRP', model: '', finish: '', manufacturer: '' },
        { qty: 1, qty_total: 8, qty_door_count: 16, qty_source: 'divided', name: 'Hinges 5BB1 4.5x4.5 CON TW8', model: '', finish: '', manufacturer: '' },
        { qty: 1, qty_total: 8, qty_door_count: 8, qty_source: 'divided', name: 'Flush Bolt Kit FB32', model: '', finish: '', manufacturer: '' },
        { qty: 1, qty_total: 8, qty_door_count: 8, qty_source: 'divided', name: 'Exit Device 9875L-F', model: '', finish: '', manufacturer: '' },
        { qty: 2, qty_total: 16, qty_door_count: 8, qty_source: 'divided', name: 'Closer 4040XP EDA', model: '', finish: '', manufacturer: '' },
        { qty: 2, qty_total: 16, qty_door_count: 8, qty_source: 'divided', name: 'Smoke Seal 5075', model: '', finish: '', manufacturer: '' },
      ],
    }
    const openings = [
      { id: 'opening-1', door_number: '120-02A', hw_set: 'DH4A' },
    ]
    const doorInfoMap = new Map<string, { door_type: string; frame_type: string }>([
      ['120-02A', { door_type: 'A', frame_type: 'F2' }],
    ])
    const setMap = new Map<string, HardwareSet>([['DH4A', hwSet]])
    const doorToSetMap = new Map<string, HardwareSet>([['120-02A', hwSet]])

    const rows = buildPerOpeningItems(openings, doorInfoMap, setMap, doorToSetMap)

    // Should have 2 Door rows (Active + Inactive), 1 Frame, and 6 hardware items
    const doorRows = rows.filter(r => (r.name as string).startsWith('Door'))
    expect(doorRows).toHaveLength(2)
    expect(doorRows.map(r => r.name)).toEqual([
      'Door (Active Leaf)',
      'Door (Inactive Leaf)',
    ])

    const frameRows = rows.filter(r => r.name === 'Frame')
    expect(frameRows).toHaveLength(1)
    expect(frameRows[0].qty).toBe(1)

    // Per-leaf items stored as-is (no doubling). UI will show on each leaf section.
    const hingeNrp = rows.find(r => (r.name as string).includes('5BB1 4.5x4.5 NRP'))
    expect(hingeNrp?.qty).toBe(4) // stored per-leaf, NOT doubled

    // CON TW8 hinge also stored per-leaf
    const hingeCon = rows.find(r => (r.name as string).includes('CON TW8'))
    expect(hingeCon?.qty).toBe(1)

    // Per-pair item NOT doubled
    const flushBolt = rows.find(r => (r.name as string).includes('Flush Bolt Kit'))
    expect(flushBolt?.qty).toBe(1)

    // Per-opening items NOT doubled (closer is per_opening, qty stays at 2)
    const closer = rows.find(r => (r.name as string).includes('Closer'))
    expect(closer?.qty).toBe(2)

    // per_frame item NOT doubled (smoke seal is per_frame)
    const smokeSeal = rows.find(r => (r.name as string).includes('Smoke Seal'))
    expect(smokeSeal?.qty).toBe(2)
  })

  it('does NOT double per-leaf items for single-door openings', () => {
    const hwSet: HardwareSet = {
      set_id: 'DH3.0',
      generic_set_id: 'DH3',
      heading: 'Heading #DH3.0',
      heading_door_count: 2,
      heading_leaf_count: 2,
      heading_doors: ['110-02C'],
      items: [
        { qty: 3, name: 'Hinges 5BB1', model: '', finish: '', manufacturer: '' },
      ],
    }
    const openings = [
      { id: 'opening-1', door_number: '110-02C', hw_set: 'DH3' },
    ]
    const doorInfoMap = new Map([
      ['110-02C', { door_type: 'A', frame_type: 'F1' }],
    ])
    const setMap = new Map([['DH3', hwSet]])
    const doorToSetMap = new Map([['110-02C', hwSet]])

    const rows = buildPerOpeningItems(openings, doorInfoMap, setMap, doorToSetMap)

    // Single door → 1 "Door" row (not Active/Inactive Leaf)
    const doorRows = rows.filter(r => (r.name as string).startsWith('Door'))
    expect(doorRows).toHaveLength(1)
    expect(doorRows[0].name).toBe('Door')

    // Hinge qty NOT doubled (single door)
    const hinge = rows.find(r => (r.name as string).includes('Hinges'))
    expect(hinge?.qty).toBe(3)
  })

  it('detects pair via opening size when leaf count is missing', () => {
    // Simulates an older PDF format where Python didn't capture
    // heading_leaf_count but the door_type field has a size code.
    const hwSet: HardwareSet = {
      set_id: 'X',
      heading: 'Generic',
      items: [
        { qty: 4, name: 'Hinges', model: '', finish: '', manufacturer: '' },
      ],
    }
    const openings = [
      { id: 'opening-1', door_number: '100A', hw_set: 'X' },
    ]
    // door_type "6080" parses to 72" × 96" (pair width)
    const doorInfoMap = new Map([
      ['100A', { door_type: '6080', frame_type: 'F1' }],
    ])
    const setMap = new Map([['X', hwSet]])
    const doorToSetMap = new Map<string, HardwareSet>()

    const rows = buildPerOpeningItems(openings, doorInfoMap, setMap, doorToSetMap)

    const doorRows = rows.filter(r => (r.name as string).startsWith('Door'))
    expect(doorRows).toHaveLength(2) // pair detected via size
    const hinge = rows.find(r => r.name === 'Hinges')
    expect(hinge?.qty).toBe(4) // stored per-leaf, UI handles the split
  })
})

// ── Phase 3 (leaf_side) tests ─────────────────────────────────────────

describe('computeLeafSide — per-item leaf attribution', () => {
  it('returns shared for Frame rows', () => {
    expect(computeLeafSide('Frame', 1)).toBe('shared')
    expect(computeLeafSide('Frame', 2)).toBe('shared')
  })

  it('returns active for Door (Active Leaf)', () => {
    expect(computeLeafSide('Door (Active Leaf)', 2)).toBe('active')
  })

  it('returns inactive for Door (Inactive Leaf)', () => {
    expect(computeLeafSide('Door (Inactive Leaf)', 2)).toBe('inactive')
  })

  it('returns active for a bare Door on a single opening', () => {
    expect(computeLeafSide('Door', 1)).toBe('active')
  })

  it('returns null for a bare Door on a pair opening (unexpected shape)', () => {
    // Pair openings should have been split into active + inactive rows
    // by buildPerOpeningItems. If we see 'Door' on a pair it's data from
    // a pre-Phase-2 save — let render-time classification handle it.
    expect(computeLeafSide('Door', 2)).toBeNull()
  })

  it('returns shared for per_pair items (coordinator, flush bolt, astragal)', () => {
    expect(computeLeafSide('Coordinator', 2)).toBe('shared')
    expect(computeLeafSide('Flush Bolt Kit FB32', 2)).toBe('shared')
    expect(computeLeafSide('Astragal', 2)).toBe('shared')
  })

  it('returns shared for per_frame items (threshold, seals, silencer)', () => {
    expect(computeLeafSide('Threshold 655BK', 2)).toBe('shared')
    expect(computeLeafSide('Gasketing', 2)).toBe('shared')
    expect(computeLeafSide('Silencer', 2)).toBe('shared')
    expect(computeLeafSide('Weatherstrip', 2)).toBe('shared')
  })

  it('returns null for per_leaf items on pairs (ambiguous — render-time decides)', () => {
    // Hinges, exit devices, kick plates: could go on active, inactive,
    // or both leaves depending on spec. Keep NULL so the UI keeps the
    // existing behavior until the triage UI lets users set it explicitly.
    expect(computeLeafSide('Hinges 5BB1 4.5x4.5 NRP', 2)).toBeNull()
    expect(computeLeafSide('Exit Device 9875', 2)).toBeNull()
    expect(computeLeafSide('Kick Plate', 2)).toBeNull()
  })

  it('returns null for per_opening items on pairs (ambiguous)', () => {
    expect(computeLeafSide('Closer 4040XP', 2)).toBeNull()
    expect(computeLeafSide('Mortise Lockset L9080', 2)).toBeNull()
  })

  it('returns null for unknown / unclassified items', () => {
    expect(computeLeafSide('Widget XYZ-123', 2)).toBeNull()
  })
})

// ─── findItemFuzzy — correction name matcher ───

describe('findItemFuzzy', () => {
  const items = [
    { name: 'Hinge', qty: 3, model: '', finish: '', manufacturer: '' },
    { name: 'Spring Hinge', qty: 1, model: '', finish: '', manufacturer: '' },
    { name: 'Closer', qty: 1, model: '', finish: '', manufacturer: '' },
  ]

  it('returns exact-name hits', () => {
    expect(findItemFuzzy(items, 'Hinge', 't')?.name).toBe('Hinge')
    expect(findItemFuzzy(items, 'Spring Hinge', 't')?.name).toBe('Spring Hinge')
  })

  it('returns case-insensitive hits', () => {
    expect(findItemFuzzy(items, 'HINGE', 't')?.name).toBe('Hinge')
    expect(findItemFuzzy(items, 'spring hinge', 't')?.name).toBe('Spring Hinge')
  })

  it('does NOT substring-match "Hinge" onto "Spring Hinge"', () => {
    // Historical bug: bidirectional substring match flipped the wrong item
    // when a set had multiple hinge variants. Only exact + CI should win.
    const onlySpring = [
      { name: 'Spring Hinge', qty: 1, model: '', finish: '', manufacturer: '' },
    ]
    expect(findItemFuzzy(onlySpring, 'Hinge', 't')).toBeUndefined()
  })

  it('does NOT match a verbose name to a terse item ("Heavy-Duty Hinge" → "Hinge")', () => {
    expect(findItemFuzzy(items, 'Heavy-Duty Hinge', 't')).toBeUndefined()
  })

  it('returns undefined when no exact or CI match exists', () => {
    expect(findItemFuzzy(items, 'Pivot', 't')).toBeUndefined()
  })
})

// ─── applyCorrections — Punchy correction ingestion ───

describe('applyCorrections', () => {
  function makeHardwareItem(name: string, qty: number) {
    return { name, qty, model: '', finish: '', manufacturer: '' }
  }

  function makeDoorEntry(door_number: string, hw_set: string): DoorEntry {
    return {
      door_number,
      hw_set,
      door_type: null,
      frame_type: null,
      fire_rating: null,
      hand: null,
      location: null,
    } as unknown as DoorEntry
  }

  it('applies items_to_fix via exact-name match', () => {
    const sets: HardwareSet[] = [
      { set_id: 'DH1', heading: 'Set DH1', items: [makeHardwareItem('Hinges', 6)] },
    ]
    const doors: DoorEntry[] = []
    const corrections: PunchyCorrections = {
      hardware_sets_corrections: [
        {
          set_id: 'DH1',
          items_to_fix: [
            { name: 'Hinges', field: 'qty', old_value: '6', new_value: '3' },
          ],
        },
      ],
    }
    applyCorrections(sets, doors, corrections)
    expect(sets[0].items?.[0].qty).toBe(3)
    expect(sets[0].items?.[0].qty_source).toBe('llm_override')
  })

  it('resolves set_id via generic_set_id fallback, applying to every sub-variant', () => {
    const sets: HardwareSet[] = [
      {
        set_id: 'DH4A.0',
        generic_set_id: 'DH4A',
        heading: 'Set DH4A.0',
        items: [makeHardwareItem('Closer', 2)],
      },
      {
        set_id: 'DH4A.1',
        generic_set_id: 'DH4A',
        heading: 'Set DH4A.1',
        items: [makeHardwareItem('Closer', 2)],
      },
      {
        set_id: 'DH5',
        generic_set_id: 'DH5',
        heading: 'Set DH5',
        items: [makeHardwareItem('Closer', 2)],
      },
    ]
    const corrections: PunchyCorrections = {
      hardware_sets_corrections: [
        {
          set_id: 'DH4A', // generic — should land on both DH4A.0 and DH4A.1
          items_to_fix: [
            { name: 'Closer', field: 'qty', old_value: '2', new_value: '1' },
          ],
        },
      ],
    }
    applyCorrections(sets, [], corrections)
    expect(sets[0].items?.[0].qty).toBe(1) // DH4A.0 fixed
    expect(sets[1].items?.[0].qty).toBe(1) // DH4A.1 fixed
    expect(sets[2].items?.[0].qty).toBe(2) // DH5 untouched
  })

  it('drops a set correction when nothing matches by id or generic_set_id', () => {
    const sets: HardwareSet[] = [
      { set_id: 'DH1', generic_set_id: 'DH1', heading: 'Set DH1', items: [makeHardwareItem('Hinges', 3)] },
    ]
    const corrections: PunchyCorrections = {
      hardware_sets_corrections: [
        {
          set_id: 'DH99',
          items_to_fix: [
            { name: 'Hinges', field: 'qty', old_value: '3', new_value: '4' },
          ],
        },
      ],
    }
    applyCorrections(sets, [], corrections)
    expect(sets[0].items?.[0].qty).toBe(3) // unchanged
  })

  it('normalizes door_number when applying doors_corrections (Punchy raw-PDF vs extracted)', () => {
    const doors: DoorEntry[] = [makeDoorEntry('11002A', 'DH1')]
    const corrections: PunchyCorrections = {
      doors_corrections: [
        {
          door_number: '110 02A', // Punchy's form, with internal space
          field: 'hw_set',
          old_value: 'DH1',
          new_value: 'DH2',
        },
      ],
    }
    applyCorrections([], doors, corrections)
    expect(doors[0].hw_set).toBe('DH2')
  })

  it('de-duplicates missing_doors using normalized door_number', () => {
    const doors: DoorEntry[] = [makeDoorEntry('11002A', 'DH1')]
    const corrections: PunchyCorrections = {
      missing_doors: [
        // Same door with spaces + lowercase — should NOT be appended
        makeDoorEntry('  110 02a  ', 'DH1'),
        makeDoorEntry('11003B', 'DH2'),
      ],
    }
    applyCorrections([], doors, corrections)
    expect(doors.length).toBe(2) // original + the genuinely new one
    expect(doors[1].door_number).toBe('11003B')
  })

  it('forwards heading metadata when pushing missing_sets', () => {
    const sets: HardwareSet[] = []
    const corrections: PunchyCorrections = {
      missing_sets: [
        {
          set_id: 'DH9.0',
          generic_set_id: 'DH9',
          heading: 'Set DH9.0',
          heading_door_count: 3,
          heading_leaf_count: 6,
          items: [{ name: 'Hinges', qty: 18, model: '', finish: '', manufacturer: '' }],
        },
      ],
    }
    applyCorrections(sets, [], corrections)
    expect(sets.length).toBe(1)
    expect(sets[0].generic_set_id).toBe('DH9')
    expect(sets[0].heading_door_count).toBe(3)
    expect(sets[0].heading_leaf_count).toBe(6)
    // With metadata forwarded, normalizeQuantities can now divide 18 ÷ 6 = 3/leaf
    normalizeQuantities(sets, [])
    expect(sets[0].items?.[0].qty).toBe(3)
  })

  it('skips inserting a missing_set already present under generic_set_id', () => {
    const sets: HardwareSet[] = [
      {
        set_id: 'DH4A.0',
        generic_set_id: 'DH4A',
        heading: 'Set DH4A.0',
        items: [makeHardwareItem('Closer', 1)],
      },
    ]
    const corrections: PunchyCorrections = {
      missing_sets: [
        {
          set_id: 'DH4A', // generic already represented by DH4A.0 above
          heading: 'Set DH4A',
          items: [{ name: 'Closer', qty: 1, model: '', finish: '', manufacturer: '' }],
        },
      ],
    }
    applyCorrections(sets, [], corrections)
    expect(sets.length).toBe(1)
  })

  it('items_to_remove tightened to exact + case-insensitive (preserves variants)', () => {
    const sets: HardwareSet[] = [
      {
        set_id: 'DH1',
        heading: 'Set DH1',
        items: [
          makeHardwareItem('Hinge', 3),
          makeHardwareItem('Spring Hinge', 1),
        ],
      },
    ]
    const corrections: PunchyCorrections = {
      hardware_sets_corrections: [
        {
          set_id: 'DH1',
          items_to_remove: ['Hinge'],
        },
      ],
    }
    applyCorrections(sets, [], corrections)
    expect(sets[0].items?.map(i => i.name)).toEqual(['Spring Hinge'])
  })
})
