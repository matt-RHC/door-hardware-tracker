/**
 * Regression guard for the P2 leaf-tabs bug (PR #302).
 *
 * Root cause: apply-revision/route.ts omitted leaf_count from its UPDATE and
 * INSERT paths, so every opening it touched reverted to the DB default of 1.
 * The door detail renderer only shows the ALL/SHARED/LEAF 1/LEAF 2 tabs when
 * opening.leaf_count >= 2, so pair openings fell back to the flat list.
 *
 * The inline expression `door.leaf_count ?? (detectIsPair(...) ? 2 : 1)` was
 * extracted to resolveLeafCount() so it can be tested here without mocking
 * Supabase. If someone removes leaf_count from either write path again, these
 * tests will not catch it directly — but the function itself serves as the
 * single authoritative definition and a clear target for future route tests.
 *
 * Screen recording that captured the regression: 2026-04-17 17:26 UTC,
 * door 110-01B in Radius DC (after apply-revision rescan).
 */

import { describe, it, expect } from 'vitest'
import { resolveLeafCount } from '@/lib/resolve-leaf-count'
import type { HardwareSet } from '@/lib/types'

const makePairSet = (overrides: Partial<HardwareSet> = {}): HardwareSet => ({
  set_id: 'DH4A.0',
  heading: 'Heading #DH4A.0',
  heading_door_count: 6,
  heading_leaf_count: 12,
  heading_doors: ['D1'],
  items: [],
  ...overrides,
})

const makeSingleSet = (overrides: Partial<HardwareSet> = {}): HardwareSet => ({
  set_id: 'AD11-IS',
  heading: 'Heading #AD11-IS',
  heading_door_count: 1,
  heading_leaf_count: 1,
  heading_doors: ['1400'],
  items: [],
  ...overrides,
})

const makeDoor = (
  overrides: Partial<{ leaf_count: number | undefined; door_type: string; frame_type: string }> = {},
) => ({
  leaf_count: undefined as number | undefined,
  door_type: 'A',
  frame_type: 'F1',
  ...overrides,
})

describe('resolveLeafCount', () => {
  it('returns 2 for pair set detected via heading_leaf_count > heading_door_count (primary signal)', () => {
    const result = resolveLeafCount(makeDoor(), makePairSet())
    expect(result, 'pair opening must produce leaf_count=2').toBe(2)
  })

  it('returns 1 for single-leaf set (heading_leaf_count === heading_door_count)', () => {
    const result = resolveLeafCount(makeDoor(), makeSingleSet())
    expect(result, 'single-leaf opening must produce leaf_count=1').toBe(1)
  })

  it('returns 2 when door.leaf_count is already 2, even if heading signals are absent (pre-computed wins)', () => {
    // Caller-set leaf_count must win over detectIsPair — this is the P1 contract.
    // heading_leaf_count=0 would cause detectIsPair to return false, but the
    // pre-computed value takes priority via the ?? short-circuit.
    const result = resolveLeafCount(
      makeDoor({ leaf_count: 2 }),
      makeSingleSet({ heading_leaf_count: 0, heading_door_count: 1 }),
    )
    expect(result, 'pre-computed leaf_count=2 must not be overridden by detectIsPair').toBe(2)
  })

  it('returns 1 when door.leaf_count is already 1, even if heading signals suggest pair (pre-computed wins)', () => {
    const result = resolveLeafCount(makeDoor({ leaf_count: 1 }), makePairSet())
    expect(result, 'pre-computed leaf_count=1 must not be overridden by detectIsPair').toBe(1)
  })

  it('returns 1 when hwSet is undefined (safe fallback — no detectIsPair signals available)', () => {
    const result = resolveLeafCount(makeDoor(), undefined)
    expect(result, 'missing hwSet must fall back to leaf_count=1').toBe(1)
  })

  it('returns 2 when heading contains "pair" keyword (tertiary detection signal)', () => {
    const result = resolveLeafCount(
      makeDoor(),
      makeSingleSet({ heading: 'Heading #DH4A.0 — pair doors', heading_leaf_count: 0 }),
    )
    expect(result, 'keyword "pair" in heading must produce leaf_count=2').toBe(2)
  })
})
