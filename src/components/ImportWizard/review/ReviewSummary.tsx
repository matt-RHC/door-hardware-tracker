"use client";

import type { ReactNode } from "react";
import type { DoorEntry } from "../types";
import { ISSUE_LABELS } from "./types";
import DarrinMessage from "../DarrinMessage";

type ViewMode = 'door' | 'set';

interface ReviewSummaryProps {
  totalDoors: number;
  highCount: number;
  medCount: number;
  lowCount: number;
  hasExistingData: boolean;
  issueGroups: Map<string, string[]>;
  orphanDoors: DoorEntry[];
  orphanNoticeDismissed: boolean;
  onDismissOrphanNotice: () => void;
  /** Optional view-mode toggle. When provided, renders a door/set switch
   *  in the summary card header. */
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  /** Rendered inside the summary card (typically the ReviewFilters row). */
  children?: ReactNode;
}

/** Short Darrin recap line based on door counts. */
function darrinRecap(
  totalDoors: number,
  highCount: number,
  medCount: number,
  lowCount: number,
  orphanCount: number,
): string {
  if (totalDoors === 0) return "No doors to review yet.";
  const parts: string[] = [`${highCount} ready`];
  if (medCount > 0) parts.push(`${medCount} need a look`);
  if (lowCount > 0) parts.push(`${lowCount} missing data`);
  if (orphanCount > 0) parts.push(`${orphanCount} orphan${orphanCount !== 1 ? 's' : ''} excluded`);
  return parts.join(' · ');
}

export default function ReviewSummary({
  totalDoors,
  highCount,
  medCount,
  lowCount,
  hasExistingData,
  issueGroups,
  orphanDoors,
  orphanNoticeDismissed,
  onDismissOrphanNotice,
  viewMode,
  onViewModeChange,
  children,
}: ReviewSummaryProps) {
  const showToggle = viewMode !== undefined && onViewModeChange !== undefined;

  return (
    <>
      {/* ── Auto-removed orphan notice ── */}
      {orphanDoors.length > 0 && !orphanNoticeDismissed && (
        <div className="mb-3 p-3 bg-tint border border-border-dim rounded-md flex items-start gap-2">
          <span className="text-tertiary text-xs mt-0.5 shrink-0">&#9432;</span>
          <div className="flex-1 text-xs text-secondary">
            <span className="font-medium">{orphanDoors.length} incomplete door{orphanDoors.length !== 1 ? 's were' : ' was'} automatically excluded</span>
            <span className="text-tertiary ml-1">
              ({orphanDoors.slice(0, 8).map(d => d.door_number).join(', ')}{orphanDoors.length > 8 ? `, +${orphanDoors.length - 8} more` : ''})
            </span>
            <span className="text-tertiary ml-1">
              — no hardware set or items found
            </span>
          </div>
          <button
            onClick={onDismissOrphanNotice}
            className="text-tertiary hover:text-secondary text-xs shrink-0 ml-2"
            aria-label="Dismiss"
          >
            &times;
          </button>
        </div>
      )}

      {/* ── Persistent Darrin recap (Phase 3 A.2) ── */}
      {totalDoors > 0 && (
        <div className="mb-3">
          <DarrinMessage
            avatar={lowCount > 0 ? 'concerned' : medCount > 0 ? 'scanning' : 'success'}
            message={darrinRecap(totalDoors, highCount, medCount, lowCount, orphanDoors.length)}
          />
        </div>
      )}

      {/* ── Summary Stats Bar ── */}
      <div className="mb-4 p-3 bg-tint border border-border-dim rounded-md">
        <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
          <span className="text-sm text-primary font-medium">
            {totalDoors} doors extracted
          </span>
          <div className="flex items-center gap-2">
            {hasExistingData && (
              <span className="text-xs bg-warning-dim text-warning px-2 py-0.5 rounded-full">
                Revision
              </span>
            )}
            {showToggle && (
              <div
                className="inline-flex items-center rounded-md border border-border-dim-strong p-0.5 bg-tint"
                role="group"
                aria-label="View mode"
              >
                <button
                  type="button"
                  onClick={() => onViewModeChange!('door')}
                  className={`text-[11px] px-2.5 py-1 rounded min-h-9 transition-colors ${
                    viewMode === 'door'
                      ? 'bg-accent text-white'
                      : 'text-secondary hover:text-primary'
                  }`}
                  aria-pressed={viewMode === 'door'}
                >
                  Door view
                </button>
                <button
                  type="button"
                  onClick={() => onViewModeChange!('set')}
                  className={`text-[11px] px-2.5 py-1 rounded min-h-9 transition-colors ${
                    viewMode === 'set'
                      ? 'bg-accent text-white'
                      : 'text-secondary hover:text-primary'
                  }`}
                  aria-pressed={viewMode === 'set'}
                >
                  Set view
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Confidence bar */}
        <div className="confidence-bar mb-2">
          {highCount > 0 && (
            <div
              className="confidence-bar__segment confidence-bar__segment--high"
              style={{ width: `${(highCount / totalDoors) * 100}%` }}
            />
          )}
          {medCount > 0 && (
            <div
              className="confidence-bar__segment confidence-bar__segment--med"
              style={{ width: `${(medCount / totalDoors) * 100}%` }}
            />
          )}
          {lowCount > 0 && (
            <div
              className="confidence-bar__segment confidence-bar__segment--low"
              style={{ width: `${(lowCount / totalDoors) * 100}%` }}
            />
          )}
        </div>

        {/* Human labels */}
        <div className="flex items-center gap-4 text-xs mb-3">
          <span className="text-success">{highCount} ready</span>
          <span className="text-warning">{medCount} need{medCount === 1 ? 's' : ''} attention</span>
          <span className="text-danger">{lowCount} missing data</span>
        </div>

        {/* Issue-type summary (only when there are attention/missing items) */}
        {(medCount > 0 || lowCount > 0) && (
          <div className="flex flex-wrap gap-2 mb-3">
            {Array.from(issueGroups.entries())
              .filter(([key]) => !key.startsWith('missing_door_number') && !key.startsWith('missing_hw_set'))
              .sort((a, b) => b[1].length - a[1].length)
              .slice(0, 5)
              .map(([issueKey, doorNumbers]) => (
                <span key={issueKey} className="text-[11px] px-2 py-0.5 rounded bg-warning-dim text-warning border border-warning/20">
                  {doorNumbers.length} door{doorNumbers.length !== 1 ? 's' : ''}: {ISSUE_LABELS[issueKey] ?? issueKey.replace(/_/g, ' ')}
                </span>
              ))}
          </div>
        )}

        {children}
      </div>
    </>
  );
}
