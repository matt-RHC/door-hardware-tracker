"use client";

/**
 * WizardNav — Shared sticky navigation bar for all wizard steps.
 *
 * Renders Back + Next/Continue buttons in a sticky bottom bar with a
 * gradient fade so content scrolls cleanly underneath. Consistent sizing,
 * touch targets (min-h-11 = 44px), and styling across every step.
 */

interface WizardNavProps {
  onBack?: () => void;
  onNext: () => void;
  nextLabel?: string;
  backLabel?: string;
  nextDisabled?: boolean;
  /** "accent" = blue primary action, "success" = green save action */
  nextVariant?: "accent" | "success";
  /** Optional secondary action button (e.g., "Remap Columns") on left side */
  secondaryAction?: {
    label: string;
    onClick: () => void;
    variant?: "warning" | "ghost";
  };
}

export default function WizardNav({
  onBack,
  onNext,
  nextLabel = "Continue",
  backLabel = "Back",
  nextDisabled = false,
  nextVariant = "accent",
  secondaryAction,
}: WizardNavProps) {
  const nextColors =
    nextVariant === "success"
      ? "bg-success hover:bg-success/80 text-white"
      : "bg-accent hover:bg-accent/80 text-white";

  return (
    <div className="sticky bottom-0 z-10 mt-auto -mx-6 px-6 pt-6 pb-2 bg-gradient-to-t from-[var(--bg-base)] via-[var(--bg-base)]/95 to-transparent pointer-events-none">
      <div className="flex items-center justify-between pointer-events-auto">
        {/* Left side: Back + optional secondary */}
        <div className="flex items-center gap-2">
          {onBack ? (
            <button
              onClick={onBack}
              className="min-h-11 px-5 py-2.5 border border-border-dim text-secondary hover:text-primary hover:border-accent/50 rounded-lg transition-colors text-sm font-medium"
            >
              &larr; {backLabel}
            </button>
          ) : (
            <div />
          )}
          {secondaryAction && (
            <button
              onClick={secondaryAction.onClick}
              className={`min-h-11 px-4 py-2.5 rounded-lg transition-colors text-sm font-medium ${
                secondaryAction.variant === "warning"
                  ? "bg-warning-dim border border-warning hover:bg-warning-dim/80 text-warning"
                  : "bg-tint-strong border border-border-dim-strong hover:bg-surface-hover text-primary"
              }`}
            >
              {secondaryAction.label}
            </button>
          )}
        </div>

        {/* Right side: Next/Continue */}
        <button
          onClick={onNext}
          disabled={nextDisabled}
          className={`min-h-11 px-8 py-2.5 rounded-lg transition-colors font-semibold text-sm disabled:opacity-50 disabled:cursor-not-allowed ${nextColors}`}
        >
          {nextLabel} &rarr;
        </button>
      </div>
    </div>
  );
}
