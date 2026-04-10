"use client";

import PunchAvatar from "./PunchAvatar";
import type { PunchAvatarState } from "./PunchAvatar";

// ── Card Types ──

export type PunchCardType =
  | "summary"
  | "empty_sets"
  | "calibration"
  | "auto_correction"
  | "question"
  | "compliance"
  | "flag"
  | "info"
  | "ready";

export interface PunchCardAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary" | "success" | "danger" | "ghost";
  disabled?: boolean;
}

export interface PunchCardProps {
  /** Card type — controls avatar state and default styling. */
  type: PunchCardType;
  /** Title text shown next to the avatar. */
  title: string;
  /** Current card number (1-based). */
  current: number;
  /** Total number of cards. */
  total: number;
  /** Main content — rendered in the card body. */
  children: React.ReactNode;
  /** Optional PDF page preview — rendered below content. */
  pdfPreview?: React.ReactNode;
  /** Primary action (right-aligned). */
  primaryAction?: PunchCardAction;
  /** Secondary action (left-aligned). */
  secondaryAction?: PunchCardAction;
  /** If true, the card can't be skipped. */
  required?: boolean;
  /** Skip handler (only shown if not required). */
  onSkip?: () => void;
}

// ── Helpers ──

function avatarStateForType(type: PunchCardType): PunchAvatarState {
  switch (type) {
    case "compliance":
    case "empty_sets":
      return "error";
    case "flag":
      return "warning";
    case "auto_correction":
    case "ready":
    case "calibration":
      return "success";
    default:
      return "idle";
  }
}

function variantClasses(variant: PunchCardAction["variant"]): string {
  switch (variant) {
    case "success":
      return "bg-success hover:bg-success/80 text-white";
    case "danger":
      return "bg-danger hover:bg-danger/80 text-white";
    case "ghost":
      return "bg-tint border border-border-dim hover:bg-tint-strong text-secondary";
    case "secondary":
      return "bg-tint-strong border border-border-dim-strong hover:bg-surface-hover text-primary";
    case "primary":
    default:
      return "bg-accent hover:bg-accent/80 text-white";
  }
}

// ── Component ──

export default function PunchCard({
  type,
  title,
  current,
  total,
  children,
  pdfPreview,
  primaryAction,
  secondaryAction,
  required,
  onSkip,
}: PunchCardProps) {
  return (
    <div className="w-full max-w-2xl mx-auto animate-fade-in-up">
      {/* Header: avatar + title + progress */}
      <div className="flex items-center gap-3 mb-4">
        <PunchAvatar size="sm" state={avatarStateForType(type)} />
        <h4 className="text-primary font-semibold text-sm flex-1">{title}</h4>
        <span className="text-[10px] text-tertiary font-mono">
          {current}/{total}
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full h-1 bg-tint rounded-full mb-4 overflow-hidden">
        <div
          className="h-full bg-accent rounded-full transition-all duration-500 ease-out"
          style={{ width: `${(current / total) * 100}%` }}
        />
      </div>

      {/* Content area */}
      <div className="mb-4">
        {children}
      </div>

      {/* PDF Preview (optional) */}
      {pdfPreview && (
        <div className="mb-4">
          {pdfPreview}
        </div>
      )}

      {/* Actions — min-h-11 ensures 44px touch targets (WCAG) */}
      <div className="flex items-center justify-between pt-3">
        <div>
          {secondaryAction && (
            <button
              onClick={secondaryAction.onClick}
              disabled={secondaryAction.disabled}
              aria-label={secondaryAction.label}
              className={`px-4 py-2.5 min-h-11 rounded-lg transition-colors font-medium text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${variantClasses(secondaryAction.variant ?? "ghost")}`}
            >
              {secondaryAction.label}
            </button>
          )}
          {!required && !secondaryAction && onSkip && (
            <button
              onClick={onSkip}
              aria-label="Skip this card"
              className="px-4 py-2.5 min-h-11 rounded-lg transition-colors font-medium text-sm bg-tint border border-border-dim hover:bg-tint-strong text-tertiary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Skip
            </button>
          )}
        </div>
        {primaryAction && (
          <button
            onClick={primaryAction.onClick}
            disabled={primaryAction.disabled}
            aria-label={primaryAction.label}
            className={`px-6 py-2.5 min-h-11 rounded-lg transition-colors font-semibold text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${variantClasses(primaryAction.variant ?? "primary")}`}
          >
            {primaryAction.label}
          </button>
        )}
      </div>
    </div>
  );
}
