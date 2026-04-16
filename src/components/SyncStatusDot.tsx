"use client";

import { useSyncStatus } from "@/hooks/useSyncStatus";

interface SyncStatusDotProps {
  openingId: string;
  itemId: string;
  leafIndex: number;
}

export default function SyncStatusDot({
  itemId,
  leafIndex,
}: SyncStatusDotProps) {
  const { itemStatus } = useSyncStatus();
  const status = itemStatus(itemId, leafIndex);

  // Don't show anything for synced items — keep the UI clean
  if (status === "synced") return null;

  const color =
    status === "pending" ? "var(--orange)" : "var(--red)";
  const title =
    status === "pending" ? "Pending sync" : "Sync failed";

  return (
    <span
      className="inline-block w-2 h-2 rounded-full flex-shrink-0"
      style={{ background: color }}
      title={title}
    />
  );
}
