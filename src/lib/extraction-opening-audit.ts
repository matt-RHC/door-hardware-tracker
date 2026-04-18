/**
 * Per-run opening + pair-signal audit assembler.
 *
 * Migration 048 added `extraction_runs.opening_audit` (JSONB). This module
 * builds the payload from the data already in scope at staging-write time.
 *
 * Why this matters: on 2026-04-18 the Radius DC DH4-R-NOCR set silently
 * dropped 3 of 4 openings (heading regex didn't match "Double Egress Door"),
 * and the surviving opening landed with leaf_count=1 despite being a pair.
 * Both failures were invisible from the database alone — diagnosing required
 * re-running the extractor against the raw PDF. The audit captured here lets
 * the next bug like this be diagnosed in seconds via:
 *
 *   SELECT er.id, jsonb_pretty(s) AS divergent_set
 *   FROM extraction_runs er,
 *        jsonb_array_elements(er.opening_audit -> 'sets') s
 *   WHERE (s->>'header_door_count')::int > (s->>'emitted_opening_count')::int;
 */

import type { HardwareSet } from '@/lib/types'
import type { PairSignalResult } from '@/lib/parse-pdf-helpers'

/**
 * Per-set audit row. Captures what the Python extractor *thought* the set
 * contained vs. what reached staging. A row where header_door_count >
 * emitted_opening_count is a silent-loss event — exactly the bug class
 * that motivated this column.
 *
 * `set_level_qty_door_count` is the divisor the quantity normalizer used
 * (taken from the first item with `qty_source='divided'`); when this
 * disagrees with `emitted_opening_count` the math was applied against the
 * header total even though only some of the openings made it through.
 */
export interface OpeningAuditSet {
  set_id: string
  heading: string | null
  header_door_count: number
  header_door_numbers: string[]
  emitted_opening_count: number
  set_level_qty_door_count: number | null
}

/**
 * Per-opening audit row. Records leaf_count alongside the winning
 * pair-detection tier so historical openings remain explainable even if
 * the detection logic later changes. `pair_signal_evidence` is the same
 * record that detectIsPairWithTrace wrote to stdout — preserving it on
 * disk means we don't have to grep Vercel log retention to reconstruct
 * what the signal saw at the time of save.
 */
export interface OpeningAuditOpening {
  door_number: string
  set_id: string | null
  leaf_count: number
  pair_signal_tier: PairSignalResult['tier']
  pair_signal_evidence: Record<string, unknown>
}

export interface OpeningAudit {
  sets: OpeningAuditSet[]
  openings: OpeningAuditOpening[]
}

interface BuildOpeningAuditInput {
  hardwareSets: HardwareSet[]
  /** Each entry mirrors what writeStagingData received: a door_number plus
   *  the resolved hw_set string (which may be the generic_set_id or the
   *  exact set_id; both keys are honored when counting per-set membership). */
  stagingOpenings: Array<{ door_number: string; hw_set: string | null | undefined; leaf_count: number }>
  /** door_number → PairSignalResult captured from detectIsPairWithTrace. */
  pairSignalsByDoor: Map<string, PairSignalResult>
}

/**
 * Build the opening_audit payload. Pure function — no I/O, no Sentry, no
 * Supabase. Side-effect-free so it can be unit-tested with synthetic
 * HardwareSets / StagingOpenings without spinning up a database.
 */
export function buildOpeningAudit(input: BuildOpeningAuditInput): OpeningAudit {
  const { hardwareSets, stagingOpenings, pairSignalsByDoor } = input

  // Group emitted opening counts by both set_id and generic_set_id so
  // either flavor of hw_set string in `stagingOpenings` resolves the same
  // HardwareSet (matches buildSetLookupMap's both-keys registration).
  const emittedBySetKey = new Map<string, number>()
  for (const o of stagingOpenings) {
    const key = (o.hw_set ?? '').trim()
    if (!key) continue
    emittedBySetKey.set(key, (emittedBySetKey.get(key) ?? 0) + 1)
  }

  const setSummaries: OpeningAuditSet[] = hardwareSets.map(hwSet => {
    // Take whichever key has a non-zero count; prefer set_id (the canonical
    // sub-set) over generic_set_id (the umbrella) so a door routed via the
    // sub-set isn't double-counted into the umbrella's audit row.
    const emittedCount =
      emittedBySetKey.get(hwSet.set_id) ??
      (hwSet.generic_set_id ? emittedBySetKey.get(hwSet.generic_set_id) : undefined) ??
      0

    // Pull the divisor the quantity normalizer used (if any). Items can
    // disagree on qty_door_count when the set spans multiple openings with
    // different leaf counts, so we keep the first non-null divisor as a
    // representative — divergence is rare and the per-opening audit row
    // below is the definitive per-leaf record.
    let setLevelQtyDoorCount: number | null = null
    for (const item of hwSet.items ?? []) {
      const dc = (item as { qty_door_count?: number | null }).qty_door_count
      if (typeof dc === 'number') {
        setLevelQtyDoorCount = dc
        break
      }
    }

    return {
      set_id: hwSet.set_id,
      heading: hwSet.heading ?? null,
      header_door_count: hwSet.heading_door_count ?? 0,
      header_door_numbers: hwSet.heading_doors ?? [],
      emitted_opening_count: emittedCount,
      set_level_qty_door_count: setLevelQtyDoorCount,
    }
  })

  const openingSummaries: OpeningAuditOpening[] = stagingOpenings.map(o => {
    const signal = pairSignalsByDoor.get(o.door_number)
    return {
      door_number: o.door_number,
      set_id: (o.hw_set ?? '').trim() || null,
      leaf_count: o.leaf_count,
      pair_signal_tier: signal?.tier ?? 'none',
      pair_signal_evidence: signal?.evidence ?? {},
    }
  })

  return { sets: setSummaries, openings: openingSummaries }
}
