/**
 * Extraction-invariants layer.
 *
 * Lightweight post-promote gate that catches silent garbage — cases where
 * extraction produced data that *looks* fine to the pipeline but violates
 * structural rules a DFH consultant would spot by eye (two "Door" rows on
 * a single, an extra "Frame", a fire-rating string in the location column,
 * a door routed to the generic set when a sub-set owns it, etc.).
 *
 * Origin: the 2026-04-17 Radius DC regression produced wrong data on 80
 * openings / 1147 hardware items and no alarm fired. The only way we
 * noticed was a human reviewing one door page. These invariants make that
 * class of failure visible — they only observe, they do not repair.
 *
 * Usage:
 *   const report = await validateExtractionRun(runId, supabase)
 *   if (report.blockers > 0) { ... }
 *
 * See `src/app/api/parse-pdf/save/route.ts` for the save-path wiring and
 * `scripts/audit-extraction-invariants.ts` for the batch/CI version.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/types/database'
import type { HardwareSet } from '@/lib/types'
import { buildPerOpeningItems, classifyItemScope, normalizeDoorNumber } from '@/lib/parse-pdf-helpers'
import { inferHandingDirection } from '@/lib/hardware-handing-filter'
import { classifyItem } from '@/lib/hardware-taxonomy'

// ── Rule identifiers ────────────────────────────────────────────────────────
//
// Intentionally explicit string literals instead of a generic code so Sentry
// tags and audit reports can be grouped by rule without a lookup table.
export type InvariantRule =
  | 'too_many_doors'
  | 'conflicting_door_variants'
  | 'too_many_frames'
  | 'single_leaf_door_count_mismatch'
  | 'pair_leaf_door_count_mismatch'
  | 'location_matches_fire_rating'
  | 'heading_door_set_mismatch'
  | 'per_leaf_qty_sum_mismatch'
  | 'leaf_count_consistency'
  | 'handing_consistency'
  | 'pair_leaf_hinge_duplication'

export type InvariantSeverity = 'blocker' | 'warning'

export interface InvariantViolation {
  rule: InvariantRule
  opening_id: string | null
  door_number: string | null
  details: string
  severity: InvariantSeverity
}

export interface InvariantReport {
  runId: string
  projectId: string
  checkedOpenings: number
  checkedItems: number
  violations: InvariantViolation[]
  blockers: number
  warnings: number
  /** Rules that were skipped because required context wasn't supplied
   *  (e.g., rule g needs the original hardwareSets payload). */
  skippedRules: InvariantRule[]
}

export interface ValidateOptions {
  /** Enables rule (g): cross-checks heading_doors assignments against the
   *  promoted hw_set per opening. Not persisted anywhere post-promote, so
   *  the caller (save route, smoke test) must pass it. */
  hardwareSets?: HardwareSet[]
}

// ── Named constants (no magic values) ──────────────────────────────────────
const LEAF_COUNT_SINGLE = 1
const LEAF_COUNT_PAIR = 2
const MAX_DOOR_ROWS_PER_OPENING = 2
const MAX_FRAME_ROWS_PER_OPENING = 1

// Matches the location/fire-rating regex from the task brief.
const FIRE_RATING_LOCATION_RE = /^\d+\s*(min|hr|hour|minute)|^NR$|^UL$/i

