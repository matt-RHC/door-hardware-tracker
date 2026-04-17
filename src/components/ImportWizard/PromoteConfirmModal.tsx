"use client";

interface PromoteConfirmModalProps {
  isOpen: boolean;
  /** Number of openings that will be promoted. Surfaces in the body copy
   *  so users have a concrete number in front of them before confirming. */
  openingCount: number;
  /** True while the POST is in flight; disables Cancel and swaps the
   *  Confirm button to its loading appearance. */
  isPromoting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Promote-to-production confirmation gate. Staging → production is a
 * one-way action (production tables are written via server RPC, not
 * revertible from the UI), so we interpose one deliberate pause before
 * firing the save. Styled to match PropagationSuggestionModal so wizard
 * users see a consistent modal chrome across both confirm flows.
 */
export default function PromoteConfirmModal({
  isOpen,
  openingCount,
  isPromoting,
  onConfirm,
  onCancel,
}: PromoteConfirmModalProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="promote-confirm-title"
    >
      <div className="bg-surface border border-th-border rounded-md p-5 w-full max-w-md shadow-2xl space-y-4">
        <div>
          <h3
            id="promote-confirm-title"
            className="text-base font-semibold text-primary"
          >
            Promote to production?
          </h3>
          <p className="mt-2 text-sm text-secondary">
            <span className="tabular-nums font-semibold text-primary">
              {openingCount}
            </span>{" "}
            opening{openingCount !== 1 ? "s" : ""} will be written to the
            project. This finalizes the import and cannot be undone from the
            wizard.
          </p>
        </div>

        <div className="flex items-center justify-end gap-3 pt-2 border-t border-border-dim">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPromoting}
            className="min-h-11 px-4 py-2 rounded-md bg-tint border border-border-dim-strong text-secondary text-sm font-medium hover:bg-tint-strong disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPromoting}
            className="min-h-11 px-5 py-2 rounded-md bg-success text-white text-sm font-semibold hover:bg-success/80 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {isPromoting && (
              <span
                className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin shrink-0"
                aria-hidden="true"
              />
            )}
            {isPromoting ? "Promoting…" : "Promote"}
          </button>
        </div>
      </div>
    </div>
  );
}
