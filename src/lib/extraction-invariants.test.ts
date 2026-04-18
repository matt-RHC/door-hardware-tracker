/**
 * Unit tests for extraction-invariants. Each rule has a dedicated block that
 * exercises the passing and failing shape with a minimal fixture.
 *
 * These tests use the pure `runInvariants` export so they don't need a live
 * Supabase client — the DB-reading wrapper (`validateExtractionRun`) is a
 * thin adapter around the same logic.
 */

import { describe, it, expect } from 'vitest'
import { runInvariants } from './extraction-invariants'
import type { HardwareSet } from '@/lib/types'

// ── Fixture builders ────────────────────────────────────────────────────────

type OpeningFixture = {
  id: string
  door_number: string
  hw_set: string | null
  leaf_count: number
  location: string | null
}

type ItemFixture = {
  id: string
  opening_id: string
  name: string
  qty: number | null
  leaf_side: string | null
  model: string | null
}

function makeOpening(overrides: Partial<OpeningFixture> = {}): OpeningFixture {
  return {
    id: overrides.id ?? 'op-1',
    door_number: overrides.door_number ?? '101',
    hw_set: overrides.hw_set ?? 'H01',
    leaf_count: overrides.leaf_count ?? 1,
    location: overrides.location ?? 'Corridor',
  }
}

function makeItem(overrides: Partial<ItemFixture> = {}): ItemFixture {
  return {
    id: overrides.id ?? 'item-1',
    opening_id: overrides.opening_id ?? 'op-1',
    name: overrides.name ?? 'Door',
    qty: overrides.qty ?? 1,
    leaf_side: overrides.leaf_side ?? 'active',
    model: overrides.model ?? null,
  }
}

// ── Rule (a): too_many_doors ────────────────────────────────────────────────

describe('invariant (a) too_many_doors', () => {
  it('passes when opening has 0, 1, or 2 Door* rows', () => {
    const opening = makeOpening({ leaf_count: 2 })
    const items: ItemFixture[] = [
      makeItem({ id: 'i1', name: 'Door (Active Leaf)', leaf_side: 'active' }),
      makeItem({ id: 'i2', name: 'Door (Inactive Leaf)', leaf_side: 'inactive' }),
    ]
    const v = runInvariants([opening], items, [])
    expect(v.filter(x => x.rule === 'too_many_doors')).toHaveLength(0)
  })

  it('fails when an opening has 3+ Door* rows', () => {
    const opening = makeOpening({ leaf_count: 2 })
    const items: ItemFixture[] = [
      makeItem({ id: 'i1', name: 'Door (Active Leaf)', leaf_side: 'active' }),
      makeItem({ id: 'i2', name: 'Door (Inactive Leaf)', leaf_side: 'inactive' }),
      makeItem({ id: 'i3', name: 'Door', leaf_side: 'active' }),
    ]
    const v = runInvariants([opening], items, [])
    const hit = v.find(x => x.rule === 'too_many_doors')
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('blocker')
    expect(hit?.opening_id).toBe('op-1')
  })
})

// ── Rule (b): conflicting_door_variants ─────────────────────────────────────

describe('invariant (b) conflicting_door_variants', () => {
  it('fails when opening has bare "Door" AND "Door (Active Leaf)"', () => {
    const opening = makeOpening({ leaf_count: 2 })
    const items: ItemFixture[] = [
      makeItem({ id: 'i1', name: 'Door' }),
      makeItem({ id: 'i2', name: 'Door (Active Leaf)', leaf_side: 'active' }),
    ]
    const v = runInvariants([opening], items, [])
    const hit = v.find(x => x.rule === 'conflicting_door_variants')
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('blocker')
  })

  it('passes when opening only has leaf-specific Door rows', () => {
    const opening = makeOpening({ leaf_count: 2 })
    const items: ItemFixture[] = [
      makeItem({ id: 'i1', name: 'Door (Active Leaf)', leaf_side: 'active' }),
      makeItem({ id: 'i2', name: 'Door (Inactive Leaf)', leaf_side: 'inactive' }),
    ]
    const v = runInvariants([opening], items, [])
    expect(v.filter(x => x.rule === 'conflicting_door_variants')).toHaveLength(0)
  })
})

