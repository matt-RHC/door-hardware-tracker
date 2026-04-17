import type { ComponentType, SVGProps } from "react";
import type { ConfidenceLevel } from "@/lib/types/confidence";
import {
  AlertCircleIcon,
  CheckCircleIcon,
  HelpCircleIcon,
  XCircleIcon,
} from "@/components/icons/ConfidenceIcons";

// Single source of truth for how a ConfidenceLevel maps to visuals.
// Three components (ConfidenceBadge, DoorRow, SetView) previously duplicated
// the level→color logic; consolidating here keeps the OSHA-aligned semantic
// tokens (success/warning/danger in globals.css @theme) the only place
// colors live. DO NOT inline raw `bg-green-*` / `bg-red-*` at call sites.

export interface ConfidenceStyle {
  /** Tailwind classes for a filled pill (bg + text). No border — the -dim
   *  backgrounds at 12% opacity already read as pills on surface-raised. */
  pillClass: string;
  /** Tailwind background class for a small colored dot. */
  dotClass: string;
  /** Tailwind text color class — use when the pill would be too heavy. */
  textClass: string;
  /** Leading icon for the pill. Inherits currentColor. */
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Domain-facing label. Rendered inside the pill and exposed to ARIA. */
  label: string;
}

const STYLES: Record<ConfidenceLevel, ConfidenceStyle> = {
  high: {
    pillClass: "bg-success-dim text-success",
    dotClass: "bg-success",
    textClass: "text-success",
    Icon: CheckCircleIcon,
    label: "Auto-approved",
  },
  medium: {
    pillClass: "bg-warning-dim text-warning",
    dotClass: "bg-warning",
    textClass: "text-warning",
    Icon: AlertCircleIcon,
    label: "Review suggested",
  },
  low: {
    pillClass: "bg-danger-dim text-danger",
    dotClass: "bg-danger",
    textClass: "text-danger",
    Icon: XCircleIcon,
    label: "Review required",
  },
  unverified: {
    pillClass: "bg-tint text-tertiary",
    dotClass: "bg-tertiary",
    textClass: "text-tertiary",
    Icon: HelpCircleIcon,
    label: "Unverified",
  },
};

export function getConfidenceStyle(level: ConfidenceLevel): ConfidenceStyle {
  return STYLES[level] ?? STYLES.unverified;
}
