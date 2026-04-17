"use client";

import type { ConfidenceLevel } from "@/lib/types/confidence";
import { getConfidenceStyle } from "@/lib/confidence";

interface ConfidenceBadgeProps {
  level: ConfidenceLevel;
  tooltip?: string;
  /** `dot` (default) is the quiet per-field indicator used inline next to
   *  extracted values on HardwareItemRow — `high` returns null so clean
   *  fields stay visually clean. `pill` is the row-level aggregate used at
   *  the end of DoorRow: it shows for every level (including `high`) with
   *  a leading icon and label, because the row-level confidence IS the
   *  hierarchy signal. */
  variant?: "dot" | "pill";
  size?: "sm" | "md";
}

/**
 * Confidence indicator. Two variants share the same semantic-token mapping
 * (via getConfidenceStyle) so we never duplicate the level → color logic.
 */
export default function ConfidenceBadge({
  level,
  tooltip,
  variant = "dot",
  size = "sm",
}: ConfidenceBadgeProps) {
  const style = getConfidenceStyle(level);

  if (variant === "pill") {
    const Icon = style.Icon;
    return (
      <span
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium shrink-0 ${style.pillClass}`}
        title={tooltip ?? style.label}
        aria-label={`${style.label}${tooltip ? ` — ${tooltip}` : ""}`}
      >
        <Icon className="h-3 w-3 shrink-0" />
        <span>{style.label}</span>
      </span>
    );
  }

  // dot variant: `high` is deliberately hidden — the absence of a dot IS
  // the signal that the field is clean. This is the existing convention
  // across per-field indicators (HardwareItemRow) and must not change.
  if (level === "high") return null;

  const px = size === "sm" ? "w-1.5 h-1.5" : "w-2 h-2";

  return (
    <span className="relative group inline-flex items-center ml-1 shrink-0">
      <span
        className={`${px} rounded-full ${style.dotClass} inline-block`}
        aria-label={`${level} confidence`}
      />
      {tooltip && (
        <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 rounded bg-surface-raised border border-border-dim text-[10px] text-secondary whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-20 shadow-lg">
          {tooltip}
        </span>
      )}
    </span>
  );
}