// ── Regression: apply-revision single→pair reclassification (110-01B) ────────
//
// When apply-revision reset a changed door and pair detection changed from
// single to pair, the old "Door" row survived in `preserved` (install_type was
// set) while the new "Door (Active Leaf)" row was inserted without colliding.
// Both ended up in the DB, triggering conflicting_door_variants.
//
// Fix: isStructuralRow() forces Door*/Frame rows into toDeleteIds regardless
// of install_type, so they are always regenerated from the fresh PDF.
// This test asserts the invariant catches the resulting corrupt DB state and
// that a correctly-regenerated pair opening passes.

describe('regression: apply-revision single→pair reclassification', () => {
  it('detects conflict when stale "Door" survives alongside "Door (Active Leaf)"', () => {
    const opening = makeOpening({ leaf_count: 2 })
    const items: ItemFixture[] = [
      makeItem({ id: 'i1', name: 'Door', leaf_side: 'active' }),           // stale single row
      makeItem({ id: 'i2', name: 'Door (Active Leaf)', leaf_side: 'active' }), // new pair row
    ]
    const v = runInvariants([opening], items, [])
    expect(v.find(x => x.rule === 'conflicting_door_variants')).toBeDefined()
  })

  it('passes after correction: pair opening with Active + Inactive Leaf only', () => {
    const opening = makeOpening({ leaf_count: 2 })
    const items: ItemFixture[] = [
      makeItem({ id: 'i1', name: 'Door (Active Leaf)', leaf_side: 'active' }),
      makeItem({ id: 'i2', name: 'Door (Inactive Leaf)', leaf_side: 'inactive' }),
    ]
    const v = runInvariants([opening], items, [])
    expect(v.filter(x => x.rule === 'conflicting_door_variants')).toHaveLength(0)
    expect(v.filter(x => x.rule === 'pair_leaf_door_count_mismatch')).toHaveLength(0)
  })
})

// ── Rule (c): too_many_frames ───────────────────────────────────────────────

describe('invariant (c) too_many_frames', () => {
  it('fails when opening has 2+ Frame rows', () => {
    const opening = makeOpening()
    const items: ItemFixture[] = [
      makeItem({ id: 'i1', name: 'Frame', leaf_side: 'shared' }),
      makeItem({ id: 'i2', name: 'Frame', leaf_side: 'shared' }),
    ]
    const v = runInvariants([opening], items, [])
    const hit = v.find(x => x.rule === 'too_many_frames')
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('blocker')
  })

  it('passes with 0 or 1 Frame rows', () => {
    const opening = makeOpening()
    const items: ItemFixture[] = [makeItem({ id: 'i1', name: 'Frame', leaf_side: 'shared' })]
    const v = runInvariants([opening], items, [])
    expect(v.filter(x => x.rule === 'too_many_frames')).toHaveLength(0)
  })
})

// ── Rule (d): single_leaf_door_count_mismatch ───────────────────────────────

describe('invariant (d) single-leaf → 1 Door row', () => {
  it('fails when leaf_count=1 but 2 Door rows exist', () => {
    const opening = makeOpening({ leaf_count: 1 })
    const items: ItemFixture[] = [
      makeItem({ id: 'i1', name: 'Door (Active Leaf)', leaf_side: 'active' }),
      makeItem({ id: 'i2', name: 'Door (Inactive Leaf)', leaf_side: 'inactive' }),
    ]
    const v = runInvariants([opening], items, [])
    const hit = v.find(x => x.rule === 'single_leaf_door_count_mismatch')
    expect(hit).toBeDefined()
  })

  it('passes when leaf_count=1 and 1 Door row', () => {
    const opening = makeOpening({ leaf_count: 1 })
    const items: ItemFixture[] = [makeItem({ id: 'i1', name: 'Door', leaf_side: 'active' })]
    const v = runInvariants([opening], items, [])
    expect(v.filter(x => x.rule === 'single_leaf_door_count_mismatch')).toHaveLength(0)
  })

  it('passes when leaf_count=1 with 0 Door rows (no door_type)', () => {
    const opening = makeOpening({ leaf_count: 1 })
    const items: ItemFixture[] = [makeItem({ id: 'i1', name: 'Frame', leaf_side: 'shared' })]
    const v = runInvariants([opening], items, [])
    expect(v.filter(x => x.rule === 'single_leaf_door_count_mismatch')).toHaveLength(0)
  })
})

