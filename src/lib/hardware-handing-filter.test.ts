/**
 * Unit tests for hardware-handing-filter.
 *
 * Covers the two exported helpers:
 *   1. inferHandingDirection — token parser for RHR/LHR/RHRA/LHRA/RH/LH
 *      in a model or name string.
 *   2. filterAllItemsByOpeningHand — the post-buildPerOpeningItems pass
 *      that drops items whose direction contradicts the opening's hand.
 */

import { describe, it, expect } from 'vitest'
import {
  inferHandingDirection,
  filterAllItemsByOpeningHand,
  type OpeningHandRecord,
} from './hardware-handing-filter'

// ── inferHandingDirection ──────────────────────────────────────────────────

describe('inferHandingDirection', () => {
  it('recognizes RHR', () => {
    expect(inferHandingDirection('98L-NL-F × 996L-NL-R&V 06 RHR')).toBe('RH')
  })

  it('recognizes LHR', () => {
    expect(inferHandingDirection('98L-NL-F × 996L-NL-R&V 06 LHR')).toBe('LH')
  })

  it('recognizes RHRA (reverse-variant) as RH direction', () => {
    expect(inferHandingDirection("RHRA 6'0\"")).toBe('RH')
  })

  it('recognizes LHRA as LH direction', () => {
    expect(inferHandingDirection('Exit device LHRA variant')).toBe('LH')
  })

  it('recognizes bare RH / LH', () => {
    expect(inferHandingDirection('Exit 98 RH')).toBe('RH')
    expect(inferHandingDirection('Exit 98 LH')).toBe('LH')
  })

  it('is case-insensitive', () => {
    expect(inferHandingDirection('rhr')).toBe('RH')
    expect(inferHandingDirection('lhr')).toBe('LH')
    expect(inferHandingDirection('Rh')).toBe('RH')
  })

  it('returns null when no handing token is present', () => {
    expect(inferHandingDirection('5BB1 HW 4 1/2 × 4 1/2 NRP')).toBeNull()
    expect(inferHandingDirection('LCN 4040XP')).toBeNull()
    expect(inferHandingDirection('')).toBeNull()
  })

  it('returns null for null/undefined input', () => {
    expect(inferHandingDirection(null)).toBeNull()
    expect(inferHandingDirection(undefined)).toBeNull()
  })

  it('does not match inside longer runs of letters', () => {
    // RHW is a wire gauge marking, NOT right-hand.
    expect(inferHandingDirection('RHW cable')).toBeNull()
    // LHD is not a handing token.
    expect(inferHandingDirection('LHD material')).toBeNull()
  })

  it('first token wins for compound strings (documented limitation)', () => {
    expect(inferHandingDirection('RHR/LHR universal')).toBe('RH')
    expect(inferHandingDirection('LHR or RHR')).toBe('LH')
  })

  it('matches RHRA before RHR (longest first)', () => {
    // The ordering in HANDING_TOKEN_PATTERNS puts RHRA before RHR so a
    // value containing only RHRA resolves as RH via the RHRA branch,
    // not via a fallback RHR match that happens to be a substring.
    expect(inferHandingDirection('RHRA panic')).toBe('RH')
  })
})

// ── filterAllItemsByOpeningHand ────────────────────────────────────────────

function makeOpening(overrides: Partial<OpeningHandRecord> = {}): OpeningHandRecord {
  // Use spread rather than ?? so explicit null on `hand` and `leafCount`
  // overrides the default (?? on `null` would fall through to the default).
  return {
    id: 'op-1',
    doorNumber: '110-02C',
    hand: 'RHR',
    leafCount: 1,
    ...overrides,
  }
}

function makeItem(
  overrides: { name?: string; model?: string | null; staging_opening_id?: string; opening_id?: string } = {},
): Record<string, unknown> {
  return {
    staging_opening_id: overrides.staging_opening_id ?? 'op-1',
    opening_id: overrides.opening_id,
    name: overrides.name ?? 'Exit Device',
    model: overrides.model ?? null,
    qty: 1,
  }
}

