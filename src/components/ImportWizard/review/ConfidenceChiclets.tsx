"use client";

import type { DoorEntry } from "../types";
import { scoreToLevel } from "@/lib/confidence";

// Abbreviated field labels — mono, uppercase. Order matches the reading
// order a reviewer walks a door schedule: identity → geometry → rating →
// finish → accessories → pair hardware. Fields not in this map are
// skipped; field_confidence keys the extractor doesn't recognize won't
// leak into the UI until we add an entry here on purpose.
const FIELD_LABELS: Record<string, string> = {
  hw_set: "HW",
  hw_heading: "HDG",
  door_type: "TYP",
  frame_type: "FRM",
  hand: "HND",
  fire_rating: "FR",
  location: "LOC",
  finish: "FIN",
  electrified: "ELE",
  lc_nomen: "LC",
  rod_len: "ROD",
  function_type: "FN",
  double_egress: "DE",
};

const FIELD_ORDER = Object.keys(FIELD_LABELS);

interface ConfidenceChicletsProps {
  door: DoorEntry;
  /** Cap visible chiclets; overflow becomes a "+N" counter.
   *  Default 6 keeps the row height constant on common widths. */
  max?: number;
}

/**
 * Per-field confidence strip for a door row. Reads
 * `door.field_confidence` (populated during extraction) and renders
 * one color-tiered mono chiclet per known field. Returns `null` when
 * there's nothing to show so the row doesn't gain empty whitespace.
 *
 * Styling lives in globals.css (`.chiclet`, `.chiclet--high/med/low`)
 * — the component only picks the level and label, keeping color logic
 * in the token layer where the rest of the review UI finds it.
 */
export default function ConfidenceChiclets({
  door,
  max = 6,
}: ConfidenceChicletsProps) {
  const scores = door.field_confidence;
  if (!scores) return null;

  const entries = FIELD_ORDER.flatMap((field) => {
    const score = scores[field];
    if (typeof score !== "number") return [];
    const level = scoreToLevel(score);
    // Hide `high` fields — absence is the "clean" signal, matching the
    // existing ConfidenceBadge `dot` convention. Reviewers should see
    // only the fields that actually need a look.
    if (level === "high" || level === "unverified") return [];
    return [{ field, score, level }];
  });

  if (entries.length === 0) return null;

  const visible = entries.slice(0, max);
  const overflow = entries.length - visible.length;

  return (
    <span
      className="inline-flex items-center gap-1 shrink-0"
      aria-label={`${entries.length} field${entries.length === 1 ? "" : "s"} flagged`}
    >
      {visible.map(({ field, score, level }) => {
        const label = FIELD_LABELS[field] ?? field.slice(0, 3).toUpperCase();
        const pct = Math.round(score * 100);
        return (
          <span
            key={field}
            className={`chiclet chiclet--${level === "medium" ? "med" : level}`}
            title={`${field.replace(/_/g, " ")} · parser confidence ${pct}%`}
          >
            {label}
          </span>
        );
      })}
      {overflow > 0 && (
        <span
          className="chiclet chiclet--med"
          title={`${overflow} more field${overflow === 1 ? "" : "s"} flagged`}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}
