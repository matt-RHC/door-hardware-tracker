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
    if ((d[field] ?? "") === value) return d;
    changed = true;
    return { ...d, [field]: value };
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
    const updated: DoorEntry = { ...d };
    for (const [field, value] of hits) {
      if ((updated[field] ?? "") === value) continue;
      updated[field] = value;
      rowChanged = true;
    }
    if (!rowChanged) return d;
    changed = true;
    return updated;
  });
  return changed ? next : doors;
}