describe('filterAllItemsByOpeningHand — single-leaf handing filter', () => {
  it('reproducer A — drops LHR variant on RHR single-leaf opening, keeps RHR', () => {
    // Mirrors 110-02C / DH3 / p.22 from the handing-filter spec.
    const openings: OpeningHandRecord[] = [
      makeOpening({ id: 'op-110-02C', doorNumber: '110-02C', hand: 'RHR', leafCount: 1 }),
    ]
    const items: Record<string, unknown>[] = [
      makeItem({ staging_opening_id: 'op-110-02C', name: 'Exit Device', model: '98L-NL-F × 996L-NL-R&V 06 RHR' }),
      makeItem({ staging_opening_id: 'op-110-02C', name: 'Exit Device', model: '98L-NL-F × 996L-NL-R&V 06 LHR' }),
      makeItem({ staging_opening_id: 'op-110-02C', name: 'Elec. Exit Modification', model: 'RE-1570-996L-NL-R&V-24VDC-AE-QC3 RHR' }),
      makeItem({ staging_opening_id: 'op-110-02C', name: 'Elec. Exit Modification', model: 'RE-1570-996L-NL-R&V-24VDC-AE-QC3 LHR' }),
      // An un-handed row — should always pass through.
      makeItem({ staging_opening_id: 'op-110-02C', name: 'Hinges', model: '5BB1 HW 4 1/2 × 4 1/2 NRP' }),
    ]
    const result = filterAllItemsByOpeningHand(items, openings, 'staging_opening_id')
    expect(result.kept).toHaveLength(3)
    expect(result.dropped).toHaveLength(2)
    expect(result.dropped.map(d => d.itemName).sort()).toEqual(['Elec. Exit Modification', 'Exit Device'])
    expect(result.dropped.every(d => d.itemHanding === 'LH' && d.openingHand === 'RH')).toBe(true)
  })

  it('reverse — drops RHR variant on LHR single-leaf opening', () => {
    const openings = [makeOpening({ hand: 'LHR', leafCount: 1 })]
    const items = [
      makeItem({ name: 'Exit', model: 'ED-LHR' }),
      makeItem({ name: 'Exit', model: 'ED-RHR' }),
    ]
    const result = filterAllItemsByOpeningHand(items, openings, 'staging_opening_id')
    expect(result.kept).toHaveLength(1)
    expect(result.dropped).toHaveLength(1)
    expect(result.dropped[0].itemHanding).toBe('RH')
    expect(result.dropped[0].openingHand).toBe('LH')
  })

  it('keeps items with no handing token even when opening has a hand', () => {
    const openings = [makeOpening({ hand: 'RHR' })]
    const items = [
      makeItem({ name: 'Closer', model: 'LCN 4040XP' }),
      makeItem({ name: 'Hinges', model: '5BB1 NRP' }),
    ]
    const result = filterAllItemsByOpeningHand(items, openings, 'staging_opening_id')
    expect(result.kept).toHaveLength(2)
    expect(result.dropped).toHaveLength(0)
  })

  it('skips pair openings entirely — leaf_count >= 2', () => {
    const openings = [makeOpening({ hand: 'RHR', leafCount: 2 })]
    const items = [
      makeItem({ name: 'Exit', model: 'ED-RHR' }),
      // LHR item on a pair would be dropped if pair filtering were enabled —
      // but pair handing is out of scope for this module, so it must pass.
      makeItem({ name: 'Exit', model: 'ED-LHR' }),
    ]
    const result = filterAllItemsByOpeningHand(items, openings, 'staging_opening_id')
    expect(result.kept).toHaveLength(2)
    expect(result.dropped).toHaveLength(0)
    expect(result.pairOpeningsSkipped).toBe(1)
  })

  it('keeps everything when opening hand yields no direction', () => {
    const openings = [makeOpening({ hand: 'Unknown' })]
    const items = [
      makeItem({ name: 'Exit', model: 'ED-RHR' }),
      makeItem({ name: 'Exit', model: 'ED-LHR' }),
    ]
    const result = filterAllItemsByOpeningHand(items, openings, 'staging_opening_id')
    expect(result.kept).toHaveLength(2)
    expect(result.dropped).toHaveLength(0)
    expect(result.openingsWithUnknownHand).toBe(1)
  })

  it('keeps everything when opening hand is null', () => {
    const openings = [makeOpening({ hand: null })]
    const items = [
      makeItem({ name: 'Exit', model: 'ED-RHR' }),
      makeItem({ name: 'Exit', model: 'ED-LHR' }),
    ]
    const result = filterAllItemsByOpeningHand(items, openings, 'staging_opening_id')
    expect(result.kept).toHaveLength(2)
    expect(result.openingsWithUnknownHand).toBe(1)
  })

  it('keeps items whose fkId has no matching opening record', () => {
    // Defensive: a row whose staging_opening_id is not in the openings map
    // (upstream data mismatch) should pass through rather than be dropped.
    const openings = [makeOpening({ id: 'op-known', hand: 'RHR' })]
    const items = [
      makeItem({ staging_opening_id: 'op-unknown', name: 'Exit', model: 'ED-LHR' }),
    ]
    const result = filterAllItemsByOpeningHand(items, openings, 'staging_opening_id')
    expect(result.kept).toHaveLength(1)
    expect(result.dropped).toHaveLength(0)
  })

  it('reads item handing from name when model is null', () => {
    const openings = [makeOpening({ hand: 'RHR' })]
    const items = [
      makeItem({ name: 'Exit Device LHR', model: null }),
    ]
    const result = filterAllItemsByOpeningHand(items, openings, 'staging_opening_id')
    expect(result.kept).toHaveLength(0)
    expect(result.dropped).toHaveLength(1)
  })

  it('uses the fkColumn the caller specifies', () => {
    const openings = [makeOpening({ id: 'prod-op-1', hand: 'RHR' })]
    const items = [
      { opening_id: 'prod-op-1', staging_opening_id: undefined, name: 'Exit', model: 'ED-LHR', qty: 1 },
    ]
    const result = filterAllItemsByOpeningHand(items, openings, 'opening_id')
    expect(result.kept).toHaveLength(0)
    expect(result.dropped).toHaveLength(1)
  })

  it('handles the matrix — RH opening × {RH, LH, null} item', () => {
    const openings = [makeOpening({ hand: 'RHR' })]
    const items = [
      makeItem({ name: 'a', model: 'x RHR' }),   // match → keep
      makeItem({ name: 'b', model: 'x LHR' }),   // mismatch → drop
      makeItem({ name: 'c', model: 'plain' }),   // null → keep
    ]
    const result = filterAllItemsByOpeningHand(items, openings, 'staging_opening_id')
    expect(result.kept.map(r => r['name']).sort()).toEqual(['a', 'c'])
    expect(result.dropped.map(d => d.itemName)).toEqual(['b'])
  })

  it('negative control — single-leaf opening with no handed hardware emits zero drops', () => {
    const openings = [makeOpening({ hand: 'RHR' })]
    const items = [
      makeItem({ name: 'Hinges', model: '5BB1 NRP' }),
      makeItem({ name: 'Closer', model: 'LCN 4040XP' }),
      makeItem({ name: 'Silencers', model: 'GJ-64' }),
    ]
    const result = filterAllItemsByOpeningHand(items, openings, 'staging_opening_id')
    expect(result.kept).toHaveLength(3)
    expect(result.dropped).toHaveLength(0)
  })
})