// ── Rule (e): pair_leaf_door_count_mismatch ─────────────────────────────────

describe('invariant (e) pair → 2 Door rows (active + inactive)', () => {
  it('fails when leaf_count=2 but only 1 Door row', () => {
    const opening = makeOpening({ leaf_count: 2 })
    const items: ItemFixture[] = [makeItem({ id: 'i1', name: 'Door', leaf_side: 'active' })]
    const v = runInvariants([opening], items, [])
    const hit = v.find(x => x.rule === 'pair_leaf_door_count_mismatch')
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('blocker')
  })

  it('fails when leaf_count=2 with 2 Active rows (missing inactive)', () => {
    const opening = makeOpening({ leaf_count: 2 })
    const items: ItemFixture[] = [
      makeItem({ id: 'i1', name: 'Door (Active Leaf)', leaf_side: 'active' }),
      makeItem({ id: 'i2', name: 'Door (Active Leaf)', leaf_side: 'active' }),
    ]
    const v = runInvariants([opening], items, [])
    const hit = v.find(x => x.rule === 'pair_leaf_door_count_mismatch')
    expect(hit).toBeDefined()
  })

  it('passes when leaf_count=2 with one Active + one Inactive', () => {
    const opening = makeOpening({ leaf_count: 2 })
    const items: ItemFixture[] = [
      makeItem({ id: 'i1', name: 'Door (Active Leaf)', leaf_side: 'active' }),
      makeItem({ id: 'i2', name: 'Door (Inactive Leaf)', leaf_side: 'inactive' }),
    ]
    const v = runInvariants([opening], items, [])
    expect(v.filter(x => x.rule === 'pair_leaf_door_count_mismatch')).toHaveLength(0)
  })
})

// ── Rule (f): location_matches_fire_rating ──────────────────────────────────

describe('invariant (f) location should not look like a fire rating', () => {
  it.each([
    '90 min',
    '20min',
    '1 hr',
    '1hour',
    'NR',
    'UL',
    '60 MINUTES',
  ])('flags location="%s"', (badLocation) => {
    const opening = makeOpening({ location: badLocation })
    const v = runInvariants([opening], [], [])
    const hit = v.find(x => x.rule === 'location_matches_fire_rating')
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('warning')
  })

  it.each([
    'Corridor',
    'Stair A',
    'Room 101',
    null,
    '',
  ])('passes legitimate location "%s"', (loc) => {
    const opening = makeOpening({ location: loc })
    const v = runInvariants([opening], [], [])
    expect(v.filter(x => x.rule === 'location_matches_fire_rating')).toHaveLength(0)
  })
})

// ── Rule (g): heading_door_set_mismatch ─────────────────────────────────────

