"use client";

import { useMemo, useState } from "react";
import type { DoorEntry } from "../types";
import type { RegionExtractField } from "@/lib/schemas/parse-pdf";
import DarrinMessage, { DarrinAction } from "../DarrinMessage";
import { sanitizeFieldValue } from "./sanitizeFieldValue";

interface FieldAssignmentPanelProps {
  rawText: string;
  detectedField: RegionExtractField | "unknown";
  detectedValue: string;
  detectionConfidence: number;
  doorsInSet: DoorEntry[];
  triggerDoorNumber?: string;
  onConfirm: (
    field: RegionExtractField,
    value: string,
    doorNumbers: string[],
  ) => void;
  onCancel: () => void;
}

const FIELD_LABELS: Record<RegionExtractField, string> = {
  location: "Location",
  hand: "Hand",
  fire_rating: "Fire rating",
  door_number: "Door number",
};

const FIELD_OPTIONS: RegionExtractField[] = [
  "location",
  "hand",
  "fire_rating",
];

/**
 * Given the detected field + the full list of doors in the set, check which
 * of those doors currently have a missing / empty value for that field. These
 * are the doors we default-select for the user, since the whole point of this
 * flow is to fill in missing values.
 *
 * Rationale for defaulting rather than forcing: the detection is a heuristic
 * and the user may want to overwrite a wrong value. Pre-selecting empties
 * handles the 90% case; checkboxes let them expand.
 */
function doorsMissingField(doors: DoorEntry[], field: RegionExtractField): Set<string> {
  const result = new Set<string>();
  for (const d of doors) {
    if (field === "door_number") continue; // not applicable in this UI
    const current = (d[field] ?? "").trim();
    if (!current) result.add(d.door_number);
  }
  return result;
}

