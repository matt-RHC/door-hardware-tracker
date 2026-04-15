"use client";

import type { OpeningBlocked } from "@/lib/types/database";

export default function BlockedBadge({
  blocks,
}: {
  blocks: OpeningBlocked[];
}) {
  if (blocks.length === 0) return null;

  const label =
    blocks.length === 1
      ? `BLOCKED \u2014 ${blocks[0].blocked_item_name} ${blocks[0].block_reason}`
      : `BLOCKED \u2014 ${blocks.length} items`;

  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-danger-dim text-danger border-danger"
      title={blocks
        .map(
          (b) =>
            `${b.blocked_item_name}: ${b.block_reason}${b.estimated_arrival ? ` (ETA ${b.estimated_arrival})` : ""}`
        )
        .join("\n")}
    >
      <svg
        className="w-3 h-3 shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
      {label}
    </span>
  );
}