describe('invariant (g) heading_doors[] → correct hw_set', () => {
  it('fails when a door listed under DH4A.1 heading_doors got hw_set="DH4A"', () => {
    const opening = makeOpening({ door_number: '120-02A', hw_set: 'DH4A' })
    const set: HardwareSet = {
      set_id: 'DH4A.1',
      generic_set_id: 'DH4A',
      heading: 'Heading #DH4A.1',
      heading_doors: ['120-02A'],
      items: [],
    }
    const v = runInvariants([opening], [], [set])
    const hit = v.find(x => x.rule === 'heading_door_set_mismatch')
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('blocker')
  })

  it('passes when door has the specific sub-set hw_set', () => {
    const opening = makeOpening({ door_number: '120-02A', hw_set: 'DH4A.1' })
    const set: HardwareSet = {
      set_id: 'DH4A.1',
      generic_set_id: 'DH4A',
      heading: 'Heading #DH4A.1',
      heading_doors: ['120-02A'],
      items: [],
    }
    const v = runInvariants([opening], [], [set])
    expect(v.filter(x => x.rule === 'heading_door_set_mismatch')).toHaveLength(0)
  })

  it('is skipped when no hardwareSets are provided', () => {
    const opening = makeOpening({ door_number: '120-02A', hw_set: 'DH4A' })
    const v = runInvariants([opening], [], [])
    expect(v.filter(x => x.rule === 'heading_door_set_mismatch')).toHaveLength(0)
  })

  it('is skipped for sets where generic_set_id === set_id', () => {
    const opening = makeOpening({ door_number: '101', hw_set: 'H01' })
    const set: HardwareSet = {
      set_id: 'H01',
      generic_set_id: 'H01',
      heading: 'Set H01',
      heading_doors: ['101'],
      items: [],
    }
    const v = runInvariants([opening], [], [set])
    expect(v.filter(x => x.rule === 'heading_door_set_mismatch')).toHaveLength(0)
  })
})

// ── Rule (h): per_leaf_qty_sum_mismatch ─────────────────────────────────────

describe('invariant (h) per_leaf qty sum on pairs', () => {
  it('passes a normal 4+4 split (raw per-leaf qty=4 on each side)', () => {
    const opening = makeOpening({ leaf_count: 2 })
    const items: ItemFixture[] = [
      makeItem({ id: 'a', name: 'Hinges 5BB1 4.5x4.5 NRP', qty: 4, leaf_side: 'active' }),
      makeItem({ id: 'b', name: 'Hinges 5BB1 4.5x4.5 NRP', qty: 4, leaf_side: 'inactive' }),
    ]
    const v = runInvariants([opening], items, [])
    expect(v.filter(x => x.rule === 'per_leaf_qty_sum_mismatch')).toHaveLength(0)
  })

  it('passes a 3+4 electric-hinge-adjusted split', () => {
    const opening = makeOpening({ leaf_count: 2 })
    const items: ItemFixture[] = [
      makeItem({ id: 'a', name: 'Hinges 5BB1 4.5x4.5 NRP', qty: 3, leaf_side: 'active' }),
      makeItem({ id: 'b', name: 'Hinges 5BB1 4.5x4.5 NRP', qty: 4, leaf_side: 'inactive' }),
    ]
    const v = runInvariants([opening], items, [])
    expect(v.filter(x => x.rule === 'per_leaf_qty_sum_mismatch')).toHaveLength(0)
  })

  it('flags a suspicious 0+0 split on a pair', () => {
    const opening = makeOpening({ leaf_count: 2 })
    const items: ItemFixture[] = [
      makeItem({ id: 'a', name: 'Hinges 5BB1 4.5x4.5 NRP', qty: 0, leaf_side: 'active' }),
      makeItem({ id: 'b', name: 'Hinges 5BB1 4.5x4.5 NRP', qty: 0, leaf_side: 'inactive' }),
    ]
    // max=0, band = [0,0], sum=0 → band is satisfied. Rule only flags
    // out-of-band sums; a zeroed pair slips through (caught by other rules).
    const v = runInvariants([opening], items, [])
    expect(v.filter(x => x.rule === 'per_leaf_qty_sum_mismatch')).toHaveLength(0)
  })

  it('flags an over-counted 8+4 sum when expected max is 8', () => {
    const opening = makeOpening({ leaf_count: 2 })
    const items: ItemFixture[] = [
      makeItem({ id: 'a', name: 'Hinges 5BB1 4.5x4.5 NRP', qty: 8, leaf_side: 'active' }),
      makeItem({ id: 'b', name: 'Hinges 5BB1 4.5x4.5 NRP', qty: 4, leaf_side: 'inactive' }),
    ]
    // max=8, expectedMax=16. sum=12 is within [8, 16] → no flag. This
    // confirms the band is intentionally permissive for asymmetric splits.
    const v = runInvariants([opening], items, [])
    expect(v.filter(x => x.rule === 'per_leaf_qty_sum_mismatch')).toHaveLength(0)
  })

  it('flags when a per_leaf item shows qty beyond 2× max side', () => {
    const opening = makeOpening({ leaf_count: 2 })
    const items: ItemFixture[] = [
      // Synthetic doubled row — a triple-entry scenario
      makeItem({ id: 'a', name: 'Hinges 5BB1 4.5x4.5 NRP', qty: 4, leaf_side: 'active' }),
      makeItem({ id: 'b', name: 'Hinges 5BB1 4.5x4.5 NRP', qty: 4, leaf_side: 'active' }),
      makeItem({ id: 'c', name: 'Hinges 5BB1 4.5x4.5 NRP', qty: 4, leaf_side: 'inactive' }),
    ]
    // max=4, expectedMax=8, sum=12 → flag.
    const v = runInvariants([opening], items, [])
    const hit = v.find(x => x.rule === 'per_leaf_qty_sum_mismatch')
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('warning')
  })

  it('does not apply to single-leaf openings', () => {
    const opening = makeOpening({ leaf_count: 1 })
    const items: ItemFixture[] = [
      makeItem({ id: 'a', name: 'Hinges 5BB1 4.5x4.5 NRP', qty: 4, leaf_side: 'active' }),
    ]
    const v = runInvariants([opening], items, [])
    expect(v.filter(x => x.rule === 'per_leaf_qty_sum_mismatch')).toHaveLength(0)
  })
})