export default function FieldAssignmentPanel({
  rawText,
  detectedField,
  detectedValue,
  detectionConfidence,
  doorsInSet,
  triggerDoorNumber,
  onConfirm,
  onCancel,
}: FieldAssignmentPanelProps) {
  const initialField: RegionExtractField = useMemo(() => {
    if (
      detectedField === "location" ||
      detectedField === "hand" ||
      detectedField === "fire_rating"
    ) {
      return detectedField;
    }
    // Default to 'location' when we couldn't auto-detect — most common
    // reason a user uses this flow.
    return "location";
  }, [detectedField]);

  const [field, setField] = useState<RegionExtractField>(initialField);

  // PR-D: derive a sanitized value FOR THE CURRENT FIELD from the raw
  // region-extract text. Per-field because the same raw text ("R)\nROOM
  // 101") strips differently under "location" vs. "hand". When the user
  // retargets the field chip, this memo re-runs and the input reflects
  // the new sanitization for that field.
  const sanitizedFromRaw = useMemo(
    () => sanitizeFieldValue(field, detectedValue || rawText),
    [field, detectedValue, rawText],
  );

  // `userValue` is null until the user hand-edits the input; once they do,
  // their value takes precedence over the sanitized-from-raw derivation.
  // Switching fields resets userValue to null so the input always shows the
  // sanitized default for the newly selected field.
  const [userValue, setUserValue] = useState<string | null>(null);
  const value = userValue ?? sanitizedFromRaw;

  const handleFieldChange = (newField: RegionExtractField) => {
    setField(newField);
    setUserValue(null);
  };

  // Always include the trigger door, and pre-check any other door that's
  // missing this field. User can toggle freely.
  const initialSelection = useMemo(() => {
    const s = new Set<string>();
    if (triggerDoorNumber) s.add(triggerDoorNumber);
    for (const dn of doorsMissingField(doorsInSet, initialField)) s.add(dn);
    return s;
  }, [triggerDoorNumber, doorsInSet, initialField]);

  const [selectedDoors, setSelectedDoors] = useState<Set<string>>(initialSelection);

  const toggleDoor = (doorNumber: string) => {
    setSelectedDoors((prev) => {
      const next = new Set(prev);
      if (next.has(doorNumber)) next.delete(doorNumber);
      else next.add(doorNumber);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedDoors(new Set(doorsInSet.map((d) => d.door_number)));
  };
  const selectMissing = () => {
    const missing = doorsMissingField(doorsInSet, field);
    if (triggerDoorNumber) missing.add(triggerDoorNumber);
    setSelectedDoors(missing);
  };
  const clearSelection = () => setSelectedDoors(new Set());

  const handleConfirm = () => {
    // Defense-in-depth: sanitize once more on confirm. Idempotent, so
    // running it twice costs nothing, but it catches the case where a
    // user pasted noisy text into the input box (e.g. drag-copied from
    // the "Extracted text" preview) or typed their own leaf marker.
    const clean = sanitizeFieldValue(field, value);
    if (!clean) return;
    if (selectedDoors.size === 0) return;
    onConfirm(field, clean, Array.from(selectedDoors));
  };

  const detectionPct = Math.round(detectionConfidence * 100);
  // Mood map for the exception-handling frame:
  //   concerned — we couldn't tell (user has to decide).
  //   scanning  — low-confidence guess, checking our work.
  //   excited   — high-confidence match, ready to apply.
  const avatar =
    detectedField === "unknown"
      ? "concerned"
      : detectionConfidence < 0.7
        ? "scanning"
        : "excited";
  const detectionBlurb = detectedField === "unknown"
    ? "I couldn't tell what field this belongs to. Pick one below and I'll fill it in."
    : `Looks like a ${FIELD_LABELS[detectedField as RegionExtractField].toLowerCase()} (${detectionPct}% sure). Choose the doors to fix.`;

  return (
    <div className="space-y-4">
      <DarrinMessage avatar={avatar} message={detectionBlurb} />

      <div className="space-y-3">
        <div>
          <label className="block text-[11px] text-tertiary uppercase tracking-wider mb-1">
            Extracted text
          </label>
          <pre className="bg-tint border border-border-dim rounded p-2 text-xs text-secondary whitespace-pre-wrap max-h-32 overflow-auto font-mono">
            {rawText}
          </pre>
        </div>

        <div>
          <label className="block text-[11px] text-tertiary uppercase tracking-wider mb-1">
            Assign to field
          </label>
          <div className="flex items-center gap-2 flex-wrap">
            {FIELD_OPTIONS.map((f) => (
              <DarrinAction
                key={f}
                onClick={() => handleFieldChange(f)}
                selected={field === f}
              >
                {FIELD_LABELS[f]}
              </DarrinAction>
            ))}
          </div>
        </div>

        <div>
          <label
            htmlFor="rescan-field-value"
            className="block text-[11px] text-tertiary uppercase tracking-wider mb-1"
          >
            Value to apply
          </label>
          <input
            id="rescan-field-value"
            type="text"
            value={value}
            // Any edit flips userValue to a non-null string; the derived
            // value then reads from userValue instead of sanitizedFromRaw,
            // so retargeting the field no longer clobbers the user's input.
            onChange={(e) => setUserValue(e.target.value)}
            className="w-full bg-tint border border-border-dim rounded px-3 py-2 text-primary text-sm focus:border-accent focus:outline-none min-h-11"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-[11px] text-tertiary uppercase tracking-wider">
              Apply to doors ({selectedDoors.size}/{doorsInSet.length})
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={selectMissing}
                className="text-[11px] text-accent hover:underline"
              >
                Only missing
              </button>
              <button
                type="button"
                onClick={selectAll}
                className="text-[11px] text-accent hover:underline"
              >
                All
              </button>
              <button
                type="button"
                onClick={clearSelection}
                className="text-[11px] text-accent hover:underline"
              >
                None
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto border border-border-dim rounded p-2 bg-tint">
            {doorsInSet.length === 0 && (
              <span className="text-[11px] text-tertiary">
                No doors in this set.
              </span>
            )}
            {doorsInSet.map((d) => {
              const isSelected = selectedDoors.has(d.door_number);
              const currentValue =
                field !== "door_number" ? (d[field] ?? "").trim() : "";
              const hasValue = currentValue.length > 0;
              return (
                <button
                  key={d.door_number}
                  type="button"
                  onClick={() => toggleDoor(d.door_number)}
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] min-h-11 transition-colors ${
                    isSelected
                      ? "bg-accent-dim border-accent text-accent"
                      : "bg-surface border-border-dim text-secondary hover:border-accent/30"
                  }`}
                  title={hasValue ? `Currently: ${currentValue}` : "Currently empty"}
                >
                  <span className="font-mono">{d.door_number}</span>
                  {hasValue && (
                    // Cap the inline preview at ~22 chars so common
                    // location strings ("ROOM 101 TO CORRIDOR") aren't
                    // chopped mid-word. Full value is in the tooltip.
                    <span className="text-[10px] opacity-60 truncate max-w-[22ch]">
                      = {currentValue}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-border-dim">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 rounded-md bg-tint border border-border-dim text-secondary text-xs font-medium hover:bg-tint-strong min-h-11"
        >
          Back
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={!value.trim() || selectedDoors.size === 0}
          className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent/80 min-h-11 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Apply to {selectedDoors.size} door{selectedDoors.size !== 1 ? "s" : ""}
        </button>
      </div>
    </div>
  );
}
