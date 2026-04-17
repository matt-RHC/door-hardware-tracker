"use client";

import { useEffect, useRef } from "react";

interface PromoteConfirmModalProps {
  isOpen: boolean;
  /** Number of openings that will be promoted. Surfaces in the body copy
   *  so users have a concrete number in front of them before confirming. */
  openingCount: number;
  /** True while the POST is in flight; disables Cancel, Escape, and
   *  backdrop-click so users can't bail mid-write and lose context. */
  isPromoting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Promote-to-production confirmation gate. Staging → production is a
 * one-way action (production tables are written via server RPC, not
 * revertible from the UI), so we interpose one deliberate pause before
 * firing the save.
 *
 * Accessibility:
 *   - role=dialog + aria-modal + aria-labelledby
 *   - initial focus on Cancel (conservative — never default to the
 *     destructive action)
 *   - Escape closes (unless promoting, to avoid bailing mid-POST)
 *   - backdrop click closes (same guard)
 *   - Tab cycles between Cancel and Confirm so focus can't escape the
 *     dialog into the dimmed content behind it
 */
export default function PromoteConfirmModal({
  isOpen,
  openingCount,
  isPromoting,
  onConfirm,
  onCancel,
}: PromoteConfirmModalProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // Move focus to Cancel on open. Runs after the modal mounts so the
  // button is in the DOM.
  useEffect(() => {
    if (!isOpen) return;
    cancelRef.current?.focus();
  }, [isOpen]);

  // Escape → cancel, unless a write is in flight. Listens on `window` so
  // it catches the key regardless of where focus happens to be.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isPromoting) return;
      e.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, isPromoting, onCancel]);

  if (!isOpen) return null;

  // Two-button focus trap. Shift+Tab from Cancel wraps to Confirm;
  // Tab from Confirm wraps to Cancel. Keeps focus inside the dialog
  // without depending on an external focus-trap library.
  const handleTrap = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const active = document.activeElement;
    if (e.shiftKey && active === cancelRef.current) {
      e.preventDefault();
      confirmRef.current?.focus();
    } else if (!e.shiftKey && active === confirmRef.current) {
      e.preventDefault();
      cancelRef.current?.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="promote-confirm-title"
      aria-describedby="promote-confirm-body"
      onClick={(e) => {
        // Close only when the backdrop itself is the target — clicks
        // inside the panel bubble up but shouldn't dismiss.
        if (isPromoting) return;
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={handleTrap}
    >
      <div className="bg-surface border border-th-border rounded-md p-5 w-full max-w-md shadow-2xl space-y-4">
        <div>
          <h3
            id="promote-confirm-title"
            className="text-base font-semibold text-primary"
          >
            Promote to production?
          </h3>
          <p id="promote-confirm-body" className="mt-2 text-sm text-secondary">
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
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={isPromoting}
            className="min-h-11 px-4 py-2 rounded-md bg-tint border border-border-dim-strong text-secondary text-sm font-medium hover:bg-tint-strong disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={isPromoting}
            className="min-h-11 px-5 py-2 rounded-md bg-success text-white text-sm font-semibold hover:bg-success/80 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
