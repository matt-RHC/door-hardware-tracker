"use client";

import type { ConfidenceLevel } from "@/lib/types/confidence";

interface ConfidenceBadgeProps {
  level: ConfidenceLevel;
  tooltip?: string;
  size?: "sm" | "md";
}

const DOT_COLORS: Record<ConfidenceLevel, string> = {
  high: "bg-success",
  medium: "bg-warning",
  low: "bg-danger",
  unverified: "bg-tertiary",
};

/**
 * Small inline confidence dot. High confidence is hidden by default
 * (clean UI when everything is fine). Medium/low/unverified show a
 * colored dot with an optional hover tooltip.
 */
export default function ConfidenceBadge({
  level,
  tooltip,
  size = "sm",
}: ConfidenceBadgeProps) {
  // High confidence = no indicator (clean by default)
  if (level === "high") return null;

  const px = size === "sm" ? "w-1.5 h-1.5" : "w-2 h-2";

  return (
    <span className="relative group inline-flex items-center ml-1 shrink-0">
      <span
        className={`${px} rounded-full ${DOT_COLORS[level]} inline-block`}
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
