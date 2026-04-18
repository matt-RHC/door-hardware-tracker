/**
 * Handing filter — drop hardware-group items whose inferred handing token
 * contradicts the opening's `hand`.
 *
 * Context: Python (`api/extract-tables.py`) reads hardware schedules that
 * often list BOTH right-hand and left-hand variants of the same item under
 * a single heading (for example an Exit Device model shown with its RHR
 * SKU and its LHR SKU). Every variant is emitted into `hwSet.items`, and
 * `buildPerOpeningItems` then writes all of them to every opening that uses
 * the set. On a single-leaf opening only one variant actually belongs — the
 * other is a ghost row that inflates material counts.
 *
 * This module runs AFTER `buildPerOpeningItems` at the save and jobs-run
 * call sites. It infers each item's handing direction from the name/model
 * string, compares against the opening's `hand`, and drops mismatches. The
 * drops are reported back so the caller can write an aggregate audit entry
 * into `activity_log`.
 *
 * Architectural note: the filter deliberately lives OUTSIDE
 * `buildPerOpeningItems`. PR #306 reverted a pattern of threading a pre-
 * computed `isPairByDoor` map through that helper because the extra source
 * of truth caused regressions. `extraction-invariants.ts` catches residual
 * mismatches post-save. Keeping the filter post-hoc preserves that split:
 * `buildPerOpeningItems` stays a pure per-opening expander, the filter
 * trims, and the invariant backstops.
 *
 * Scope: SINGLE-leaf openings only. Pair openings carry per-leaf handing
 * nuance that belongs to the pair-leaf attribution workstream.
 */

export type HandingDirection = 'RH' | 'LH'

/**
 * Single combined regex covering every recognized handing token. Alternation
 * order is longest-first so RHRA wins over RH at the same position. The
 * \b anchors keep it from matching inside unrelated letter runs (RHW,
 * LHD, etc.).
 */
const HANDING_TOKEN_RE = /\b(RHRA|LHRA|RHR|LHR|RH|LH)\b/i

/**
 * Infer a handing direction from a string. Returns 'RH' for RHR/RHRA/RH,
 * 'LH' for LHR/LHRA/LH, null if no token is found.
 *
 * The filter only cares about direction (RH vs LH). The reverse-variant
 * distinction (RHR vs RHRA — about which leaf is active on a pair) is a
 * separate axis handled in the pair-leaf attribution workstream.
 *
 * Leftmost-in-string match wins. A value like "LHR or RHR universal"
 * resolves to LH because LHR appears first. The observed ghosts arrive as
 * two distinct rows each with one token, so this rule is well-defined in
 * practice; compound rows are a deliberate out-of-scope edge case.
 */
export function inferHandingDirection(value: string | null | undefined): HandingDirection | null {
  if (!value) return null
  const match = HANDING_TOKEN_RE.exec(String(value))
  if (!match) return null
  const token = match[1].toUpperCase()
  return token.startsWith('R') ? 'RH' : 'LH'
}

/**
 * One dropped row with enough context to audit after the fact. The caller
 * aggregates these into a single `activity_log` entry per run rather than
 * one entry per drop.
 */
export interface HandingFilterDrop {
  /** Matches the fkColumn used when buildPerOpeningItems was called —
   *  opening_id for production writes, staging_opening_id for staging. */
  fkId: string
  doorNumber: string
  itemName: string
  itemModel: string | null
  itemHanding: HandingDirection
  openingHand: HandingDirection
}

export interface HandingFilterResult {
  kept: Array<Record<string, unknown>>
  dropped: HandingFilterDrop[]
  /** Single-leaf openings whose hand string yielded no recognizable token.
   *  Kept all items; count surfaced so the caller can breadcrumb. */
  openingsWithUnknownHand: number
  /** Pair openings skipped outright. Pair-handing filtering is out of scope
   *  here; counted for observability. */
  pairOpeningsSkipped: number
}

export interface OpeningHandRecord {
  /** opening_id or staging_opening_id depending on run phase. */
  id: string
  doorNumber: string
  hand: string | null
  /** 1 for single, 2 for pair. Null is treated as 1. */
  leafCount: number | null
}

/**
 * Filter items across all openings by opening hand. See rules below.
 *
 *   1. fkId not in `openings` → keep (cannot assert mismatch without the
 *      opening record).
 *   2. Opening is a pair (leaf_count >= 2) → keep (out of scope).
 *   3. Opening hand does not yield a direction → keep, increment
 *      `openingsWithUnknownHand`.
 *   4. Item's (name + " " + model) does not yield a direction → keep (item
 *      applies to any handing).
 *   5. Item direction matches opening direction → keep.
 *   6. Item direction contradicts opening direction → drop.
 */
export function filterAllItemsByOpeningHand(
  allItems: ReadonlyArray<Record<string, unknown>>,
  openings: ReadonlyArray<OpeningHandRecord>,
  fkColumn: 'opening_id' | 'staging_opening_id',
): HandingFilterResult {
  const openingById = new Map<string, OpeningHandRecord>()
  for (const o of openings) openingById.set(o.id, o)

  const kept: Array<Record<string, unknown>> = []
  const dropped: HandingFilterDrop[] = []
  const unknownHandOpenings = new Set<string>()
  const pairOpenings = new Set<string>()

  for (const row of allItems) {
    const fkValue = row[fkColumn]
    const fkId = typeof fkValue === 'string' ? fkValue : null
    const opening = fkId !== null ? openingById.get(fkId) ?? null : null

    if (!opening) {
      kept.push(row)
      continue
    }

    const leafCount = opening.leafCount ?? 1
    if (leafCount >= 2) {
      pairOpenings.add(opening.id)
      kept.push(row)
      continue
    }

    const openingDir = inferHandingDirection(opening.hand)
    if (openingDir === null) {
      unknownHandOpenings.add(opening.id)
      kept.push(row)
      continue
    }

    const itemName = typeof row['name'] === 'string' ? (row['name'] as string) : ''
    const itemModel = typeof row['model'] === 'string' ? (row['model'] as string) : null
    const haystack = itemModel ? `${itemName} ${itemModel}` : itemName
    const itemDir = inferHandingDirection(haystack)

    if (itemDir === null || itemDir === openingDir) {
      kept.push(row)
      continue
    }

    dropped.push({
      fkId: opening.id,
      doorNumber: opening.doorNumber,
      itemName,
      itemModel,
      itemHanding: itemDir,
      openingHand: openingDir,
    })
  }

  return {
    kept,
    dropped,
    openingsWithUnknownHand: unknownHandOpenings.size,
    pairOpeningsSkipped: pairOpenings.size,
  }
}
