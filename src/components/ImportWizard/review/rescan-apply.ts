import type { DoorEntry } from "../types";
import type { RegionExtractField } from "@/lib/schemas/parse-pdf";
import type { PropagationSuggestion } from "@/lib/types";

/**
 * Pure helpers used by StepReview to apply rescan-derived field values to
 * the in-memory `doors` array. Extracted from the component so they can be
 * unit tested without rendering React.
 *
 * Design decision: we don't mutate inputs and we skip any write for
 * `door_number` — editing a door number via the rescan path would be
 * destructive (it's the primary key across the wizard's maps). The UI
 * already guards against offering door_number; this is a belt-and-braces
 * check so callers can trust the output.
 */

/**
 * PR-E: confidence bump applied on every manual field apply.
 *
 * getDoorIssues in utils.ts surfaces `low_confidence_{field}` whenever
 * door.field_confidence[field] < 0.6. If the user MANUALLY confirms a
 * value through the rescan flow, they are asserting ground truth — a
 * stale low-confidence score should not keep the door flagged for review.
 *
 * We set the confidence to 1.0 rather than deleting the key so downstream
 * code that assumes numeric scores (e.g. export pipelines that aggregate
 * averages) never sees an undefined. See utils.ts:20-27 for the consumer.
 *
 * If the caller passes a door with no prior field_confidence map, we
 * initialize a minimal one rather than creating a full map — we only
 * know the user affirmed THIS field; other fields stay unset.
 */
const MANUAL_APPLY_CONFIDENCE = 1.0;

export function applyFieldToDoors(
  doors: DoorEntry[],
  field: RegionExtractField,
  value: string,
  targetDoorNumbers: string[],
): DoorEntry[] {
  if (field === "door_number") return doors;
  if (targetDoorNumbers.length === 0) return doors;
  const targets = new Set(targetDoorNumbers);
  let changed = false;
  const next = doors.map((d) => {
    if (!targets.has(d.door_number)) return d;
    const currentValue = d[field] ?? "";
    const currentConfidence = d.field_confidence?.[field];
    // No-op guard: skip only when BOTH value and confidence would be
    // unchanged. Previously we short-circuited on value match alone,
    // so a user re-confirming the same (already-correct) value still
    // left the low-confidence flag in place — the exact bug the demo
    // video exposed on door 110-07B's hand field.
    if (
      currentValue === value &&
      currentConfidence === MANUAL_APPLY_CONFIDENCE
    ) {
      return d;
    }
    changed = true;
    const updatedConfidence: Record<string, number> = {
      ...(d.field_confidence ?? {}),
      [field]: MANUAL_APPLY_CONFIDENCE,
    };
    return { ...d, [field]: value, field_confidence: updatedConfidence };
  });
  return changed ? next : doors;
}

/**
 * Apply a list of propagation suggestions in a single pass.
 *
 * Supports MULTI-FIELD suggestions per door — the tier-1 "Fix missing
 * field" batch path can surface location + hand + fire_rating hits for
 * the same door in one modal, and all of them need to land. An earlier
 * revision collapsed this to one-per-door and silently dropped the rest.
 *
 * Suggestions for `door_number` (or any other non-propagatable field)
 * are silently ignored — `door_number` is the primary key across the
 * wizard's maps. If the same `(doorNumber, field)` pair appears twice,
 * the FIRST wins (deterministic, matches the order suggestions arrive).
 */
type PropagatableField = "location" | "hand" | "fire_rating"

function isPropagatableField(f: PropagationSuggestion["field"]): f is PropagatableField {
  return f === "location" || f === "hand" || f === "fire_rating"
}

export function applyPropagationSuggestions(
  doors: DoorEntry[],
  suggestions: PropagationSuggestion[],
): DoorEntry[] {
  if (suggestions.length === 0) return doors;
  // doorNumber → (field → value). Nested map so multiple fields per
  // door coexist. First suggestion for a given (door, field) wins.
  const byDoor = new Map<string, Map<PropagatableField, string>>()
  for (const s of suggestions) {
    if (!isPropagatableField(s.field)) continue
    let fields = byDoor.get(s.doorNumber)
    if (!fields) {
      fields = new Map<PropagatableField, string>()
      byDoor.set(s.doorNumber, fields)
    }
    if (!fields.has(s.field)) fields.set(s.field, s.value)
  }
  if (byDoor.size === 0) return doors;
  let changed = false;
  const next = doors.map((d) => {
    const hits = byDoor.get(d.door_number);
    if (!hits || hits.size === 0) return d;
    let rowChanged = false;
    // PR-E: propagation suggestions originate from the same user
    // gesture (accept in PropagationModal), so we treat them the same
    // as a manual apply — bump field_confidence so the review surface
    // stops flagging them. Accumulates a new confidence map because
    // multiple fields can update in one pass.
    const nextConfidence: Record<string, number> = { ...(d.field_confidence ?? {}) };
    const updated: DoorEntry = { ...d };
    for (const [field, value] of hits) {
      const currentValue = updated[field] ?? "";
      const currentConfidence = nextConfidence[field];
      if (
        currentValue === value &&
        currentConfidence === MANUAL_APPLY_CONFIDENCE
      ) {
        continue;
      }
      updated[field] = value;
      nextConfidence[field] = MANUAL_APPLY_CONFIDENCE;
      rowChanged = true;
    }
    if (!rowChanged) return d;
    changed = true;
    updated.field_confidence = nextConfidence;
    return updated;
  });
  return changed ? next : doors;
}
