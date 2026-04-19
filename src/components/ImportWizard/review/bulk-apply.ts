import type { DoorEntry } from "../types";

// Pure helper used by BulkFixModal (Issue view → "Fix all N" flow) to
// apply one value across a list of openings in a single pass.
//
// Separate from rescan-apply.ts because that file is constrained to
// the `RegionExtractField` enum — the narrow set of fields the OCR
// region-extract API is allowed to touch. Bulk fix from Issue view
// has a wider scope: the reviewer may be clearing a `missing_door_type`
// or `missing_frame_type` cluster that the OCR rescan path never
// surfaces. Rather than widening RegionExtractField (and the API
// schema behind it), we introduce a dedicated bulk-write contract.
//
// Safety: we explicitly list writable fields rather than accepting an
// arbitrary key. `door_number`, `hw_set`, `hw_heading` are excluded:
// * `door_number` is the primary key across the wizard's maps
// * `hw_set` is the door-to-set lookup key — bulk rewrites would
//   break doorToSetMap and cascade through SetView
// * `hw_heading` is derived from the set's heading and isn't
//   meaningful at the opening level

export type BulkFixField =
  | "location"
  | "hand"
  | "fire_rating"
  | "door_type"
  | "frame_type";

export const BULK_FIX_FIELDS: readonly BulkFixField[] = [
  "location",
  "hand",
  "fire_rating",
  "door_type",
  "frame_type",
];

export function isBulkFixField(field: string): field is BulkFixField {
  return (BULK_FIX_FIELDS as readonly string[]).includes(field);
}

/**
 * Mirrors rescan-apply.ts — manual confirmation through the fix modal
 * asserts ground truth, so field_confidence for the written field is
 * bumped to 1.0. Without this, a low-confidence flag would survive a
 * manual set and keep the door visible in Issue view. See utils.ts's
 * `getDoorIssues` for the consumer that reads this threshold.
 */
const MANUAL_APPLY_CONFIDENCE = 1.0;

/**
 * Apply `value` to `field` on every door whose `door_number` is in
 * `targetDoorNumbers`. Pure — inputs are not mutated. Returns the
 * original array reference when nothing changed so React can skip a
 * re-render cycle.
 */
export function bulkApplyField(
  doors: DoorEntry[],
  field: BulkFixField,
  value: string,
  targetDoorNumbers: string[],
): DoorEntry[] {
  if (targetDoorNumbers.length === 0) return doors;
  const targets = new Set(targetDoorNumbers);
  let changed = false;
  const next = doors.map((d) => {
    if (!targets.has(d.door_number)) return d;
    const currentValue = d[field] ?? "";
    const currentConfidence = d.field_confidence?.[field];
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
