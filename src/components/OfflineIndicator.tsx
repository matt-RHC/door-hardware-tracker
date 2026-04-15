"use client";

import { useState, useEffect } from "react";
import { useOfflineQueue } from "@/hooks/useOfflineQueue";

export default function OfflineIndicator() {
  const [isOnline, setIsOnline] = useState(true);
  const { syncState, pendingCount, manualSync } = useOfflineQueue();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync initial state from browser API on mount
    setIsOnline(navigator.onLine);

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Nothing to show: online with no pending items and not syncing/error
  if (isOnline && pendingCount === 0 && syncState === "idle") return null;

  // Offline or pending state
  return (
    <div
      className={`fixed top-0 left-0 right-0 px-4 py-3 text-center text-sm font-medium z-50 flex items-center justify-center gap-3 ${
        !isOnline
          ? "bg-warning-dim border border-warning text-warning"
          : syncState === "error"
            ? "bg-red-900/20 border border-red-500 text-red-400"
            : syncState === "syncing"
              ? "bg-blue-900/20 border border-blue-500 text-blue-400"
              : "bg-yellow-900/20 border border-yellow-500 text-yellow-400"
      }`}
    >
      {!isOnline ? (
        <span>
          You&apos;re offline.
          {pendingCount > 0 && ` ${pendingCount} change${pendingCount === 1 ? "" : "s"} saved locally.`}
          {" "}Changes will sync when connected.
        </span>
      ) : syncState === "syncing" ? (
        <>
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>Syncing {pendingCount} change{pendingCount === 1 ? "" : "s"}...</span>
        </>
      ) : syncState === "error" ? (
        <>
          <span>Sync error. {pendingCount} change{pendingCount === 1 ? "" : "s"} pending.</span>
          <button
            onClick={manualSync}
            className="underline hover:no-underline text-red-300"
          >
            Retry
          </button>
        </>
      ) : (
        <>
          <span>{pendingCount} change{pendingCount === 1 ? "" : "s"} pending.</span>
          <button
            onClick={manualSync}
            className="underline hover:no-underline"
          >
            Sync now
          </button>
        </>
      )}
    </div>
  );
}
