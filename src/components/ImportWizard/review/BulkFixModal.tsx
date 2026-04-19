"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { IssueGroup } from "./issueGrouping";
import type { BulkFixField } from "./bulk-apply";

interface BulkFixModalProps {
  /** Cluster to fix. When null the modal is closed. */
  cluster: IssueGroup | null;
  /** Writable target field. Null when the cluster's field isn't
   *  bulk-writable (caller should guard the "Fix all" button before
   *  opening the modal, but we re-check here as a belt-and-braces). */
  field: BulkFixField | null;
  onApply: (field: BulkFixField, value: string, doorNumbers: string[]) => void;
  onClose: () => void;
}

// Field-specific placeholders + example values for the quick-fill chips.
// Copy kept short — the modal's job is to unblock, not to teach the
// schedule taxonomy. More complex validation lives in the per-door
// editor, not here.
const FIELD_COPY: Record<
  BulkFixField,
  { label: string; placeholder: string; chips: string[] }
> = {
  location: {
    label: "Location",
    placeholder: "e.g. Corridor 1202 from POE 1308",
    chips: [],
  },
  hand: {
    label: "Hand",
    placeholder: "LH · LHR · RH · RHR · RHRA · DELHR",
    chips: ["LH", "LHR", "RH", "RHR", "RHRA", "DELHR"],
  },
  fire_rating: {
    label: "Fire rating",
    placeholder: "e.g. 45Min, 90Min, N/A",
    chips: ["20Min", "45Min", "60Min", "90Min", "180Min", "N/A"],
  },
  door_type: {
    label: "Door type",
    placeholder: "e.g. A, B, HM-80",
    chips: [],
  },
  frame_type: {
    label: "Frame type",
    placeholder: "HM · AL · WD",
    chips: ["HM", "AL", "WD"],
  },
};

/**
 * Bulk-fix modal shown from an Issue-view cluster's "Fix all N"
 * button. Collects one value, applies it to every checked opening,
 * closes.
 *
 * Interactions mirror the attention-first handoff spec:
 *   - Esc closes
 *   - Enter in the input applies (if a value is typed)
 *   - Per-opening checkboxes let the reviewer exclude individual doors
 *   - "Mark N/A" writes the literal string "N/A" to every checked door
 *
 * Focus lands on the input when the modal opens so a quick typer can
 * hit the value + Enter without touching the mouse.
 */
export default function BulkFixModal({
  cluster,
  field,
  onApply,
  onClose,
}: BulkFixModalProps) {
  const [value, setValue] = useState("");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the input when the modal mounts. State (value / excluded)
  // is reset via React's key-based remount in the parent (IssueView
  // keys this component on cluster.issueKey) rather than a state-
  // resetting effect — avoids the "setState in effect" cascade the
  // lint rule flags and keeps each modal instance logically isolated.
  useEffect(() => {
    if (!cluster) return;
    // rAF defers focus until after layout so fast typers can hit
    // value + Enter without the browser eating the first keystroke.
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [cluster]);

  // Esc handler — registered on window so it fires even when focus
  // drifted to a checkbox (which is common once the user starts
  // excluding rows).
  useEffect(() => {
    if (!cluster) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cluster, onClose]);

  const selectedDoorNumbers = useMemo(() => {
    if (!cluster) return [];
    return cluster.doors
      .map(({ door }) => door.door_number)
      .filter((dn) => !excluded.has(dn));
  }, [cluster, excluded]);

  if (!cluster) return null;

  const copy = field ? FIELD_COPY[field] : null;
  const title = field
    ? `Set ${copy!.label.toLowerCase()} for ${selectedDoorNumbers.length} opening${selectedDoorNumbers.length === 1 ? "" : "s"}`
    : cluster.label;

  const canApply = field != null && value.trim().length > 0 && selectedDoorNumbers.length > 0;

  const toggleExcluded = (doorNumber: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(doorNumber)) next.delete(doorNumber);
      else next.add(doorNumber);
      return next;
    });
  };

  const handleApply = (submitValue: string) => {
    if (!field) return;
    const trimmed = submitValue.trim();
    if (!trimmed || selectedDoorNumbers.length === 0) return;
    onApply(field, trimmed, selectedDoorNumbers);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-fix-title"
      onMouseDown={(e) => {
        // Click on backdrop (not on the panel) closes — mouseDown so a
        // drag that ends on the backdrop (text selection in the modal)
        // doesn't accidentally dismiss.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="panel panel--modal animate-fade-in-up w-full max-w-xl p-0 overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-th-border">
          <div className="eyebrow mb-1">Fix for {selectedDoorNumbers.length} opening{selectedDoorNumbers.length === 1 ? "" : "s"}</div>
          <h3
            id="bulk-fix-title"
            className="text-base font-semibold text-primary"
          >
            {title}
          </h3>
        </div>

        {/* Affected openings — cluster doors with per-row checkboxes. */}
        <div className="px-5 py-3 border-b border-th-border max-h-[38vh] overflow-y-auto">
          <div className="eyebrow mb-2">Affected openings</div>
          <ul className="space-y-1">
            {cluster.doors.map(({ door }) => {
              const dn = door.door_number;
              const isExcluded = excluded.has(dn);
              return (
                <li key={dn} className="flex items-center gap-2 text-[12px]">
                  <input
                    type="checkbox"
                    checked={!isExcluded}
                    onChange={() => toggleExcluded(dn)}
                    className="shrink-0"
                    aria-label={`Include opening ${dn}`}
                  />
                  <span className="font-mono text-primary min-w-[4rem] shrink-0">
                    {dn || "—"}
                  </span>
                  <span className="font-mono text-secondary min-w-[5rem] shrink-0">
                    {door.hw_set || "—"}
                  </span>
                  <span className="text-tertiary truncate">
                    {door.location || "no location"}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Value input */}
        {field && copy ? (
          <div className="px-5 py-4 border-b border-th-border">
            <label
              htmlFor="bulk-fix-input"
              className="eyebrow mb-1 block"
            >
              Value ({copy.label})
            </label>
            <input
              ref={inputRef}
              id="bulk-fix-input"
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleApply(value);
                }
              }}
              placeholder={copy.placeholder}
              className="w-full px-3 py-2 rounded-md border border-th-border bg-surface text-primary font-mono text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              autoComplete="off"
            />
            {copy.chips.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {copy.chips.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => {
                      setValue(chip);
                      inputRef.current?.focus();
                    }}
                    className="chiclet chiclet--high hover:brightness-110 transition"
                  >
                    {chip}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="px-5 py-4 border-b border-th-border">
            <p className="text-[13px] text-tertiary">
              This cluster&rsquo;s field can&rsquo;t be bulk-applied. Open each
              opening individually to resolve.
            </p>
          </div>
        )}

        {/* Footer */}
        <div className="px-5 py-3 bg-surface-raised flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="glow-btn glow-btn--ghost text-[13px]"
            >
              Cancel
            </button>
            {field && (
              <button
                type="button"
                onClick={() => handleApply("N/A")}
                disabled={selectedDoorNumbers.length === 0}
                className="glow-btn glow-btn--ghost text-[13px] disabled:opacity-50 disabled:cursor-not-allowed"
                title={`Set ${copy!.label.toLowerCase()} to "N/A" on ${selectedDoorNumbers.length} opening(s)`}
              >
                Mark N/A
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={() => handleApply(value)}
            disabled={!canApply}
            className="glow-btn glow-btn--primary text-[13px] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Apply to {selectedDoorNumbers.length}
          </button>
        </div>
      </div>
    </div>
  );
}
