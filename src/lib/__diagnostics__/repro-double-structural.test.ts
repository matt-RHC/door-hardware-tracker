/**
 * Diagnostic regression test — Radius DC "double structural rows" bug
 *
 * Context: production extraction_run 5fd76705-b97a-49e9-888e-ddf4f0a34597
 * (Radius DC project a47ea03c-7a19-40b0-b590-f7961de72811) promoted on
 * 2026-04-17 03:58:10 UTC exhibits every opening having TWO structural row
 * blocks in staging_hardware_items / hardware_items:
 *
 *   Single-leaf (e.g. door 1400, hw_set AD11-IS):
 *     sort 0: Door, sort 1: Frame, sort 2: Door, sort 3: Frame, sort 4+: set items
 *
 *   Pair (e.g. door 110-01B, hw_set DH1-10):
 *     sort 0: Door, sort 1: Frame, sort 2: Door (Active Leaf),
 *     sort 3: Door (Inactive Leaf), sort 4: Frame, sort 5+: set items
 *
 * 51 single-leaf openings carry 2 Door + 2 Frame rows each.
 * 25 pair openings carry 3 Door + 2 Frame rows each (1 bare "Door" + 2 leaf-named + 2 "Frame").
 *
 * Gate intent: the `buildPerOpeningItems` helper in parse-pdf-helpers.ts,
 * invoked once per save, MUST produce exactly ONE structural "Door" (or
 * Active/Inactive pair) plus ONE "Frame" per opening. Any payload shape
 * that makes a single call output more than that is a regression.
 *
 * This harness exercises the helper against Radius-DC-shaped payloads to
 * assert that invariant. It is intentionally RED on shapes that reproduce
 * the bug and GREEN on the current helper when the payload is clean.
 *
 * To run against the actual production payload, set
 *   DHT_RADIUS_DC_PAYLOAD=/path/to/captured/save-request.json
 * where the JSON file is the body of a POST /api/parse-pdf/save request.
 * When that env var is unset we fall back to a synthetic fixture that
 * mirrors the observed Radius DC structure so the test still runs.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import {
  buildPerOpeningItems,
  buildSetLookupMap,
  buildDoorToSetMap,
} from '@/lib/parse-pdf-helpers'
import type { HardwareSet, DoorEntry } from '@/lib/types'

// ─── Synthetic fixture modelled on Radius DC ─────────────────────────────
// The payload shape mirrors what StepConfirm POSTs to /api/parse-pdf/save:
//   { projectId, hardwareSets: HardwareSet[], doors: DoorEntry[] }
// One single-leaf door on AD11-IS + one pair on DH1-10, both with door_type
// and frame_type populated (the exact preconditions that produced the
// doubled structural rows in production).
const SYNTHETIC_PAYLOAD: {
  projectId: string
  hardwareSets: HardwareSet[]
  doors: DoorEntry[]
} = {
  projectId: 'a47ea03c-7a19-40b0-b590-f7961de72811',
  hardwareSets: [
    {
      set_id: 'AD11-IS',
      heading: 'Heading #AD11-IS',
      heading_door_count: 1,
      heading_leaf_count: 1,
      heading_doors: ['1400'],
      items: [
        { name: 'Continuous Hinge', qty: 1, model: 'HG315HD', finish: '630', manufacturer: 'Select' },
        { name: 'Storeroom Lock', qty: 1, model: 'ND80PD RHO', finish: '626', manufacturer: 'Schlage' },
        { name: 'Closer', qty: 1, model: '4040XP EDA', finish: 'AL', manufacturer: 'LCN' },
      ],
    },
    {
      set_id: 'DH1-10',
      heading: 'Heading #DH1-10',
      heading_door_count: 1,
      heading_leaf_count: 2,
      heading_doors: ['110-01B'],
      items: [
        { name: 'Hinges 5BB1 4.5x4.5', qty: 3, model: '5BB1 4.5x4.5', finish: '652', manufacturer: 'Ives' },
        { name: 'Mortise Lock', qty: 1, model: 'L9050 RHR', finish: '626', manufacturer: 'Schlage' },
        { name: 'Closer', qty: 1, model: '4040XP EDA', finish: 'AL', manufacturer: 'LCN' },
      ],
    },
  ],
  doors: [
    {
      door_number: '1400',
      hw_set: 'AD11-IS',
      hw_heading: 'Heading #AD11-IS',
      location: 'Mech Room',
      door_type: 'A',
      frame_type: 'F1',
      fire_rating: '90 min',
      hand: 'RH',
    },
    {
      door_number: '110-01B',
      hw_set: 'DH1-10',
      hw_heading: 'Heading #DH1-10',
      location: 'Office Suite',
      door_type: 'A',
      frame_type: 'F2',
      fire_rating: '',
      hand: 'LHR',
    },
  ],
}

function loadPayload(): typeof SYNTHETIC_PAYLOAD {
  const envPath = process.env.DHT_RADIUS_DC_PAYLOAD
  if (envPath && existsSync(envPath)) {
    const raw = JSON.parse(readFileSync(envPath, 'utf8'))
    // The capture format is the exact body of POST /api/parse-pdf/save.
    return {
      projectId: raw.projectId,
      hardwareSets: raw.hardwareSets,
      doors: raw.doors,
    }
  }
  return SYNTHETIC_PAYLOAD
}

// ─── The invariant ────────────────────────────────────────────────────────
// After one save cycle, every opening's staging rows should contain either:
//   (A) exactly 1 "Door" + 1 "Frame"   (single-leaf), OR
//   (B) exactly 1 "Door (Active Leaf)" + 1 "Door (Inactive Leaf)" + 1 "Frame" (pair)
// Anything else — in particular ANY combination that contains both a bare
// "Door" and a "Door (Active Leaf)" on the same opening, or two bare "Door"
// rows on a single-leaf opening — is the bug.

describe('Radius DC: buildPerOpeningItems must not emit duplicate structural rows', () => {
  it('produces at most 1 bare Door + 1 Frame per single-leaf opening (NO duplicates)', () => {
    const { hardwareSets, doors } = loadPayload()

    const setMap = buildSetLookupMap(hardwareSets)
    const doorToSetMap = buildDoorToSetMap(hardwareSets)

    const doorInfoMap = new Map<string, { door_type: string; frame_type: string }>()
    for (const d of doors) {
      doorInfoMap.set(d.door_number, {
        door_type: d.door_type || '',
        frame_type: d.frame_type || '',
      })
    }

    // Simulate save/route.ts step 4: query-back shape (id + door_number + hw_set)
    const openings = doors.map((d, i) => ({
      id: `stub-staging-${i}`,
      door_number: d.door_number,
      hw_set: d.hw_set ?? null,
    }))

    const allItems = buildPerOpeningItems(
      openings,
      doorInfoMap,
      setMap,
      doorToSetMap,
      'staging_opening_id',
      { extraction_run_id: 'stub-run' },
    )

    // Group by opening
    const byOpening = new Map<string, Array<Record<string, unknown>>>()
    for (const r of allItems) {
      const oid = r.staging_opening_id as string
      if (!byOpening.has(oid)) byOpening.set(oid, [])
      byOpening.get(oid)!.push(r)
    }

    for (const [, rows] of byOpening) {
      const doorRows = rows.filter(r => (r.name as string).startsWith('Door'))
      const frameRows = rows.filter(r => r.name === 'Frame')

      const bareDoorCount = doorRows.filter(r => r.name === 'Door').length
      const activeLeafCount = doorRows.filter(r => r.name === 'Door (Active Leaf)').length
      const inactiveLeafCount = doorRows.filter(r => r.name === 'Door (Inactive Leaf)').length

      // A single-leaf opening must never coexist with leaf-named rows;
      // a pair opening must never coexist with a bare Door row.
      expect(
        bareDoorCount + activeLeafCount + inactiveLeafCount,
        'structural door count per opening',
      ).toBeLessThanOrEqual(2)

      if (bareDoorCount > 0) {
        expect(activeLeafCount, 'bare Door and Active Leaf must not coexist').toBe(0)
        expect(inactiveLeafCount, 'bare Door and Inactive Leaf must not coexist').toBe(0)
        expect(bareDoorCount, 'at most one bare Door per opening').toBe(1)
      }

      if (activeLeafCount > 0 || inactiveLeafCount > 0) {
        expect(bareDoorCount, 'pair opening must have no bare Door row').toBe(0)
        expect(activeLeafCount, 'exactly one Active Leaf').toBe(1)
        expect(inactiveLeafCount, 'exactly one Inactive Leaf').toBe(1)
      }

      expect(frameRows.length, 'exactly one Frame per opening').toBe(1)
    }
  })

  it('sort_order is strictly increasing 0..N with no gaps or duplicates per opening', () => {
    const { hardwareSets, doors } = loadPayload()
    const setMap = buildSetLookupMap(hardwareSets)
    const doorToSetMap = buildDoorToSetMap(hardwareSets)
    const doorInfoMap = new Map<string, { door_type: string; frame_type: string }>()
    for (const d of doors) {
      doorInfoMap.set(d.door_number, {
        door_type: d.door_type || '',
        frame_type: d.frame_type || '',
      })
    }
    const openings = doors.map((d, i) => ({
      id: `stub-staging-${i}`,
      door_number: d.door_number,
      hw_set: d.hw_set ?? null,
    }))

    const rows = buildPerOpeningItems(openings, doorInfoMap, setMap, doorToSetMap, 'staging_opening_id', {})

    const byOpening = new Map<string, number[]>()
    for (const r of rows) {
      const oid = r.staging_opening_id as string
      if (!byOpening.has(oid)) byOpening.set(oid, [])
      byOpening.get(oid)!.push(r.sort_order as number)
    }

    for (const [oid, orders] of byOpening) {
      orders.sort((a, b) => a - b)
      // No duplicates
      const set = new Set(orders)
      expect(set.size, `duplicate sort_order values in ${oid}: ${orders.join(',')}`).toBe(orders.length)
      // Starts at 0, strictly sequential
      expect(orders[0], `first sort_order should be 0 for ${oid}`).toBe(0)
      for (let i = 1; i < orders.length; i++) {
        expect(orders[i], `sort_order gap at ${i} in ${oid}: ${orders.join(',')}`).toBe(orders[i - 1] + 1)
      }
    }
  })

  // This test is the regression GATE. It fails against any payload/shape
  // that reproduces the Radius DC production pattern (e.g. a second writer,
  // a double-invocation of buildPerOpeningItems, or a payload with "Door" /
  // "Frame" pre-embedded as items by Python or by the wizard client).
  it('REGRESSION GATE: Radius DC payload must NOT yield 2× Door/Frame blocks', () => {
    const { hardwareSets, doors } = loadPayload()
    const setMap = buildSetLookupMap(hardwareSets)
    const doorToSetMap = buildDoorToSetMap(hardwareSets)
    const doorInfoMap = new Map<string, { door_type: string; frame_type: string }>()
    for (const d of doors) {
      doorInfoMap.set(d.door_number, {
        door_type: d.door_type || '',
        frame_type: d.frame_type || '',
      })
    }
    const openings = doors.map((d, i) => ({
      id: `stub-${i}`,
      door_number: d.door_number,
      hw_set: d.hw_set ?? null,
    }))
    const rows = buildPerOpeningItems(openings, doorInfoMap, setMap, doorToSetMap, 'staging_opening_id', {})

    for (const opening of openings) {
      const r = rows.filter(x => x.staging_opening_id === opening.id)
      const doors = r.filter(x => (x.name as string) === 'Door' || (x.name as string).startsWith('Door (')).map(x => x.name)
      const frames = r.filter(x => (x.name as string) === 'Frame').map(x => x.name)

      // The exact pattern observed in production — and which this test
      // must REJECT — is two bare "Door" + two "Frame" on single-leaf
      // (or a bare "Door" plus both leaf names on a pair, plus 2 Frames).
      const bareDoors = doors.filter(n => n === 'Door').length
      expect(bareDoors, `opening ${opening.door_number} must not have 2× bare Door rows (observed: ${doors.join(', ')})`).toBeLessThanOrEqual(1)
      expect(frames.length, `opening ${opening.door_number} must have exactly 1 Frame row (observed ${frames.length})`).toBe(1)

      // Cross-check: a pair opening must NEVER have a bare Door alongside
      // leaf-named Doors — that's the exact fingerprint of the bug.
      const hasLeafNames = doors.some(n => n === 'Door (Active Leaf)' || n === 'Door (Inactive Leaf)')
      if (hasLeafNames) {
        expect(bareDoors, `pair opening ${opening.door_number} must not mix bare Door with leaf names`).toBe(0)
      }
    }
  })

  // Documents that buildPerOpeningItems is the AMPLIFIER — given a
  // Radius-DC-shaped payload where Python already emitted phantom bare
  // "Door"/"Frame" rows in hwSet.items (the pre-fix state), the helper
  // faithfully appends them on top of its own structural rows, yielding
  // the exact 2× Door / 2× Frame fingerprint observed in production.
  // This test stays GREEN to pin that behavior; the Python fix
  // (NON_HARDWARE_PATTERN) prevents the phantom inputs upstream, so this
  // amplification path is not reachable in prod.
  it('AMPLIFICATION WITNESS: phantom Python Door/Frame items produce >1 bare Door per opening', () => {
    const PHANTOM_PAYLOAD = {
      ...SYNTHETIC_PAYLOAD,
      hardwareSets: SYNTHETIC_PAYLOAD.hardwareSets.map(s => ({
        ...s,
        items: [
          ...s.items,
          { name: 'Door',  qty: 1, model: 'A',  finish: '', manufacturer: '' },
          { name: 'Frame', qty: 1, model: 'F1', finish: '', manufacturer: '' },
        ],
      })),
    }

    const { hardwareSets, doors } = PHANTOM_PAYLOAD
    const setMap = buildSetLookupMap(hardwareSets)
    const doorToSetMap = buildDoorToSetMap(hardwareSets)
    const doorInfoMap = new Map<string, { door_type: string; frame_type: string }>()
    for (const d of doors) {
      doorInfoMap.set(d.door_number, {
        door_type: d.door_type || '',
        frame_type: d.frame_type || '',
      })
    }
    const openings = doors.map((d, i) => ({
      id: `stub-phantom-${i}`,
      door_number: d.door_number,
      hw_set: d.hw_set ?? null,
    }))

    const rows = buildPerOpeningItems(openings, doorInfoMap, setMap, doorToSetMap, 'staging_opening_id', {})

    let maxBareDoors = 0
    let maxFrames = 0
    for (const o of openings) {
      const r = rows.filter(x => x.staging_opening_id === o.id)
      maxBareDoors = Math.max(maxBareDoors, r.filter(x => x.name === 'Door').length)
      maxFrames = Math.max(maxFrames, r.filter(x => x.name === 'Frame').length)
    }

    // The exact Radius DC production fingerprint: 2× Door + 2× Frame
    // per opening. If this drops to 1×, either the TS helper started
    // filtering phantom rows (which is NOT what we want — that would
    // mask future Python regressions) or the fixture stopped seeding
    // phantoms.
    expect(maxBareDoors, 'phantom Python items should amplify into >1 bare Door rows').toBeGreaterThan(1)
    expect(maxFrames, 'phantom Python items should amplify into >1 Frame rows').toBeGreaterThan(1)
  })
})