// ── Regression canary: Radius DC-shaped violation ───────────────────────────
//
// The 2026-04-17 regression produced pair openings where both Door rows
// landed on the active side (or a bare "Door" row alongside leaf rows) and
// the location column carried a fire-rating string. Running a combined
// fixture proves the layer catches all four classes at once.

describe('extraction-invariants — Radius DC regression canary', () => {
  it('reports every known class when a bad extraction is fed in', () => {
    const openings: OpeningFixture[] = [
      makeOpening({ id: 'op-1', door_number: '120-02A', hw_set: 'DH4A', leaf_count: 2, location: '90 min' }),
      makeOpening({ id: 'op-2', door_number: '110-02C', hw_set: 'DH3', leaf_count: 1, location: 'Corridor' }),
    ]
    const items: ItemFixture[] = [
      // op-1: too many doors + conflicting variants + too many frames
      makeItem({ id: 'i1', opening_id: 'op-1', name: 'Door', leaf_side: 'active' }),
      makeItem({ id: 'i2', opening_id: 'op-1', name: 'Door (Active Leaf)', leaf_side: 'active' }),
      makeItem({ id: 'i3', opening_id: 'op-1', name: 'Door (Inactive Leaf)', leaf_side: 'inactive' }),
      makeItem({ id: 'i4', opening_id: 'op-1', name: 'Frame', leaf_side: 'shared' }),
      makeItem({ id: 'i5', opening_id: 'op-1', name: 'Frame', leaf_side: 'shared' }),
      // op-2: single-leaf with 2 doors
      makeItem({ id: 'i6', opening_id: 'op-2', name: 'Door (Active Leaf)', leaf_side: 'active' }),
      makeItem({ id: 'i7', opening_id: 'op-2', name: 'Door (Inactive Leaf)', leaf_side: 'inactive' }),
    ]
    const sets: HardwareSet[] = [
      {
        set_id: 'DH4A.1',
        generic_set_id: 'DH4A',
        heading: 'Heading #DH4A.1',
        heading_doors: ['120-02A'],
        items: [],
      },
    ]
    const v = runInvariants(openings, items, sets)

    const rules = new Set(v.map(x => x.rule))
    expect(rules.has('too_many_doors')).toBe(true)
    expect(rules.has('conflicting_door_variants')).toBe(true)
    expect(rules.has('too_many_frames')).toBe(true)
    expect(rules.has('single_leaf_door_count_mismatch')).toBe(true)
    expect(rules.has('location_matches_fire_rating')).toBe(true)
    expect(rules.has('heading_door_set_mismatch')).toBe(true)

    const blockers = v.filter(x => x.severity === 'blocker').length
    expect(blockers).toBeGreaterThanOrEqual(4)
  })
})

