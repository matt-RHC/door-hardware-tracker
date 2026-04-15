"use client";

import { useConnectionStatus } from "@/hooks/useConnectionStatus";
import { useSyncStatus } from "@/hooks/useSyncStatus";

function formatRelativeTime(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function OfflineIndicator() {
  const { isOnline } = useConnectionStatus();
  const { pendingCount, lastSyncedAt } = useSyncStatus();

  // Online with nothing pending — hide completely
  if (isOnline && pendingCount === 0) return null;

  // Online with pending items — subtle amber bar
  if (isOnline && pendingCount > 0) {
    return (
      <div
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 px-4 py-1.5 text-xs font-medium"
        style={{
          background: "var(--orange-dim)",
          borderBottom: "1px solid var(--orange)",
          color: "var(--orange)",
        }}
      >
        <span>&#x27F3; {pendingCount} pending</span>
        {lastSyncedAt && (
          <span className="opacity-70">
            &middot; Last synced {formatRelativeTime(lastSyncedAt)}
          </span>
        )}
      </div>
    );
  }

  // Offline
  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 px-4 py-2 text-center text-sm font-medium"
      style={{
        background: "var(--orange-dim)",
        borderBottom: "1px solid var(--orange)",
        color: "var(--orange)",
      }}
    >
      <div>You&apos;re offline. Changes will sync when connected.</div>
      {pendingCount > 0 && (
        <div className="text-xs mt-0.5 opacity-80">
          {pendingCount} change{pendingCount !== 1 ? "s" : ""} pending
          {lastSyncedAt && (
            <> &middot; Last synced {formatRelativeTime(lastSyncedAt)}</>
          )}
        </div>
      )}
    </div>
  );
}
