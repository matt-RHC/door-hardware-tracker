/**
 * Confidence scoring for extracted door data.
 *
 * Rule-based composite score per field:
 *   parser_match        (0.40) — value exists and is non-empty
 *   cross_field_valid    (0.25) — value matches known patterns for that field
 *   known_format_bonus   (0.10) — PDF source type is a recognized format
 *   completeness         (0.25) — proportion of non-empty fields on this door
 *
 * Thresholds:
 *   >= 0.85  auto-approve
 *   <  0.60  flag for review
 */

import type { DoorEntry } from '@/components/ImportWizard/types'

// ── Weights ─────────────────────────────────────────────────────────

const W_PARSER_MATCH = 0.40
const W_CROSS_FIELD = 0.25
const W_KNOWN_FORMAT = 0.10
const W_COMPLETENESS = 0.25

// ── Known patterns per field ────────────────────────────────────────

const FIELD_PATTERNS: Record<string, RegExp> = {
  door_number: /^\d{2,4}[A-Za-z]?(-\d{1,3}[A-Za-z]?)?$/,
  hw_set: /^(DH|HW|HS|SET)\s?\d{1,4}[A-Za-z]?$/i,
  fire_rating: /^(20|45|60|90|180)\s*MIN(UTE)?S?$|^N\/?R$|^(1|1\.5|2|3)\s*HR$/i,
  hand: /^(LH|RH|LHR|RHR|LHRA|RHRA|N\/A)$/i,
  door_type: /^(WD|HM|AL|GL|FRP|PR|PAIR|SGL|DBL)$/i,
  frame_type: /^(WD|HM|AL|KD|WELD|DRYWALL)$/i,
}

const SCORED_FIELDS: (keyof DoorEntry)[] = [
  'door_number',
  'hw_set',
  'location',
  'door_type',
  'frame_type',
  'fire_rating',
  'hand',
]

// ── Helpers ─────────────────────────────────────────────────────────

function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  return true
}

function completenessRatio(door: DoorEntry): number {
  let filled = 0
  for (const f of SCORED_FIELDS) {
    if (isNonEmpty(door[f])) filled++
  }
  return SCORED_FIELDS.length > 0 ? filled / SCORED_FIELDS.length : 0
}

// ── Public API ──────────────────────────────────────────────────────

export interface ScoreContext {
  /** If true, PDF source is a known format (Comsense, S4H, etc.) */
  knownFormat?: boolean
  /** Pre-computed completeness ratio for the door (avoids recalc) */
  completeness?: number
}

/**
 * Score a single field on a door.
 * Returns a number 0-1 (composite of the four sub-scores).
 */
export function scoreField(
  fieldName: string,
  value: unknown,
  context: ScoreContext = {},
): number {
  const parserMatch = isNonEmpty(value) ? 1.0 : 0.0

  let crossField = 0.5 // neutral default for fields without a pattern
  const pattern = FIELD_PATTERNS[fieldName]
  if (pattern) {
    if (!isNonEmpty(value)) {
      crossField = 0.0
    } else {
      crossField = pattern.test(String(value).trim()) ? 1.0 : 0.3
    }
  }

  const knownFormat = context.knownFormat ? 1.0 : 0.0
  const completeness = context.completeness ?? 0.5

  return (
    W_PARSER_MATCH * parserMatch +
    W_CROSS_FIELD * crossField +
    W_KNOWN_FORMAT * knownFormat +
    W_COMPLETENESS * completeness
  )
}

/**
 * Score every field on a single door.
 * Returns a Record mapping field name to confidence (0-1).
 */
export function scoreDoor(
  door: DoorEntry,
  knownFormat = false,
): Record<string, number> {
  const completeness = completenessRatio(door)
  const ctx: ScoreContext = { knownFormat, completeness }
  const result: Record<string, number> = {}

  for (const f of SCORED_FIELDS) {
    result[f] = scoreField(f, door[f], ctx)
  }

  return result
}

/**
 * Batch-score an entire extraction.
 * Returns per-door confidence maps and an overall average.
 */
export function scoreExtraction(
  doors: DoorEntry[],
  knownFormat = false,
): {
  perDoor: Map<string, Record<string, number>>
  average: number
} {
  const perDoor = new Map<string, Record<string, number>>()
  let totalScore = 0
  let totalFields = 0

  for (const door of doors) {
    const scores = scoreDoor(door, knownFormat)
    perDoor.set(door.door_number, scores)

    for (const s of Object.values(scores)) {
      totalScore += s
      totalFields++
    }
  }

  return {
    perDoor,
    average: totalFields > 0 ? totalScore / totalFields : 0,
  }
}