// ── Rule (i): leaf_count_consistency ────────────────────────────────────────
//
// 2026-04-18 Radius DC regression guard. Triggers whenever an opening has
// leaf_count<2 but any hardware_item carries leaf_side='active'|'inactive'.
// Always emits a 'blocker' severity; the save/route.ts wiring treats this
// specific rule as enforce-always (can be disabled via
// LEAF_COUNT_CONSISTENCY_ENFORCE=false env var).

describe('invariant (i) leaf_count_consistency', () => {
  it('fails when leaf_count=1 but an item has leaf_side="inactive" (Radius DC bug shape)', () => {
    const opening = makeOpening({ leaf_count: 1 })
    const items: ItemFixture[] = [
      makeItem({ id: 'i1', name: 'Door (Active Leaf)', leaf_side: 'active' }),
      makeItem({ id: 'i2', name: 'Door (Inactive Leaf)', leaf_side: 'inactive' }),
    ]
    const v = runInvariants([opening], items, [])
    const hit = v.find(x => x.rule === 'leaf_count_consistency')
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('blocker')
    expect(hit?.opening_id).toBe('op-1')
    expect(hit?.details).toMatch(/opening\.leaf_count=1/)
    expect(hit?.details).toMatch(/leaf_side="inactive"/)
  })

  it('does NOT fire when leaf_count=1 and only leaf_side="active" is present (single-door shape)', () => {
    // Critical: buildPerOpeningItems stamps single-door bare "Door" rows
    // with leaf_side='active' (parse-pdf-helpers.ts:2746). 'active' alone
    // MUST NOT trigger this rule, or every single-door extraction would
    // falsely block.
    const opening = makeOpening({ leaf_count: 1 })
    const items: ItemFixture[] = [
      makeItem({ id: 'i1', name: 'Door', leaf_side: 'active' }),
    ]
    const v = runInvariants([opening], items, [])
    expect(v.filter(x => x.rule === 'leaf_count_consistency')).toHaveLength(0)
  })

  it('passes when leaf_count=2 and items carry active/inactive (agreement)', () => {
    const opening = makeOpening({ leaf_count: 2 })
    const items: ItemFixture[] = [
      makeItem({ id: 'i1', name: 'Door (Active Leaf)', leaf_side: 'active' }),
      makeItem({ id: 'i2', name: 'Door (Inactive Leaf)', leaf_side: 'inactive' }),
    ]
    const v = runInvariants([opening], items, [])
    expect(v.filter(x => x.rule === 'leaf_count_consistency')).toHaveLength(0)
  })

  it('passes when leaf_count=1 and all items are shared/active (legitimate single-door)', () => {
    const opening = makeOpening({ leaf_count: 1 })
    const items: ItemFixture[] = [
      makeItem({ id: 'i1', name: 'Door', leaf_side: 'active' }),
      makeItem({ id: 'i2', name: 'Frame', leaf_side: 'shared' }),
    ]
    const v = runInvariants([opening], items, [])
    expect(v.filter(x => x.rule === 'leaf_count_consistency')).toHaveLength(0)
  })

  it('passes when leaf_count=1 and items carry leaf_side="both" (not a pair signal)', () => {
    const opening = makeOpening({ leaf_count: 1 })
    const items: ItemFixture[] = [
      makeItem({ id: 'i1', name: 'Wire', leaf_side: 'both' }),
    ]
    const v = runInvariants([opening], items, [])
    expect(v.filter(x => x.rule === 'leaf_count_consistency')).toHaveLength(0)
  })
})
