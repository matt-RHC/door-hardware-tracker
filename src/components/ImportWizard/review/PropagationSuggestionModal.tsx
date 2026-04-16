"use client";

import { useMemo, useState } from "react";
import type { PropagationSuggestion, RescanFieldType } from "@/lib/types";
import DarrinMessage from "../DarrinMessage";

interface PropagationSuggestionModalProps {
  /**
   * Propagation rows. Each row carries its own `field` so the modal
   * can display mixed suggestions (e.g. tier-1 batch with
   * location + hand + fire_rating for the same door). The caller does
   * NOT need to pass a single dominant field.
   */
  suggestions: PropagationSuggestion[];
  onAccept: (accepted: PropagationSuggestion[]) => void;
  onCancel: () => void;
}

const FIELD_LABELS: Record<RescanFieldType, string> = {
  location: "location",
  hand: "hand",
  fire_rating: "fire rating",
  door_number: "door number",
  // `unknown` is never actually surfaced in a propagation suggestion
  // (the server only returns field-typed fills), but the row component
  // reads FIELD_LABELS[s.field] and s.field is the full RescanFieldType
  // union — so keep a user-friendly fallback for type completeness.
  unknown: "field",
};

/**
 * Darrin-styled modal that previews propagation suggestions after the user
 * applies a field value via rescan. Users tick which suggestions to accept,
 * then commit. Defaulting to all-checked because the user already confirmed
 * the first value and propagation is the whole point of this flow.
 *
 * Mood progression: the modal opens with the `concerned` avatar (we're
 * acknowledging the gap still exists on N more doors) and briefly flashes
 * `success` after the user confirms, before closing. The delay makes the
 * success state readable instead of flickering shut.
 */
const SUCCESS_FLASH_MS = 600;

/**
 * Key for the checkbox state. Using `doorNumber:field` rather than plain
 * doorNumber so the tier-1 batch path (which can produce location + hand
 * + fire_rating suggestions for the same door) lets the user accept /
 * reject each suggestion independently.
 */
function rowKey(s: PropagationSuggestion): string {
  return `${s.doorNumber}:${s.field}`;
}

export default function PropagationSuggestionModal({
  suggestions,
  onAccept,
  onCancel,
}: PropagationSuggestionModalProps) {
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(suggestions.map(rowKey)),
  );
  const [applying, setApplying] = useState(false);

  const accepted = useMemo(
    () => suggestions.filter((s) => checked.has(rowKey(s))),
    [suggestions, checked],
  );

  const toggle = (key: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleApply = () => {
    if (accepted.length === 0) return;
    setApplying(true);
    // Give the user a beat to register the success flash before state
    // flushes and the modal unmounts.
    window.setTimeout(() => onAccept(accepted), SUCCESS_FLASH_MS);
  };

  // Count unique doors rather than raw suggestion length — tier-1 batch
  // can produce up to 3 suggestions per door (location + hand + rating)
  // and saying "9 more doors" when we actually found 3 would mislead.
  const uniqueDoorCount = new Set(suggestions.map((s) => s.doorNumber)).size;
  const uniqueAcceptedCount = new Set(accepted.map((s) => s.doorNumber)).size;
  const openingBlurb = `I found values for ${uniqueDoorCount} more door${uniqueDoorCount !== 1 ? "s" : ""} in this set. Pick the ones that look right and I'll fill them in.`;
  const successBlurb = `Done — updating ${uniqueAcceptedCount} door${uniqueAcceptedCount !== 1 ? "s" : ""}.`;

  return (
    <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-surface border border-th-border rounded-md p-5 w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl space-y-4">
        <DarrinMessage
          avatar={applying ? "success" : "concerned"}
          message={applying ? successBlurb : openingBlurb}
        />

        <ul className="divide-y divide-border-dim border border-border-dim rounded bg-tint max-h-[60vh] overflow-y-auto">
          {suggestions.map((s) => {
            const key = rowKey(s);
            const isChecked = checked.has(key);
            return (
              <li key={key} className="p-2">
                <label className="flex items-start gap-2 cursor-pointer min-h-11">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggle(key)}
                    disabled={applying}
                    className="mt-1 w-4 h-4 accent-[var(--accent)] flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-sm text-accent">
                        {s.doorNumber}
                      </span>
                      <span className="text-[10px] uppercase tracking-wider text-tertiary">
                        {FIELD_LABELS[s.field]}
                      </span>
                      <span
                        className="text-sm text-primary truncate min-w-0"
                        title={s.value}
                      >
                        → {s.value}
                      </span>
                    </div>
                    <div className="text-[11px] text-tertiary truncate font-mono">
                      {s.sourceLine}
                    </div>
                  </div>
                </label>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border-dim">
          <button
            type="button"
            onClick={onCancel}
            disabled={applying}
            className="px-3 py-1.5 rounded-md bg-tint border border-border-dim text-secondary text-xs font-medium hover:bg-tint-strong min-h-11 disabled:opacity-50"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={accepted.length === 0 || applying}
            className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent/80 min-h-11 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {applying
              ? "Applying…"
              : `Apply ${accepted.length} fix${accepted.length !== 1 ? "es" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
