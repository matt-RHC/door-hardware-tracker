import type { SVGProps } from "react";

// Inline SVG icons for confidence pills. `currentColor` lets the pill's
// text color drive the stroke, so a `text-success` parent paints the icon
// green without a separate color prop. Default size `h-4 w-4` matches
// `text-sm` line-height; parents using `text-xs` should override to
// `h-3 w-3` and `text-base` to `h-5 w-5`.

interface IconProps extends SVGProps<SVGSVGElement> {
  className?: string;
}

const BASE_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
};

export function CheckCircleIcon({ className = "h-4 w-4 shrink-0", ...rest }: IconProps) {
  return (
    <svg {...BASE_PROPS} {...rest} className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12.5 11 15.5 16 9.5" />
    </svg>
  );
}

export function AlertCircleIcon({ className = "h-4 w-4 shrink-0", ...rest }: IconProps) {
  return (
    <svg {...BASE_PROPS} {...rest} className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v5" />
      <path d="M12 16.25v.25" />
    </svg>
  );
}

export function XCircleIcon({ className = "h-4 w-4 shrink-0", ...rest }: IconProps) {
  return (
    <svg {...BASE_PROPS} {...rest} className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M9 9 15 15" />
      <path d="M15 9 9 15" />
    </svg>
  );
}

export function HelpCircleIcon({ className = "h-4 w-4 shrink-0", ...rest }: IconProps) {
  return (
    <svg {...BASE_PROPS} {...rest} className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.9.4-1.5 1-1.5 2.2" />
      <path d="M12 17.25v.25" />
    </svg>
  );
}
