import { describe, it, expect } from 'vitest'
import { buildOpeningAudit } from './extraction-opening-audit'
import type { HardwareSet } from '@/lib/types'
import type { PairSignalResult } from '@/lib/parse-pdf-helpers'

// Minimal HardwareSet factory — only the fields buildOpeningAudit reads.
// Cast to HardwareSet to avoid replicating the full type for every test.
const makeSet = (over: Partial<HardwareSet>): HardwareSet => ({
  set_id: 'TEST',
  generic_set_id: 'TEST',
  heading: '',
  heading_door_count: 0,
  heading_leaf_count: 0,
  heading_doors: [],
  qty_convention: 'unknown',
  items: [],
  ...over,
} as HardwareSet)

const sig = (tier: PairSignalResult['tier'], isPair: boolean): PairSignalResult => ({
  isPair,
  tier,
  evidence: { synthesised: true },
})

describe('buildOpeningAudit', () => {
  it('records the silent-loss case (header > emitted) for the Radius DC DH4-R-NOCR shape', () => {
    // Pre-fix shape: Python heading parser saw all four doors via the
    // secondary `#\d+` scan, but only one survived the join with the
    // Opening List table. After the audit lands, this divergence is
    // queryable directly from extraction_runs.opening_audit.
    const audit = buildOpeningAudit({
      hardwareSets: [
        makeSet({
          set_id: 'DH4-R-NOCR',
          heading: 'DH4.1',
          heading_door_count: 4,
          heading_doors: ['110-07B', '110A-04B', '110A-05B', '110A-06B'],
        }),
      ],
      stagingOpenings: [
        { door_number: '110-07B', hw_set: 'DH4-R-NOCR', leaf_count: 1 },
      ],
      pairSignalsByDoor: new Map([['110-07B', sig('none', false)]]),
    })

    expect(audit.sets).toHaveLength(1)
    const set = audit.sets[0]
    expect(set.set_id).toBe('DH4-R-NOCR')
    expect(set.header_door_count).toBe(4)
    expect(set.header_door_numbers).toEqual([
      '110-07B', '110A-04B', '110A-05B', '110A-06B',
    ])
    // The smoking gun: header says 4, only 1 emitted.
    expect(set.emitted_opening_count).toBe(1)
    expect(set.header_door_count).toBeGreaterThan(set.emitted_opening_count)

    expect(audit.openings).toHaveLength(1)
    const opening = audit.openings[0]
    expect(opening.door_number).toBe('110-07B')
    expect(opening.leaf_count).toBe(1)
    // pair_signal_tier='none' means every detection tier failed for this
    // opening — the strongest available signal that pair detection should
    // be revisited (or that the upstream extractor lost the pair shape).
    expect(opening.pair_signal_tier).toBe('none')
  })

  it('records the healthy case (header == emitted, primary signal won)', () => {
    const audit = buildOpeningAudit({
      hardwareSets: [
        makeSet({
          set_id: 'DH4A',
          heading: 'DH4A.1',
          heading_door_count: 2,
          heading_leaf_count: 4,
          heading_doors: ['110A-04A', '110A-05A'],
        }),
      ],
      stagingOpenings: [
        { door_number: '110A-04A', hw_set: 'DH4A', leaf_count: 2 },
        { door_number: '110A-05A', hw_set: 'DH4A', leaf_count: 2 },
      ],
      pairSignalsByDoor: new Map([
        ['110A-04A', sig('primary', true)],
        ['110A-05A', sig('primary', true)],
      ]),
    })

    const set = audit.sets[0]
    expect(set.header_door_count).toBe(2)
    expect(set.emitted_opening_count).toBe(2)
    expect(audit.openings.every(o => o.pair_signal_tier === 'primary')).toBe(true)
    expect(audit.openings.every(o => o.leaf_count === 2)).toBe(true)
  })

  it('captures qty_door_count from the first divided item for set_level_qty_door_count', () => {
    const audit = buildOpeningAudit({
      hardwareSets: [
        makeSet({
          set_id: 'DH4-R-NOCR',
          heading_door_count: 4,
          heading_doors: ['110-07B', '110A-04B', '110A-05B', '110A-06B'],
          // Mirrors the real DH4-R-NOCR: 32 hinges across 4 openings, the
          // normalizer divided by 4 so each per-opening row stores
          // qty_door_count=4. When emitted_opening_count drops to 1 the
          // divisor is the audit signal that the math used the header
          // total even though only one opening reached the DB.
          items: [{ name: 'Hinges', qty: 8, qty_door_count: 4 } as unknown as HardwareSet['items'][number]],
        }),
      ],
      stagingOpenings: [
        { door_number: '110-07B', hw_set: 'DH4-R-NOCR', leaf_count: 1 },
      ],
      pairSignalsByDoor: new Map([['110-07B', sig('none', false)]]),
    })

    expect(audit.sets[0].set_level_qty_door_count).toBe(4)
    expect(audit.sets[0].emitted_opening_count).toBe(1)
  })

  it('routes openings to the correct set whether hw_set is the sub-set or the umbrella generic_set_id', () => {
    const audit = buildOpeningAudit({
      hardwareSets: [
        makeSet({
          set_id: 'DH4A.1',
          generic_set_id: 'DH4A',
          heading_door_count: 1,
          heading_doors: ['110A-04A'],
        }),
      ],
      stagingOpenings: [
        // One door references the umbrella id, one references the sub-set.
        // buildSetLookupMap registers both keys; the audit must follow.
        { door_number: '110A-04A', hw_set: 'DH4A', leaf_count: 2 },
      ],
      pairSignalsByDoor: new Map([['110A-04A', sig('secondary', true)]]),
    })

    // Both lookup paths are exercised by the implementation; emitted_count
    // resolves via the generic_set_id fallback when set_id misses.
    expect(audit.sets[0].emitted_opening_count).toBe(1)
  })

  it('falls back to "none" tier when pair signal map lacks an opening', () => {
    const audit = buildOpeningAudit({
      hardwareSets: [makeSet({ set_id: 'X', heading_door_count: 1, heading_doors: ['101'] })],
      stagingOpenings: [{ door_number: '101', hw_set: 'X', leaf_count: 1 }],
      pairSignalsByDoor: new Map(),
    })
    expect(audit.openings[0].pair_signal_tier).toBe('none')
    expect(audit.openings[0].pair_signal_evidence).toEqual({})
  })
})