// Row-name matchers — match the shapes buildPerOpeningItems emits.
const DOOR_NAME_ANY = /^Door(\s|$|\()/          // "Door", "Door (...)", "Door\t..."
const DOOR_NAME_BARE = /^Door$/
const DOOR_NAME_ACTIVE_LEAF = /^Door \(Active Leaf\)$/
const DOOR_NAME_INACTIVE_LEAF = /^Door \(Inactive Leaf\)$/
const FRAME_NAME = /^Frame$/

type OpeningRow = {
  id: string
  door_number: string
  hw_set: string | null
  leaf_count: number
  location: string | null
  hand: string | null
}

type HardwareItemRow = {
  id: string
  opening_id: string
  name: string
  qty: number | null
  leaf_side: string | null
  model: string | null
}

/**
 * Runs every structural invariant over a single promoted extraction run and
 * returns a violation list. Does not throw for violations — throws only when
 * required database state is missing (run not found, I/O error).
 *
 * The check keys off `staging_openings.extraction_run_id` to pin the exact
 * doors this run touched, then reads the *current* production state for
 * those doors. That means it also detects drift introduced by later user
 * edits against the promoted snapshot, which is the right behavior — we
 * want to catch silent garbage regardless of which code path produced it.
 */
export async function validateExtractionRun(
  runId: string,
  supabase: SupabaseClient<Database>,
  options: ValidateOptions = {},
): Promise<InvariantReport> {
  // 1) Resolve run → project_id
  const { data: runRow, error: runErr } = await supabase
    .from('extraction_runs')
    .select('id, project_id')
    .eq('id', runId)
    .single()

  if (runErr || !runRow) {
    throw new Error(
      `validateExtractionRun: run ${runId} not found: ${runErr?.message ?? 'no row returned'}`,
    )
  }

  const projectId = runRow.project_id

  // 2) Staging door_numbers pin which openings this run owns
  const { data: stagingRows, error: stagingErr } = await supabase
    .from('staging_openings')
    .select('door_number')
    .eq('extraction_run_id', runId)

  if (stagingErr) {
    throw new Error(
      `validateExtractionRun: failed to read staging_openings: ${stagingErr.message}`,
    )
  }

  const doorNumbers = (stagingRows ?? []).map(r => r.door_number)
  const skippedRules: InvariantRule[] = []
  if (!options.hardwareSets || options.hardwareSets.length === 0) {
    skippedRules.push('heading_door_set_mismatch')
  }

  if (doorNumbers.length === 0) {
    return {
      runId,
      projectId,
      checkedOpenings: 0,
      checkedItems: 0,
      violations: [],
      blockers: 0,
      warnings: 0,
      skippedRules,
    }
  }

  // 3) Promoted openings for this run's doors
  const { data: openingRows, error: openingsErr } = await supabase
    .from('openings')
    .select('id, door_number, hw_set, leaf_count, location, hand')
    .eq('project_id', projectId)
    .in('door_number', doorNumbers)

  if (openingsErr) {
    throw new Error(
      `validateExtractionRun: failed to read openings: ${openingsErr.message}`,
    )
  }

  const openings = (openingRows ?? []) as OpeningRow[]
  const openingIds = openings.map(o => o.id)

  // 4) Hardware items for those openings
  let items: HardwareItemRow[] = []
  if (openingIds.length > 0) {
    const { data: itemRows, error: itemsErr } = await supabase
      .from('hardware_items')
      .select('id, opening_id, name, qty, leaf_side, model')
      .in('opening_id', openingIds)

    if (itemsErr) {
      throw new Error(
        `validateExtractionRun: failed to read hardware_items: ${itemsErr.message}`,
      )
    }
    items = (itemRows ?? []) as HardwareItemRow[]
  }

  const violations = runInvariants(openings, items, options.hardwareSets ?? [])

  const blockers = violations.filter(v => v.severity === 'blocker').length
  const warnings = violations.filter(v => v.severity === 'warning').length

  return {
    runId,
    projectId,
    checkedOpenings: openings.length,
    checkedItems: items.length,
    violations,
    blockers,
    warnings,
    skippedRules,
  }
}

/**
 * Pure in-memory invariant check. Exported so unit tests can hit each rule
 * with a minimal fixture and the audit script can reuse the same logic
 * over a different query shape.
 */
export function runInvariants(
  openings: ReadonlyArray<OpeningRow>,
  items: ReadonlyArray<HardwareItemRow>,
  hardwareSets: ReadonlyArray<HardwareSet>,
): InvariantViolation[] {
  // Pre-bucket items by opening for O(1) lookup in the main loop.
  const itemsByOpening = new Map<string, HardwareItemRow[]>()
  for (const it of items) {
    const bucket = itemsByOpening.get(it.opening_id) ?? []
    bucket.push(it)
    itemsByOpening.set(it.opening_id, bucket)
  }

  const violations: InvariantViolation[] = []

  for (const opening of openings) {
    const ois = itemsByOpening.get(opening.id) ?? []

    const doorRows = ois.filter(i => DOOR_NAME_ANY.test(i.name ?? ''))
    const bareDoorRows = ois.filter(i => DOOR_NAME_BARE.test(i.name ?? ''))
    const activeLeafRows = ois.filter(i => DOOR_NAME_ACTIVE_LEAF.test(i.name ?? ''))
    const inactiveLeafRows = ois.filter(i => DOOR_NAME_INACTIVE_LEAF.test(i.name ?? ''))
    const frameRows = ois.filter(i => FRAME_NAME.test(i.name ?? ''))

    // (a) No opening has more than 2 Door* rows total
    if (doorRows.length > MAX_DOOR_ROWS_PER_OPENING) {
      violations.push({
        rule: 'too_many_doors',
        opening_id: opening.id,
        door_number: opening.door_number,
        details: `Opening has ${doorRows.length} Door* rows (expected ≤ ${MAX_DOOR_ROWS_PER_OPENING}): ${doorRows.map(r => r.name).join(', ')}`,
        severity: 'blocker',
      })
    }

    // (b) No opening has both bare "Door" AND a "Door (Active/Inactive Leaf)"
    if (bareDoorRows.length > 0 && (activeLeafRows.length > 0 || inactiveLeafRows.length > 0)) {
      violations.push({
        rule: 'conflicting_door_variants',
        opening_id: opening.id,
        door_number: opening.door_number,
        details: `Opening has bare "Door" alongside a leaf-specific Door row — single/pair classification conflict.`,
        severity: 'blocker',
      })
    }

    // (c) No opening has more than 1 Frame row
    if (frameRows.length > MAX_FRAME_ROWS_PER_OPENING) {
      violations.push({
        rule: 'too_many_frames',
        opening_id: opening.id,
        door_number: opening.door_number,
        details: `Opening has ${frameRows.length} Frame rows (expected ≤ ${MAX_FRAME_ROWS_PER_OPENING}).`,
        severity: 'blocker',
      })
    }

    // (d) leaf_count === 1 → exactly 1 Door* row (only when any door row
    //     is present; no Door row is legal for doors with no door_type).
    if (opening.leaf_count === LEAF_COUNT_SINGLE && doorRows.length > 0 && doorRows.length !== 1) {
      violations.push({
        rule: 'single_leaf_door_count_mismatch',
        opening_id: opening.id,
        door_number: opening.door_number,
        details: `leaf_count=1 but ${doorRows.length} Door* rows present (expected 1): ${doorRows.map(r => r.name).join(', ')}`,
        severity: 'blocker',
      })
    }

    // (e) leaf_count === 2 → exactly 2 Door* rows, one Active + one Inactive
    if (opening.leaf_count === LEAF_COUNT_PAIR && doorRows.length > 0) {
      if (doorRows.length !== 2 || activeLeafRows.length !== 1 || inactiveLeafRows.length !== 1) {
        violations.push({
          rule: 'pair_leaf_door_count_mismatch',
          opening_id: opening.id,
          door_number: opening.door_number,
          details: `leaf_count=2 but Door* rows=${doorRows.length} (active=${activeLeafRows.length}, inactive=${inactiveLeafRows.length}). Expected 2 rows — 1 Active Leaf + 1 Inactive Leaf.`,
          severity: 'blocker',
        })
      }
    }

    // (f) location does NOT match fire-rating regex
    const loc = (opening.location ?? '').trim()
    if (loc.length > 0 && FIRE_RATING_LOCATION_RE.test(loc)) {
      violations.push({
        rule: 'location_matches_fire_rating',
        opening_id: opening.id,
        door_number: opening.door_number,
        details: `openings.location="${loc}" matches fire-rating pattern; suspected location/fire-rating column swap.`,
        severity: 'warning',
      })
    }

    // (h) per_leaf item qty sum sanity on pairs
    //
    // We can't recompute the exact expected qty without the original set
    // payload (electric-hinge splits shift the distribution). Instead we
    // assert a band: on a pair, the per-leaf item's qty-sum should fall
    // between max(qty per side) and 2× max(qty per side). Outside that
    // range means either the per-leaf row was dropped on one side or
    // doubled unexpectedly.
    if (opening.leaf_count === LEAF_COUNT_PAIR) {
      const perLeafRowsByName = new Map<string, HardwareItemRow[]>()
      for (const it of ois) {
        const itemName = it.name ?? ''
        if (!itemName || DOOR_NAME_ANY.test(itemName) || FRAME_NAME.test(itemName)) continue
        const scope = classifyItemScope(itemName, it.model ?? undefined)
        if (scope !== 'per_leaf') continue
        const bucket = perLeafRowsByName.get(itemName) ?? []
        bucket.push(it)
        perLeafRowsByName.set(itemName, bucket)
      }

      for (const [name, rows] of perLeafRowsByName.entries()) {
        const sides = new Set(rows.map(r => r.leaf_side ?? ''))
        const hasActive = sides.has('active')
        const hasInactive = sides.has('inactive')

        // If the item hasn't been explicitly split per-leaf (leaf_side null
        // or 'both'), render-time logic handles the per-leaf display — the
        // stored qty is the raw per-leaf value and the invariant doesn't
        // apply. Only flag when rows claim active+inactive but the sum is
        // outside the valid band.
        if (!(hasActive && hasInactive)) continue

        const perSideQtys = rows.map(r => r.qty ?? 0)
        const maxSideQty = Math.max(...perSideQtys)
        const totalQty = perSideQtys.reduce((s, q) => s + q, 0)
        const expectedMin = maxSideQty                         // hinge-split lower bound
        const expectedMax = maxSideQty * LEAF_COUNT_PAIR       // untouched upper bound

        if (totalQty < expectedMin || totalQty > expectedMax) {
          violations.push({
            rule: 'per_leaf_qty_sum_mismatch',
            opening_id: opening.id,
            door_number: opening.door_number,
            details: `Per-leaf item "${name}" on pair opening has qty-sum=${totalQty} outside expected band ${expectedMin}–${expectedMax} (leaf_count × raw per-leaf qty).`,
            severity: 'warning',
          })
        }
      }
    }

    // (i) leaf_count ↔ item leaf_side consistency (2026-04-18 Radius DC fix).
    //
    // If any hardware_item carries leaf_side='inactive', the opening is
    // unambiguously a pair and leaf_count must be >= 2. Only 'inactive' is
    // the trigger: buildPerOpeningItems stamps single-door bare "Door"
    // rows with leaf_side='active' (see parse-pdf-helpers.ts:2746), so
    // 'active' is not an unambiguous pair signal. An 'inactive' row is
    // only emitted from the pair branch, making it the correct canary.
    //
    // Enforced as a BLOCKER regardless of the general invariantGateEnabled()
    // flag; see save/route.ts for the enforce-always wiring with a
    // LEAF_COUNT_CONSISTENCY_ENFORCE=false kill switch.
    if (opening.leaf_count < LEAF_COUNT_PAIR) {
      const inactiveLeafItem = ois.find(i => i.leaf_side === 'inactive')
      if (inactiveLeafItem) {
        violations.push({
          rule: 'leaf_count_consistency',
          opening_id: opening.id,
          door_number: opening.door_number,
          details: `opening.leaf_count=${opening.leaf_count} but item "${inactiveLeafItem.name}" has leaf_side="inactive" (indicates pair). Backend pair detection is inconsistent.`,
          severity: 'blocker',
        })
      }
    }

    // (j) handing_consistency — on single-leaf openings, no item may carry
    //     a handing token (RHR/LHR/RHRA/LHRA/RH/LH) that contradicts
    //     opening.hand. The hardware-handing-filter runs pre-save to drop
    //     mismatches; this invariant backstops any that slip past (pair
    //     openings are skipped — pair-leaf handing is a separate axis,
    //     handled in the pair-leaf attribution workstream).
    if (opening.leaf_count === LEAF_COUNT_SINGLE) {
      const openingDir = inferHandingDirection(opening.hand)
      if (openingDir !== null) {
        for (const item of ois) {
          const itemName = item.name ?? ''
          const haystack = item.model ? `${itemName} ${item.model}` : itemName
          const itemDir = inferHandingDirection(haystack)
          if (itemDir !== null && itemDir !== openingDir) {
            violations.push({
              rule: 'handing_consistency',
              opening_id: opening.id,
              door_number: opening.door_number,
              details: `Item "${itemName}"${item.model ? ` (${item.model})` : ''} has handing ${itemDir} but opening.hand="${opening.hand}" (${openingDir}) on a single-leaf opening.`,
              severity: 'blocker',
            })
          }
        }
      }
    }

    // (k) pair_leaf_hinge_duplication — on pair openings, each (name,
    //     model) standard-hinge tuple must have at most one row per
    //     leaf_side. Fires when consolidatePairLeafHingeRows could not
    //     safely resolve a per-leaf duplicate (e.g. three+ rows, mismatched
    //     electric-hinge delta, or no electric hinge present) and the
    //     hinge-split branch emitted duplicates onto the same leaf.
    //     Warning severity per Matthew's 2026-04-18 decision "B":
    //     observability first, data-mutation second — the user sees the
    //     flag at save/promote time and can correct it upstream.
    if (opening.leaf_count === LEAF_COUNT_PAIR) {
      const hingeCounts = new Map<string, number>()
      for (const item of ois) {
        const itemName = item.name ?? ''
        if (!itemName || DOOR_NAME_ANY.test(itemName) || FRAME_NAME.test(itemName)) continue
        if (classifyItem(itemName, undefined, item.model ?? undefined) !== 'hinges') continue
        const side = item.leaf_side ?? 'unknown'
        const key = `${itemName.trim().toLowerCase()}::${(item.model ?? '').trim().toLowerCase()}::${side}`
        hingeCounts.set(key, (hingeCounts.get(key) ?? 0) + 1)
      }
      for (const [key, count] of hingeCounts.entries()) {
        if (count <= 1) continue
        const [name, model, side] = key.split('::')
        violations.push({
          rule: 'pair_leaf_hinge_duplication',
          opening_id: opening.id,
          door_number: opening.door_number,
          details: `Pair opening has ${count} standard-hinge rows on leaf_side="${side}" with the same (name="${name}", model="${model}"). Consolidation heuristic did not resolve — review upstream schedule.`,
          severity: 'warning',
        })
      }
    }
  }

  // (g) heading_doors[] → promoted hw_set match (requires hardwareSets)
  if (hardwareSets.length > 0) {
    const openingByDoor = new Map<string, OpeningRow>()
    for (const o of openings) openingByDoor.set(normalizeDoorNumber(o.door_number), o)

    for (const set of hardwareSets) {
      const specificId = set.set_id
      const genericId = set.generic_set_id ?? null
      // Only meaningful when a specific sub-set exists distinct from the
      // generic token. A run with only top-level sets can't misroute doors
      // between generic/specific.
      if (!genericId || genericId === specificId) continue
      for (const rawDoor of set.heading_doors ?? []) {
        const key = normalizeDoorNumber(rawDoor)
        const opening = openingByDoor.get(key)
        if (!opening) continue
        if (opening.hw_set === genericId && opening.hw_set !== specificId) {
          violations.push({
            rule: 'heading_door_set_mismatch',
            opening_id: opening.id,
            door_number: opening.door_number,
            details: `Door listed under set "${specificId}" heading_doors but promoted with hw_set="${genericId}" (generic token).`,
            severity: 'blocker',
          })
        }
      }
    }
  }

  return violations
}

/**
 * Minimal opening shape required for pre-stage invariant checks. Built by
 * the save route from its in-memory StagingOpening list, BEFORE the RPC
 * writes anything to staging. `leaf_count` is required (non-optional) here
 * because the field-level guard in writeStagingData() proves it is set
 * before any pre-stage call would run.
 */
export interface PreStageOpening {
  door_number: string
  hw_set: string | null
  location: string | null
  hand: string | null
  leaf_count: number
}

/**
 * In-memory pre-stage equivalent of validateExtractionRun.
 *
 * Runs the same `runInvariants` rule set against the wizard's in-memory
 * payload before writeStagingData() touches the DB. Synthesizes per-opening
 * items via the shared buildPerOpeningItems helper (using door_number as a
 * synthetic id since real staging IDs don't exist yet) so structural rules
 * see the same item shapes they would post-promote.
 *
 * The `leaf_count_consistency` rule is the highest-value one to catch here
 * — it fires when leaf_count and per-leaf hardware items disagree, which is
 * the exact signature of the 2026-04-18 Radius DC regression. Catching it
 * pre-stage means the save never commits the bad state.
 */
export function runPreStageInvariants(args: {
  openings: ReadonlyArray<PreStageOpening>
  hardwareSets: ReadonlyArray<HardwareSet>
  setMap: Map<string, HardwareSet>
  doorToSetMap: Map<string, HardwareSet>
  doorInfoMap: Map<string, { door_type: string; frame_type: string }>
}): InvariantViolation[] {
  const { openings, hardwareSets, setMap, doorToSetMap, doorInfoMap } = args

  // Synthesize OpeningRow[] — runInvariants only uses `id` for grouping.
  // Using door_number as the id is safe because writeStagingData's pre-stage
  // guard already rejected empty/duplicate door_numbers upstream.
  const openingRows = openings.map(o => ({
    id: o.door_number,
    door_number: o.door_number,
    hw_set: o.hw_set,
    leaf_count: o.leaf_count,
    location: o.location,
    hand: o.hand,
  }))

  // Reuse the post-stage item-building path so structural rules see the
  // same shapes they would post-promote. fkColumn='opening_id' matches the
  // HardwareItemRow.opening_id field that runInvariants reads.
  const builtItems = buildPerOpeningItems(
    openingRows.map(o => ({ id: o.id, door_number: o.door_number, hw_set: o.hw_set })),
    doorInfoMap,
    setMap,
    doorToSetMap,
    'opening_id',
  )

  const itemRows = builtItems.map((row, idx) => ({
    id: `prestage-${idx}`,
    opening_id: typeof row.opening_id === 'string' ? row.opening_id : '',
    name: typeof row.name === 'string' ? row.name : '',
    qty: typeof row.qty === 'number' ? row.qty : null,
    leaf_side: typeof row.leaf_side === 'string' ? row.leaf_side : null,
    model: typeof row.model === 'string' ? row.model : null,
  }))

  return runInvariants(openingRows, itemRows, hardwareSets)
}

/**
 * Human-readable one-line summary for logging and CLI output. Stable across
 * runs so log-greppers and tests can assert on it.
 */
export function summarizeReport(report: InvariantReport): string {
  const parts = [
    `run=${report.runId}`,
    `openings=${report.checkedOpenings}`,
    `items=${report.checkedItems}`,
    `blockers=${report.blockers}`,
    `warnings=${report.warnings}`,
  ]
  if (report.skippedRules.length > 0) parts.push(`skipped=${report.skippedRules.join(',')}`)
  return parts.join(' ')
}
