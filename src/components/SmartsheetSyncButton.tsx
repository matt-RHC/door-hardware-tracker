"use client";

import { useState } from "react";

interface SyncResult {
  success: boolean;
  message: string;
  permalink?: string;
  created?: boolean;
  rowsSynced?: number;
  rowsAdded?: number;
  rowsUpdated?: number;
  rowsDeleted?: number;
}

export default function SmartsheetSyncButton({
  projectId,
  lastSynced,
  sheetId,
}: {
  projectId: string;
  lastSynced?: string | null;
  sheetId?: number | null;
}) {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);

  const syncToSmartsheet = async () => {
    setSyncing(true);
    setResult(null);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/sync-smartsheet`,
        { method: "POST" }
      );
      const data = await response.json();
      if (!response.ok) {
        setResult({ success: false, message: data.error || "Sync failed" });
      } else {
        const verb = data.created ? "Created" : "Updated";
        setResult({
          success: true,
          message: `${verb} sheet \u2014 ${data.rowsSynced} openings synced`,
          permalink: data.permalink,
          ...data,
        });
      }
    } catch (err) {
      setResult({
        success: false,
        message: err instanceof Error ? err.message : "Sync failed",
      });
    } finally {
      setSyncing(false);
    }
  };

  const sheetUrl = sheetId
    ? `https://app.smartsheet.com/sheets/${sheetId}`
    : result?.permalink;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          onClick={syncToSmartsheet}
          disabled={syncing}
          className={`interactive-el px-4 py-2 rounded-lg text-sm flex items-center gap-2 ${
            syncing
              ? "bg-success-dim text-success cursor-wait"
              : "bg-success hover:bg-success/80 text-white"
          }`}
        >
          {syncing ? (
            <>
              <svg
                className="animate-spin h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              Syncing...
            </>
          ) : (
            <>
              <svg
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              Sync to Smartsheet
            </>
          )}
        </button>

        {sheetUrl && (
          <a
            href={sheetUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-success hover:text-success/80 text-xs underline"
          >
            Open in Smartsheet
          </a>
        )}

        {lastSynced && (
          <span className="text-xs text-tertiary">
            Last synced:{" "}
            {new Date(lastSynced).toLocaleString()}
          </span>
        )}
      </div>

      {result && (
        <div
          className={`p-3 rounded-lg flex items-center justify-between text-sm ${
            result.success
              ? "bg-success-dim border border-success text-success"
              : "bg-danger-dim border border-danger text-danger"
          }`}
        >
          <span>{result.message}</span>
          <button
            onClick={() => setResult(null)}
            className="text-tertiary hover:text-primary ml-3"
          >
            &times;
          </button>
        </div>
      )}
    </div>
  );
}
