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
  normalizeName,
  createAnthropicClient,
  selectRepresentativeSample,
  calculateExtractionConfidence,
} from './parse-pdf-helpers'
import type { HardwareSet, DoorEntry, PunchyCorrections } from '@/lib/types'
import { groupItemsByLeaf } from './classify-leaf-items'

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
    door_type: '',
    frame_type: '',
    fire_rating: '',
    hand: '',
    location: '',
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

  // === PATH 1: Python-annotated needs_division ===

  it('PATH 1: trusts Python qty_door_count for needs_division items (clean division)', () => {
    // This is the primary path introduced in the 2026-04-13 overhaul.
    // Python sets qty_source='needs_division' and qty_door_count=12 (leaf count
    // for 6 pair doors). TS trusts that divisor and performs the division.
    //
    // Real-world case: 5BB1 HW 4 1/2 x 4 1/2 NRP catalog-number names that
    // neither Python nor TS taxonomy can classify — Python falls back to the
    // heading count and marks needs_division so TS does the actual math.
    const sets = [makeSet('DH_PATH1_CLEAN', [
      { name: '5BB1 HW 4 1/2 x 4 1/2 NRP', qty: 36, qty_source: 'needs_division' },
    ], { heading_leaf_count: 12, heading_door_count: 6 })]
    // Manually set qty_door_count on the item (Python would set this)
    sets[0].items[0].qty_door_count = 12
    const doors = Array.from({ length: 6 }, (_, i) => makeDoor(`P1-${i + 1}`, 'DH_PATH1_CLEAN'))

    normalizeQuantities(sets, doors)

    // 36 ÷ 12 = 3 exactly → 'divided'
    expect(sets[0].items[0].qty).toBe(3)
    expect(sets[0].items[0].qty_total).toBe(36)
    expect(sets[0].items[0].qty_door_count).toBe(12)
    expect(sets[0].items[0].qty_source).toBe('divided')
  })

  it('PATH 1: rounds and flags needs_division items when result is non-integer', () => {
    // 42 hinges, Python says divisor=12 (6 pair doors × 2 leaves).
    // 42/12 = 3.5 → rounds to 4, flagged.
    const sets = [makeSet('DH_PATH1_FLAG', [
      { name: '5BB1 HW 4 1/2 x 4 1/2 NRP', qty: 42, qty_source: 'needs_division' },
    ], { heading_leaf_count: 12, heading_door_count: 6 })]
    sets[0].items[0].qty_door_count = 12
    const doors = Array.from({ length: 6 }, (_, i) => makeDoor(`P1F-${i + 1}`, 'DH_PATH1_FLAG'))

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(4)  // Math.round(3.5) = 4
    expect(sets[0].items[0].qty_total).toBe(42)
    expect(sets[0].items[0].qty_source).toBe('flagged')
  })

  it('PATH 3: sets qty=1 for rhr_lhr_pair items (RH/LH variant)', () => {
    // Python detected both RH and LH variants of the same item in one set.
    // Each door gets exactly ONE hand — qty should be 1 per variant.
    const sets = [makeSet('DH_RHR', [
      { name: 'Lockset RHR', qty: 3, qty_source: 'rhr_lhr_pair' },
    ], { heading_door_count: 3 })]
    const doors = [makeDoor('R1', 'DH_RHR'), makeDoor('R2', 'DH_RHR'), makeDoor('R3', 'DH_RHR')]

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(1)
    expect(sets[0].items[0].qty_source).toBe('divided')
  })

  it('PATH 4: needs_review items become flagged without qty change', () => {
    // Python flagged a closer alongside an auto-operator — possibly redundant.
    // TS promotes it to 'flagged' for Punchy CP3 and the user.
    const sets = [makeSet('DH_REVIEW', [
      { name: 'Closer', qty: 6, qty_source: 'needs_review' },
    ], { heading_door_count: 3 })]
    const doors = [makeDoor('NR1', 'DH_REVIEW'), makeDoor('NR2', 'DH_REVIEW'), makeDoor('NR3', 'DH_REVIEW')]

    normalizeQuantities(sets, doors)

    // qty stays at 6 — we don't divide needs_review items. Flag, don't mutate.
    expect(sets[0].items[0].qty).toBe(6)
    expect(sets[0].items[0].qty_source).toBe('flagged')
  })

  it('PATH 2: caps needs_cap items at category max (no door count available)', () => {
    // Single-door set with implausibly high qty on a closer (pdf total without count).
    // Category max for per_opening is 2. Capped to 2.
    const sets = [makeSet('DH_CAP', [
      { name: 'Closer LCN 4040XP', qty: 12, qty_source: 'needs_cap' },
    ], { heading_door_count: 1 })]
    const doors = [makeDoor('C1', 'DH_CAP')]

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(2)  // MIN(12, MAX_QTY.per_opening=2) = 2
    expect(sets[0].items[0].qty_total).toBe(12)
    expect(sets[0].items[0].qty_source).toBe('capped')
  })

  // === Hinge consolidation removed: normalizeQuantities no longer subtracts electric from standard ===
  // The per-leaf adjustment now happens in groupItemsByLeaf (wizard) and buildPerOpeningItems (save).

  it('does NOT consolidate standard + electric hinge (consolidation removed)', () => {
    // PDF lists "4 Hinges" and "1 Electric Hinge" as separate items.
    // normalizeQuantities no longer subtracts — standard stays at raw per-leaf value.
    const sets = [makeSet('DH_HINGE_CONSOL', [
      { name: 'Hinges 5BB1 4.5x4.5 NRP', qty: 4, qty_source: 'divided' },
      { name: 'Hinges 5BB1 4.5x4.5 CON TW8', qty: 1, qty_source: 'divided' },
    ], { heading_door_count: 6, heading_leaf_count: 12 })]
    const doors = Array.from({ length: 6 }, (_, i) => makeDoor(`HC-${i + 1}`, 'DH_HINGE_CONSOL'))

    normalizeQuantities(sets, doors)

    // Standard hinge: stays at 4 (no consolidation)
    expect(sets[0].items[0].qty).toBe(4)
    // Electric hinge: unchanged
    expect(sets[0].items[1].qty).toBe(1)
  })

  it('leaves standard hinge qty unchanged even when it equals electric qty', () => {
    // No consolidation in normalizeQuantities — both stay at their raw values.
    const sets = [makeSet('DH_HINGE_EQUAL', [
      { name: 'Hinge NRP', qty: 1, qty_source: 'divided' },
      { name: 'Electric Hinge CON TW8', qty: 1, qty_source: 'divided' },
    ], { heading_door_count: 2 })]
    const doors = [makeDoor('HE1', 'DH_HINGE_EQUAL'), makeDoor('HE2', 'DH_HINGE_EQUAL')]

    normalizeQuantities(sets, doors)

    // Both unchanged — no consolidation
    expect(sets[0].items[0].qty).toBe(1)
    expect(sets[0].items[1].qty).toBe(1)
  })

  it('does NOT consolidate with multiple electric hinges in the same set', () => {
    // Rare but possible: 2 different electric hinge products in one set.
    // No consolidation — standard stays at raw per-leaf value.
    const sets = [makeSet('DH_MULTI_ELEC', [
      { name: 'Hinges 5BB1 NRP', qty: 5, qty_source: 'divided' },
      { name: 'Hinge CON TW8', qty: 1, qty_source: 'divided' },
      { name: 'Power Transfer Hinge EPT', qty: 1, qty_source: 'divided' },
    ], { heading_door_count: 4, heading_leaf_count: 8 })]
    const doors = Array.from({ length: 4 }, (_, i) => makeDoor(`ME-${i + 1}`, 'DH_MULTI_ELEC'))

    normalizeQuantities(sets, doors)

    // Standard: stays at 5 (no consolidation)
    expect(sets[0].items[0].qty).toBe(5)
    // Electric items unchanged
    expect(sets[0].items[1].qty).toBe(1)
    expect(sets[0].items[2].qty).toBe(1)
  })

  it('skips consolidation when no electric hinge exists in the set', () => {
    // Normal set with only standard hinges — no change
    const sets = [makeSet('DH_NO_ELEC', [
      { name: 'Hinges 5BB1 NRP', qty: 3, qty_source: 'divided' },
    ], { heading_door_count: 4 })]
    const doors = Array.from({ length: 4 }, (_, i) => makeDoor(`NE-${i + 1}`, 'DH_NO_ELEC'))

    normalizeQuantities(sets, doors)

    expect(sets[0].items[0].qty).toBe(3)
  })

  // === Mixed hinge type normalization (electric + standard on pair doors) ===

  it('handles asymmetric hinge split: 7 standard + 1 electric on single pair door', () => {
    // Single pair door (1 opening, 2 leaves). PDF shows:
    //   "Hinge, Full Mortise — 7 EA" + "Electric Hinge — 1 EA"
    // Total hinge positions: 8 (4 per leaf). Electric replaces 1 standard on active.
    // Standard 7 / 2 leaves = 3.5 — non-integer BUT explained by electric.
    // Expected: ceil(3.5) = 4 per leaf, marked 'divided' (not 'flagged').
    // No consolidation in normalizeQuantities — stays at 4.
    const sets = [makeSet('DH_ASYM', [
      { name: 'Hinges 5BB1 4.5x4.5 NRP', qty: 7 },
      { name: 'Hinges 5BB1 4.5x4.5 CON TW8', qty: 1 },
    ], { heading_leaf_count: 2, heading_door_count: 1 })]
    const doors = [makeDoor('AS1', 'DH_ASYM')]

    normalizeQuantities(sets, doors)

    // Standard hinge: 7 → 4 per leaf (ceil), no consolidation
    expect(sets[0].items[0].qty).toBe(4)
    expect(sets[0].items[0].qty_source).toBe('divided')
    // Electric hinge: unchanged (per_opening, doorCount=1, no division)
    expect(sets[0].items[1].qty).toBe(1)
  })

  it('handles asymmetric hinge split: 21 standard + 3 electric across 3 pair doors', () => {
    // 3 pair doors (3 openings, 6 leaves). PDF shows:
    //   "Hinges NRP — 21 EA" + "Electric Hinge CON TW8 — 3 EA"
    // Total positions: 24 (4 per leaf × 6 leaves). Electric = 3 (1 per opening).
    // Standard: 21/6 = 3.5 → asymmetric split explained by electric.
    // ceil(3.5) = 4. No consolidation — stays at 4.
    // Electric: per_opening, 3/3 = 1.
    const sets = [makeSet('DH_ASYM_MULTI', [
      { name: 'Hinges 5BB1 NRP', qty: 21 },
      { name: 'Hinges CON TW8', qty: 3 },
    ], { heading_leaf_count: 6, heading_door_count: 3 })]
    const doors = Array.from({ length: 3 }, (_, i) => makeDoor(`AM-${i + 1}`, 'DH_ASYM_MULTI'))

    normalizeQuantities(sets, doors)

    // Standard: 21 → 4 per leaf (ceil), no consolidation
    expect(sets[0].items[0].qty).toBe(4)
    expect(sets[0].items[0].qty_source).toBe('divided')
    // Electric: 3 ÷ 3 (doorCount) = 1
    expect(sets[0].items[1].qty).toBe(1)
  })

  it('does not apply asymmetric hinge logic when no electric hinges in set', () => {
    // Pair door with 7 standard hinges but NO electric hinge.
    // 7/2 = 3.5 → should be flagged (not explained by electric).
    const sets = [makeSet('DH_ODD_NO_ELEC', [
      { name: 'Hinges 5BB1 NRP', qty: 7 },
    ], { heading_leaf_count: 2, heading_door_count: 1 })]
    const doors = [makeDoor('ON1', 'DH_ODD_NO_ELEC')]

    normalizeQuantities(sets, doors)

    // Should be flagged because 7/2 is non-integer with no electric hinge explanation
    expect(sets[0].items[0].qty).toBe(4) // Math.round(3.5) = 4
    expect(sets[0].items[0].qty_source).toBe('flagged')
  })

  it('standard hinges divide evenly on pair doors with electric (even total)', () => {
    // 8 standard + 1 electric on a pair door. 8/2 = 4 (clean division).
    // No consolidation — standard stays at 4.
    const sets = [makeSet('DH_EVEN', [
      { name: 'Hinges 5BB1 NRP', qty: 8 },
      { name: 'Electric Hinge ETH', qty: 1 },
    ], { heading_leaf_count: 2, heading_door_count: 1 })]
    const doors = [makeDoor('EV1', 'DH_EVEN')]

    normalizeQuantities(sets, doors)

    // Standard: 8/2 = 4, no consolidation
    expect(sets[0].items[0].qty).toBe(4)
    expect(sets[0].items[0].qty_source).toBe('divided')
    // Electric: unchanged (per_opening, doorCount=1)
    expect(sets[0].items[1].qty).toBe(1)
  })

  it('single door with electric hinge: no leaf splitting needed', () => {
    // Single door (1 leaf). 3 standard + 1 electric.
    // No division needed (leafCount=1, doorCount=1).
    // No consolidation — standard stays at raw value.
    const sets = [makeSet('DH_SINGLE', [
      { name: 'Hinges 5BB1 NRP', qty: 3 },
      { name: 'Hinges CON TW8', qty: 1 },
    ], { heading_leaf_count: 1, heading_door_count: 1 })]
    const doors = [makeDoor('SG1', 'DH_SINGLE')]

    normalizeQuantities(sets, doors)

    // No division — leafCount and doorCount are both 1
    // No consolidation — standard stays at 3
    expect(sets[0].items[0].qty).toBe(3)
    expect(sets[0].items[1].qty).toBe(1)
  })

  it('PATH 1: electric hinge divisor overridden from leafCount to doorCount', () => {
    // Python annotated all items with needs_division and qty_door_count=6 (leafCount).
    // Electric hinge should use doorCount=3 instead of leafCount=6.
    const sets: HardwareSet[] = [{
      set_id: 'DH_P1_ELEC',
      heading: 'Set DH_P1_ELEC',
      heading_door_count: 3,
      heading_leaf_count: 6,
      items: [
        { name: 'Hinges 5BB1 NRP', qty: 21, qty_source: 'needs_division', qty_door_count: 6, model: '', finish: '', manufacturer: '' },
        { name: 'Hinges CON TW8', qty: 3, qty_source: 'needs_division', qty_door_count: 6, model: '', finish: '', manufacturer: '' },
      ],
    }]
    const doors = Array.from({ length: 3 }, (_, i) => makeDoor(`P1E-${i + 1}`, 'DH_P1_ELEC'))

    normalizeQuantities(sets, doors)

    // Standard: 21/6 = 3.5 → asymmetric split → ceil = 4, no consolidation
    expect(sets[0].items[0].qty).toBe(4)
    expect(sets[0].items[0].qty_source).toBe('divided')
    // Electric: divisor overridden from 6 to 3, 3/3 = 1
    expect(sets[0].items[1].qty).toBe(1)
    expect(sets[0].items[1].qty_source).toBe('divided')
    expect(sets[0].items[1].qty_door_count).toBe(3)
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

    // Should have 2 Door rows (Active + Inactive), 1 Frame, and 7 hardware items
    // (NRP hinge splits into active + inactive rows = +1 row)
    const doorRows = rows.filter(r => (r.name as string).startsWith('Door'))
    expect(doorRows).toHaveLength(2)
    expect(doorRows.map(r => r.name)).toEqual([
      'Door (Active Leaf)',
      'Door (Inactive Leaf)',
    ])

    const frameRows = rows.filter(r => r.name === 'Frame')
    expect(frameRows).toHaveLength(1)
    expect(frameRows[0].qty).toBe(1)

    // Phase 4 hinge fix: standard hinges split into per-leaf rows when
    // electric hinges are present. item.qty is the raw per-leaf value (4).
    // Active = raw − electric (4 − 1 = 3), Inactive = raw (4).
    const hingeNrpRows = rows.filter(r => (r.name as string).includes('5BB1 4.5x4.5 NRP'))
    expect(hingeNrpRows).toHaveLength(2)
    const hingeNrpActive = hingeNrpRows.find(r => r.leaf_side === 'active')
    const hingeNrpInactive = hingeNrpRows.find(r => r.leaf_side === 'inactive')
    expect(hingeNrpActive?.qty).toBe(3)  // active: raw 4 − 1 electric = 3
    expect(hingeNrpInactive?.qty).toBe(4) // inactive: raw per-leaf qty

    // CON TW8 electric hinge: active leaf only
    const hingeCon = rows.find(r => (r.name as string).includes('CON TW8'))
    expect(hingeCon?.qty).toBe(1)
    expect(hingeCon?.leaf_side).toBe('active')

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

  // Phase 4: pair door hinge fix — electric hinge → active only,
  // standard hinges split per-leaf with correct quantities.
  it('routes electric hinges to active leaf only and splits standard hinges per-leaf on pair doors', () => {
    // Simulates post-normalizeQuantities data for a pair door:
    //   Original PDF: 4 standard hinges + 1 electric hinge per leaf
    //   normalizeQuantities produces raw per-leaf: 4 standard, 1 electric (no consolidation)
    const hwSet: HardwareSet = {
      set_id: 'DH1.01',
      generic_set_id: 'DH1',
      heading: 'PAIR DOORS - DH1.01',
      heading_door_count: 2,
      heading_leaf_count: 4,
      heading_doors: ['101'],
      items: [
        { qty: 4, qty_source: 'divided', name: 'Hinges 5BB1 4.5x4.5 NRP', model: 'FBB179', finish: '652', manufacturer: 'Hager' },
        { qty: 1, qty_source: 'divided', name: 'Hinges 5BB1 4.5x4.5 CON TW8', model: 'BB1279', finish: '652', manufacturer: 'Hager' },
        { qty: 1, qty_source: 'divided', name: 'Exit Device 9875L-F', model: '', finish: '', manufacturer: 'Von Duprin' },
        { qty: 1, qty_source: 'divided', name: 'Flush Bolt Kit FB32', model: '', finish: '', manufacturer: '' },
        { qty: 1, qty_source: 'divided', name: 'Coordinator COR-1', model: '', finish: '', manufacturer: '' },
      ],
    }
    const openings = [{ id: 'opening-1', door_number: '101', hw_set: 'DH1' }]
    const doorInfoMap = new Map([['101', { door_type: 'B', frame_type: 'HM' }]])
    const setMap = new Map([['DH1', hwSet]])
    const doorToSetMap = new Map([['101', hwSet]])

    const rows = buildPerOpeningItems(openings, doorInfoMap, setMap, doorToSetMap)

    // Electric hinge: active leaf only
    const electricHinge = rows.find(r => (r.name as string).includes('CON TW8'))
    expect(electricHinge?.leaf_side).toBe('active')
    expect(electricHinge?.qty).toBe(1)

    // Standard hinges: split into active + inactive rows
    const nrpRows = rows.filter(r => (r.name as string).includes('NRP'))
    expect(nrpRows).toHaveLength(2)

    const nrpActive = nrpRows.find(r => r.leaf_side === 'active')
    expect(nrpActive?.qty).toBe(3) // raw 4 - 1 electric = 3

    const nrpInactive = nrpRows.find(r => r.leaf_side === 'inactive')
    expect(nrpInactive?.qty).toBe(4) // raw per-leaf (no subtraction on inactive)

    // Non-hinge items: unchanged behavior
    const exitDevice = rows.find(r => (r.name as string).includes('Exit Device'))
    expect(exitDevice?.leaf_side).toBeNull() // per_opening, ambiguous

    const flushBolt = rows.find(r => (r.name as string).includes('Flush Bolt'))
    expect(flushBolt?.leaf_side).toBe('shared') // per_pair → shared

    const coordinator = rows.find(r => (r.name as string).includes('Coordinator'))
    expect(coordinator?.leaf_side).toBe('shared') // per_pair → shared
  })

  it('does NOT split standard hinges when no electric hinge is present on pair doors', () => {
    const hwSet: HardwareSet = {
      set_id: 'DH2.0',
      heading: 'PAIR DOORS - DH2',
      heading_door_count: 1,
      heading_leaf_count: 2,
      items: [
        { qty: 4, name: 'Hinges 5BB1', model: '', finish: '', manufacturer: '' },
        { qty: 1, name: 'Closer 4040XP', model: '', finish: '', manufacturer: '' },
      ],
    }
    const openings = [{ id: 'op-1', door_number: '200', hw_set: 'DH2' }]
    const doorInfoMap = new Map([['200', { door_type: 'A', frame_type: 'F1' }]])
    const setMap = new Map([['DH2', hwSet]])
    const doorToSetMap = new Map([['200', hwSet]])

    const rows = buildPerOpeningItems(openings, doorInfoMap, setMap, doorToSetMap)

    // Standard hinges: single row (no split), leaf_side=null (ambiguous per_leaf)
    const hingeRows = rows.filter(r => (r.name as string).includes('Hinges'))
    expect(hingeRows).toHaveLength(1)
    expect(hingeRows[0].qty).toBe(4)
    expect(hingeRows[0].leaf_side).toBeNull() // no electric → no special treatment
  })

  it('keeps electric hinge as-is on single doors (no pair leaf splitting)', () => {
    const hwSet: HardwareSet = {
      set_id: 'DH5.0',
      heading: 'SINGLE DOOR - DH5',
      heading_door_count: 1,
      heading_leaf_count: 1,
      items: [
        { qty: 3, name: 'Hinges 5BB1 NRP', model: '', finish: '', manufacturer: '' },
        { qty: 1, name: 'Hinges CON TW8', model: '', finish: '', manufacturer: '' },
      ],
    }
    const openings = [{ id: 'op-1', door_number: '300', hw_set: 'DH5' }]
    const doorInfoMap = new Map([['300', { door_type: 'A', frame_type: 'F1' }]])
    const setMap = new Map([['DH5', hwSet]])
    const doorToSetMap = new Map([['300', hwSet]])

    const rows = buildPerOpeningItems(openings, doorInfoMap, setMap, doorToSetMap)

    // Single door: no pair splitting, items stored as-is with null leaf_side
    const hingeStd = rows.find(r => (r.name as string).includes('NRP'))
    expect(hingeStd?.qty).toBe(3)
    expect(hingeStd?.leaf_side).toBeNull()

    const hingeCon = rows.find(r => (r.name as string).includes('CON TW8'))
    expect(hingeCon?.qty).toBe(1)
    expect(hingeCon?.leaf_side).toBeNull()
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

  it('returns null for electric/conductor hinges on pair doors (deferred to buildPerOpeningItems)', () => {
    // computeLeafSide no longer handles electric hinges directly.
    // buildPerOpeningItems() is the authoritative source for electric hinge
    // leaf routing — it creates separate active/inactive rows with adjusted
    // quantities. Returning null here means "defer to caller context."
    expect(computeLeafSide('Hinges 5BB1 4.5x4.5 CON TW8', 2)).toBeNull()
    expect(computeLeafSide('Electric Hinge ETH', 2)).toBeNull()
    expect(computeLeafSide('Conductor Hinge', 2)).toBeNull()
    expect(computeLeafSide('Power Transfer Hinge', 2)).toBeNull()
  })

  it('returns null for electric hinges on single doors (no leaf split needed)', () => {
    // On single doors there's only one leaf, so no active/inactive distinction
    expect(computeLeafSide('Hinges 5BB1 4.5x4.5 CON TW8', 1)).toBeNull()
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

// ─── findItemFuzzy — enhanced fuzzy matching tiers ───

describe('findItemFuzzy enhanced matching', () => {
  function mkItem(name: string) {
    return { name, qty: 1, model: '', finish: '', manufacturer: '' }
  }

  it('matches when item has trailing dimension specs', () => {
    // Tier 3: normalized match strips trailing dimensions
    const items = [mkItem('CONTINUOUS HINGE, 83"')]
    expect(findItemFuzzy(items, 'Continuous Hinge', 't')?.name).toBe('CONTINUOUS HINGE, 83"')
  })

  it('matches when item has trailing model number', () => {
    // Tier 4: substring match — "Exit Device" is contained in the item name
    const items = [mkItem('Exit Device 99EO US26D')]
    expect(findItemFuzzy(items, 'Exit Device', 't')?.name).toBe('Exit Device 99EO US26D')
  })

  it('matches when item has trailing punctuation', () => {
    // Tier 3: normalized match strips trailing commas
    const items = [mkItem('Door Closer,')]
    expect(findItemFuzzy(items, 'Door Closer', 't')?.name).toBe('Door Closer,')
  })

  it('does NOT match across different hardware categories', () => {
    // Category guard: "Hinge" and "Door Closer" have different category keywords
    const items = [mkItem('Door Closer')]
    expect(findItemFuzzy(items, 'Hinge', 't')).toBeUndefined()
  })

  it('skips correction when two items score equally (ambiguous)', () => {
    // Two items that normalize identically — ambiguous match should return undefined
    const items = [mkItem('Door Closer, 4000'), mkItem('Door Closer, 5000')]
    expect(findItemFuzzy(items, 'Door Closer', 't')).toBeUndefined()
  })

  it('does not substring-match short names (< 8 chars)', () => {
    // "Pin" is only 3 chars — below the 8-char minimum for substring matching
    const items = [mkItem('Hinge Pin Stop'), mkItem('Pivot Pin Assembly')]
    expect(findItemFuzzy(items, 'Pin', 't')).toBeUndefined()
  })

  it('prefers exact match even when fuzzy matches exist', () => {
    // Exact match should win over normalized or substring matches
    const items = [mkItem('Hinge'), mkItem('Hinge, 4-1/2" x 4-1/2"')]
    expect(findItemFuzzy(items, 'Hinge', 't')?.name).toBe('Hinge')
  })
})

// ─── normalizeName — unit tests for the normalizer ───

describe('normalizeName', () => {
  it('strips trailing dimension pattern', () => {
    expect(normalizeName('CONTINUOUS HINGE, 83"')).toBe('continuous hinge')
  })

  it('strips trailing model numbers', () => {
    expect(normalizeName('Exit Device 99EO US26D')).toBe('exit device')
  })

  it('strips parenthesized finish codes', () => {
    expect(normalizeName('Lockset (US26D)')).toBe('lockset')
  })

  it('strips trailing commas and periods', () => {
    expect(normalizeName('Door Closer,')).toBe('door closer')
  })

  it('collapses whitespace', () => {
    expect(normalizeName('Door   Closer')).toBe('door closer')
  })

  it('handles combined trailing specs', () => {
    expect(normalizeName('Continuous Hinge 224XY')).toBe('continuous hinge')
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

// ─── createAnthropicClient — retry + timeout config ───

describe('createAnthropicClient', () => {
  it('configures maxRetries=4 and timeout=290000', () => {
    // We can\'t send a live request in tests, but the SDK exposes the
    // resolved config on the client so we can confirm our tuning stuck.
    const client = createAnthropicClient()
    expect(client.maxRetries).toBe(4)
    expect(client.timeout).toBe(290_000)
  })
})

// ─── selectRepresentativeSample — smart door sampling ───

describe('selectRepresentativeSample', () => {
  it('covers all hardware sets', () => {
    // 5 sets, 100 doors — 20 per set
    const sets: HardwareSet[] = Array.from({ length: 5 }, (_, i) =>
      makeSet(`S${i + 1}`, [{ name: 'Hinge', qty: 3 }, { name: 'Closer', qty: 1 }]),
    )
    const doors: DoorEntry[] = []
    for (let s = 0; s < 5; s++) {
      for (let d = 0; d < 20; d++) {
        doors.push(makeDoor(`${s + 1}${String.fromCharCode(65 + d)}`, `S${s + 1}`))
      }
    }
    const sample = selectRepresentativeSample(doors, sets)
    // Every set should have at least one representative
    const setsInSample = new Set(sample.map(d => d.hw_set))
    expect(setsInSample.size).toBe(5)
    for (let i = 1; i <= 5; i++) {
      expect(setsInSample.has(`S${i}`)).toBe(true)
    }
  })

  it('prioritises pair doors in remaining slots', () => {
    const sets: HardwareSet[] = [
      makeSet('A', [{ name: 'Hinge', qty: 3 }]),
      makeSet('B', [{ name: 'Hinge', qty: 3 }]),
    ]
    // 30 doors: 15 in set A, 15 in set B
    const doors: DoorEntry[] = []
    for (let i = 0; i < 15; i++) {
      doors.push(makeDoor(`A${i}`, 'A'))
    }
    for (let i = 0; i < 15; i++) {
      const d = makeDoor(`B${i}`, 'B')
      // Mark last 5 of set B as pair doors
      if (i >= 10) d.leaf_count = 2
      doors.push(d)
    }
    const sample = selectRepresentativeSample(doors, sets)
    // All pair doors (5) should be in the sample
    const pairDoorsInSample = sample.filter(d => (d.leaf_count ?? 1) > 1)
    expect(pairDoorsInSample.length).toBe(5)
  })

  it('returns all doors when project is small', () => {
    const sets: HardwareSet[] = [makeSet('X', [{ name: 'Lock', qty: 1 }])]
    const doors: DoorEntry[] = Array.from({ length: 8 }, (_, i) =>
      makeDoor(`D${i + 1}`, 'X'),
    )
    const sample = selectRepresentativeSample(doors, sets)
    expect(sample.length).toBe(8)
    // Should be the same doors (order preserved)
    expect(sample.map(d => d.door_number)).toEqual(doors.map(d => d.door_number))
  })

  it('respects maxSample limit', () => {
    const sets: HardwareSet[] = Array.from({ length: 20 }, (_, i) =>
      makeSet(`S${i}`, [{ name: 'Hinge', qty: 3 }]),
    )
    const doors: DoorEntry[] = []
    for (let s = 0; s < 20; s++) {
      for (let d = 0; d < 5; d++) {
        doors.push(makeDoor(`${s}-${d}`, `S${s}`))
      }
    }
    // Default max is 15
    const sample15 = selectRepresentativeSample(doors, sets)
    expect(sample15.length).toBe(15)

    // Explicit max of 10
    const sample10 = selectRepresentativeSample(doors, sets, 10)
    expect(sample10.length).toBe(10)
  })

  it('picks diverse doors when all share one set', () => {
    const sets: HardwareSet[] = [
      makeSet('ONLY', [
        { name: 'Hinge', qty: 3 },
        { name: 'Closer', qty: 1 },
        { name: 'Lock', qty: 1 },
      ]),
    ]
    const doors: DoorEntry[] = []
    for (let i = 0; i < 30; i++) {
      const d = makeDoor(`D${i + 1}`, 'ONLY')
      // Vary door characteristics: some pair, some different types
      if (i >= 25) d.leaf_count = 2
      if (i < 10) d.door_type = 'Wood'
      else if (i < 20) d.door_type = 'HM'
      else d.door_type = 'AL'
      doors.push(d)
    }
    const sample = selectRepresentativeSample(doors, sets)
    expect(sample.length).toBe(15)
    // Should include pair doors (indices 25-29)
    const pairDoorsInSample = sample.filter(d => (d.leaf_count ?? 1) > 1)
    expect(pairDoorsInSample.length).toBeGreaterThan(0)
    // Should not just be the first 15 — pair doors are at index 25+
    const hasLaterDoors = sample.some(d => {
      const num = parseInt(d.door_number.replace('D', ''), 10)
      return num > 15
    })
    expect(hasLaterDoors).toBe(true)
  })
})

// ── calculateExtractionConfidence ────────────────────────────────

describe('calculateExtractionConfidence', () => {
  /** Helper to build a hardware item with all fields populated. */
  function makeItem(
    name: string,
    opts: {
      qty?: number
      qty_source?: string
      manufacturer?: string
      model?: string
      finish?: string
    } = {},
  ) {
    return {
      name,
      qty: opts.qty ?? 1,
      qty_source: opts.qty_source,
      manufacturer: opts.manufacturer ?? 'Hager',
      model: opts.model ?? '5BB1',
      finish: opts.finish ?? '626',
    }
  }

  function makeFullSet(set_id: string, items: ReturnType<typeof makeItem>[], opts: Partial<HardwareSet> = {}): HardwareSet {
    return {
      set_id,
      heading: `Set ${set_id}`,
      items,
      ...opts,
    }
  }

  const emptyCorrections: PunchyCorrections = {
    hardware_sets_corrections: [],
    doors_corrections: [],
    missing_doors: [],
    missing_sets: [],
    notes: '',
  }

  it('test_confidence_all_fields_populated — item with all fields → high confidence', () => {
    const sets: HardwareSet[] = [
      makeFullSet('DH1', [
        makeItem('Butt Hinge', { manufacturer: 'Hager', model: '5BB1', finish: '626' }),
        makeItem('Closer', { manufacturer: 'LCN', model: '4040XP', finish: '689' }),
        makeItem('Lockset', { manufacturer: 'Schlage', model: 'L9010', finish: '626' }),
      ], { qty_convention: 'per_opening' }),
    ]
    const doors = [makeDoor('101', 'DH1'), makeDoor('102', 'DH1')]

    const result = calculateExtractionConfidence(sets, doors, emptyCorrections)

    expect(result.overall).toBe('high')
    expect(result.score).toBeGreaterThanOrEqual(80)

    // Each item should have high confidence on all fields
    const hingeConf = result.item_confidence['DH1:Butt Hinge']
    expect(hingeConf).toBeDefined()
    expect(hingeConf.overall).toBe('high')
    expect(hingeConf.name.level).toBe('high')
    expect(hingeConf.manufacturer.level).toBe('high')
    expect(hingeConf.model.level).toBe('high')
    expect(hingeConf.finish.level).toBe('high')
    expect(hingeConf.qty.level).toBe('high')
  })

  it('test_confidence_empty_fields — item with empty mfr/model → low on those fields', () => {
    const sets: HardwareSet[] = [
      makeFullSet('DH1', [
        makeItem('Butt Hinge', { manufacturer: '', model: '', finish: '' }),
      ]),
    ]
    const doors = [makeDoor('101', 'DH1')]

    const result = calculateExtractionConfidence(sets, doors, emptyCorrections)

    const conf = result.item_confidence['DH1:Butt Hinge']
    expect(conf).toBeDefined()
    expect(conf.manufacturer.level).toBe('low')
    expect(conf.model.level).toBe('low')
    expect(conf.finish.level).toBe('low')
    expect(conf.overall).toBe('low')

    // Name and qty should still be high (populated)
    expect(conf.name.level).toBe('high')
    expect(conf.qty.level).toBe('high')
  })

  it('test_confidence_punchy_corrected — item that Punchy corrected → medium', () => {
    const sets: HardwareSet[] = [
      makeFullSet('DH1', [
        makeItem('Butt Hinge', { manufacturer: 'Hager', model: '5BB1', finish: '626' }),
      ]),
    ]
    const doors = [makeDoor('101', 'DH1')]

    const corrections: PunchyCorrections = {
      hardware_sets_corrections: [{
        set_id: 'DH1',
        items_to_fix: [{
          name: 'Butt Hinge',
          field: 'manufacturer',
          old_value: 'Ives',
          new_value: 'Hager',
        }],
      }],
      notes: 'Fixed manufacturer',
    }

    const result = calculateExtractionConfidence(sets, doors, corrections)

    const conf = result.item_confidence['DH1:Butt Hinge']
    expect(conf).toBeDefined()
    expect(conf.manufacturer.level).toBe('medium')
    expect(conf.manufacturer.reason).toContain('Punchy corrected')
    // Other fields should be high
    expect(conf.name.level).toBe('high')
    expect(conf.model.level).toBe('high')

    // Signals should mention corrections
    expect(result.signals.some(s => s.includes('correction'))).toBe(true)
  })

  it('test_confidence_llm_override_qty — qty_source = llm_override → medium qty confidence', () => {
    const sets: HardwareSet[] = [
      makeFullSet('DH1', [
        makeItem('Closer', { qty: 1, qty_source: 'llm_override', manufacturer: 'LCN', model: '4040XP', finish: '689' }),
      ]),
    ]
    const doors = [makeDoor('101', 'DH1')]

    const result = calculateExtractionConfidence(sets, doors, emptyCorrections)

    const conf = result.item_confidence['DH1:Closer']
    expect(conf).toBeDefined()
    expect(conf.qty.level).toBe('medium')
    expect(conf.qty.reason).toContain('Punchy corrected')
  })

  it('test_confidence_overall_score — verify the 0-100 score calculation', () => {
    // Perfect extraction: all fields populated, preamble convention, no corrections
    const perfectSets: HardwareSet[] = [
      makeFullSet('DH1', [
        makeItem('Butt Hinge'),
        makeItem('Closer', { manufacturer: 'LCN', model: '4040XP', finish: '689' }),
        makeItem('Lockset', { manufacturer: 'Schlage', model: 'L9010', finish: '626' }),
      ], { qty_convention: 'per_opening' }),
    ]
    const perfectDoors = [makeDoor('101', 'DH1'), makeDoor('102', 'DH1')]

    const perfect = calculateExtractionConfidence(perfectSets, perfectDoors, emptyCorrections)
    expect(perfect.score).toBeGreaterThanOrEqual(90)

    // Poor extraction: empty fields, statistical convention
    const poorSets: HardwareSet[] = [
      makeFullSet('DH1', [
        makeItem('Butt Hinge', { manufacturer: '', model: '', finish: '' }),
        makeItem('Closer', { manufacturer: '', model: '', finish: '' }),
      ], { qty_convention: 'unknown' }),
    ]
    const poorDoors = [makeDoor('101', 'DH1')]

    const poor = calculateExtractionConfidence(poorSets, poorDoors, emptyCorrections)
    expect(poor.score).toBeLessThan(perfect.score)
    expect(poor.score).toBeLessThan(80)

    // Score is bounded 0-100
    expect(perfect.score).toBeLessThanOrEqual(100)
    expect(perfect.score).toBeGreaterThanOrEqual(0)
    expect(poor.score).toBeLessThanOrEqual(100)
    expect(poor.score).toBeGreaterThanOrEqual(0)
  })

  it('test_confidence_auto_fallback_threshold — >30% empty mfr triggers suggestion', () => {
    // 4 items, 2 with empty manufacturer+model = 50% > 30%
    const sets: HardwareSet[] = [
      makeFullSet('DH1', [
        makeItem('Butt Hinge', { manufacturer: '', model: '' }),
        makeItem('Closer', { manufacturer: '', model: '' }),
        makeItem('Lockset', { manufacturer: 'Schlage', model: 'L9010', finish: '626' }),
        makeItem('Exit Device', { manufacturer: 'VonDuprin', model: '99', finish: '626' }),
      ]),
    ]
    const doors = [makeDoor('101', 'DH1')]

    const result = calculateExtractionConfidence(sets, doors, emptyCorrections)

    expect(result.suggest_deep_extraction).toBe(true)
    expect(result.deep_extraction_reasons.length).toBeGreaterThan(0)
    expect(result.deep_extraction_reasons[0]).toContain('empty manufacturer + model')
    expect(result.overall).toBe('low')
  })

  it('does not suggest deep extraction when fields are well-populated', () => {
    const sets: HardwareSet[] = [
      makeFullSet('DH1', [
        makeItem('Butt Hinge'),
        makeItem('Closer', { manufacturer: 'LCN', model: '4040XP', finish: '689' }),
      ]),
    ]
    const doors = [makeDoor('101', 'DH1')]

    const result = calculateExtractionConfidence(sets, doors, emptyCorrections)

    expect(result.suggest_deep_extraction).toBe(false)
    expect(result.deep_extraction_reasons).toHaveLength(0)
  })

  it('handles empty hardware sets gracefully', () => {
    const sets: HardwareSet[] = [
      makeFullSet('DH1', []),
    ]
    const doors = [makeDoor('101', 'DH1')]

    const result = calculateExtractionConfidence(sets, doors, emptyCorrections)

    expect(result.signals.some(s => s.includes('zero hardware items'))).toBe(true)
    expect(result.score).toBeLessThan(100)
  })

  it('detects doors assigned to undefined sets', () => {
    const sets: HardwareSet[] = [
      makeFullSet('DH1', [makeItem('Hinge')]),
    ]
    // Door assigned to DH2 which doesn't exist
    const doors = [makeDoor('101', 'DH2')]

    const result = calculateExtractionConfidence(sets, doors, emptyCorrections)

    expect(result.signals.some(s => s.includes('undefined hardware sets'))).toBe(true)
  })

  it('signals when all qty conventions are preamble-detected', () => {
    const sets: HardwareSet[] = [
      makeFullSet('DH1', [makeItem('Hinge')], { qty_convention: 'per_opening' }),
      makeFullSet('DH2', [makeItem('Closer')], { qty_convention: 'aggregate' }),
    ]
    const doors = [makeDoor('101', 'DH1'), makeDoor('102', 'DH2')]

    const result = calculateExtractionConfidence(sets, doors, emptyCorrections)

    expect(result.signals.some(s => s.includes('preamble'))).toBe(true)
  })

  it('signals statistical qty convention fallback', () => {
    const sets: HardwareSet[] = [
      makeFullSet('DH1', [makeItem('Hinge')], { qty_convention: 'unknown' }),
    ]
    const doors = [makeDoor('101', 'DH1')]

    const result = calculateExtractionConfidence(sets, doors, emptyCorrections)

    expect(result.signals.some(s => s.includes('statistical'))).toBe(true)
  })

  it('populates item.confidence on each hardware item', () => {
    const sets: HardwareSet[] = [
      makeFullSet('DH1', [
        makeItem('Butt Hinge'),
        makeItem('Closer', { manufacturer: 'LCN', model: '4040XP', finish: '689' }),
      ]),
    ]
    const doors = [makeDoor('101', 'DH1')]

    calculateExtractionConfidence(sets, doors, emptyCorrections)

    // The function mutates items to add confidence
    for (const item of sets[0].items) {
      expect(item.confidence).toBeDefined()
      expect(item.confidence!.overall).toBeDefined()
      expect(item.confidence!.name.level).toBeDefined()
      expect(item.confidence!.qty.level).toBeDefined()
    }
  })

  it('qty_source flagged → low qty confidence', () => {
    const sets: HardwareSet[] = [
      makeFullSet('DH1', [
        makeItem('Hinge', { qty: 3, qty_source: 'flagged' }),
      ]),
    ]
    const doors = [makeDoor('101', 'DH1')]

    const result = calculateExtractionConfidence(sets, doors, emptyCorrections)

    const conf = result.item_confidence['DH1:Hinge']
    expect(conf.qty.level).toBe('low')
    expect(conf.qty.reason).toContain('non-integer')
  })

  it('fuzzy-matched Punchy corrections → medium on corrected fields', () => {
    const sets: HardwareSet[] = [
      makeFullSet('DH1', [
        makeItem('Butt Hinge'),
      ]),
    ]
    const doors = [makeDoor('101', 'DH1')]

    const corrections: PunchyCorrections = {
      hardware_sets_corrections: [{
        set_id: 'DH1',
        items_to_fix: [{
          name: 'Butt Hinge',
          field: 'model',
          old_value: '5B1',
          new_value: '5BB1',
          confidence: 'low', // low confidence = fuzzy match
        }],
      }],
    }

    const result = calculateExtractionConfidence(sets, doors, corrections)

    const conf = result.item_confidence['DH1:Butt Hinge']
    expect(conf.model.level).toBe('medium')
    expect(conf.model.reason).toContain('fuzzy')
  })
})

// ── Full pipeline verification: normalizeQuantities → groupItemsByLeaf ──
// Ensures no double subtraction of electric hinge qty from standard hinges.

describe('full pipeline: normalizeQuantities → groupItemsByLeaf (no double subtraction)', () => {
  it('6 pair doors, 48 standard + 6 electric → active=3 standard + 1 electric, inactive=4 standard', () => {
    // Aggregate quantities from PDF: 48 standard hinges, 6 electric hinges
    // across 6 pair doors (12 leaves).
    const sets = [makeSet('DH_PIPELINE', [
      { name: 'Hinges 5BB1 4.5x4.5 NRP', qty: 48 },
      { name: 'Hinges 5BB1 4.5x4.5 CON TW8', qty: 6 },
    ], { heading_door_count: 6, heading_leaf_count: 12 })]
    const doors = Array.from({ length: 6 }, (_, i) => makeDoor(`PL-${i + 1}`, 'DH_PIPELINE'))

    // Stage 1: normalizeQuantities divides to per-leaf/per-opening
    normalizeQuantities(sets, doors)

    // Standard: 48 / 12 leaves = 4 per leaf (raw, no consolidation)
    expect(sets[0].items[0].qty).toBe(4)
    // Electric: 6 / 6 doors = 1 per opening (divisor overridden to doorCount)
    expect(sets[0].items[1].qty).toBe(1)

    // Stage 2: groupItemsByLeaf splits into active/inactive for wizard preview
    const items = sets[0].items.map(item => ({
      name: item.name,
      qty: item.qty,
    }))
    const { leaf1, leaf2 } = groupItemsByLeaf(items, 2)

    // Active leaf (leaf1): 3 standard + 1 electric = 4 hinge positions
    expect(leaf1).toHaveLength(2)
    const activeStandard = leaf1.find(i => i.name.includes('NRP'))
    const activeElectric = leaf1.find(i => i.name.includes('CON TW8'))
    expect(activeStandard?.qty).toBe(3) // 4 raw − 1 electric = 3
    expect(activeElectric?.qty).toBe(1)

    // Inactive leaf (leaf2): 4 standard only = 4 hinge positions
    expect(leaf2).toHaveLength(1)
    expect(leaf2[0].name).toContain('NRP')
    expect(leaf2[0].qty).toBe(4) // raw per-leaf, no subtraction
  })

  it('single pair door, 7 standard + 1 electric → active=3, inactive=4 (asymmetric split)', () => {
    // 7 standard / 2 leaves = 3.5 → ceil = 4 (asymmetric split explained by electric)
    const sets = [makeSet('DH_ASYM_PIPE', [
      { name: 'Hinges 5BB1 4.5x4.5 NRP', qty: 7 },
      { name: 'Hinges 5BB1 4.5x4.5 CON TW8', qty: 1 },
    ], { heading_door_count: 1, heading_leaf_count: 2 })]
    const doors = [makeDoor('AP-1', 'DH_ASYM_PIPE')]

    normalizeQuantities(sets, doors)

    // Standard: 7/2 = 3.5 → ceil = 4 (asymmetric split), no consolidation
    expect(sets[0].items[0].qty).toBe(4)
    expect(sets[0].items[1].qty).toBe(1)

    const items = sets[0].items.map(item => ({
      name: item.name,
      qty: item.qty,
    }))
    const { leaf1, leaf2 } = groupItemsByLeaf(items, 2)

    // Active: 3 standard + 1 electric = 4 positions
    expect(leaf1).toHaveLength(2)
    expect(leaf1.find(i => i.name.includes('NRP'))?.qty).toBe(3)
    expect(leaf1.find(i => i.name.includes('CON TW8'))?.qty).toBe(1)

    // Inactive: 4 standard = 4 positions
    expect(leaf2).toHaveLength(1)
    expect(leaf2[0].qty).toBe(4)
  })
})
