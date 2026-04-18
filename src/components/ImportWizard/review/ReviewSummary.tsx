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

  const attentionCount = medCount + lowCount;
  const issueTypeCount = Array.from(issueGroups.entries())
    .filter(([key]) => !key.startsWith('missing_door_number') && !key.startsWith('missing_hw_set'))
    .length;
  const ready = attentionCount === 0 && totalDoors > 0;

  return (
    <>
      {/* ── Page head (attention-first look/feel) ── */}
      {totalDoors > 0 && (
        <div className="mb-4">
          <div className="eyebrow mb-2">
            {totalDoors} openings imported · {issueTypeCount} issue{issueTypeCount === 1 ? '' : 's'} flagged
          </div>
          <h1 className="page-h1 mb-2">
            Review what needs your attention.
          </h1>
          <p className="lede max-w-3xl">
            {attentionCount > 0 ? (
              <>
                Rabbit Hole imported <strong>{totalDoors}</strong> openings.{' '}
                <strong>{attentionCount}</strong> opening{attentionCount === 1 ? '' : 's'} across{' '}
                <strong>{issueTypeCount || 1}</strong> issue{issueTypeCount === 1 ? '' : 's'} still need a call before we can export.
              </>
            ) : (
              <>
                Rabbit Hole imported <strong>{totalDoors}</strong> openings. Everything looks clean — you&rsquo;re ready to export.
              </>
            )}
          </p>
        </div>
      )}

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
              &mdash; no hardware set or items found
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

      {/* ── Progress + gate row ── */}
      {totalDoors > 0 && (
        <div className="mb-4">
          <div className="progress-meter mb-2">
            <div
              className="progress-meter__fill"
              style={{ width: `${(highCount / totalDoors) * 100}%` }}
            />
          </div>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-xs text-secondary tabular-nums">
              {highCount} of {totalDoors} ready
              {medCount > 0 ? ` · ${medCount} need${medCount === 1 ? 's' : ''} attention` : ''}
              {lowCount > 0 ? ` · ${lowCount} missing data` : ''}
            </span>
            <div className="flex items-center gap-2">
              {hasExistingData && (
                <span className="text-[11px] bg-warning-dim text-warning px-2 py-0.5 rounded-full font-medium tracking-wide uppercase">
                  Revision
                </span>
              )}
              <span className={`gate-pill ${ready ? 'gate-pill--ready' : 'gate-pill--blocked'}`}>
                {ready
                  ? 'Ready to export'
                  : `Export blocked · ${attentionCount} opening${attentionCount === 1 ? '' : 's'}`}
              </span>
              {showToggle && (
                <div className="segmented" role="group" aria-label="View mode">
                  <button
                    type="button"
                    onClick={() => onViewModeChange!('door')}
                    className={`segmented__btn ${viewMode === 'door' ? 'segmented__btn--active' : ''}`}
                    aria-pressed={viewMode === 'door'}
                  >
                    Door view
                  </button>
                  <button
                    type="button"
                    onClick={() => onViewModeChange!('set')}
                    className={`segmented__btn ${viewMode === 'set' ? 'segmented__btn--active' : ''}`}
                    aria-pressed={viewMode === 'set'}
                  >
                    Set view
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Issue-type summary + filters ── */}
      <div className="mb-4 p-3 bg-tint border border-border-dim rounded-md">
        {(medCount > 0 || lowCount > 0) && (
          <div className="flex flex-wrap gap-2 mb-3">
            {Array.from(issueGroups.entries())
              .filter(([key]) => !key.startsWith('missing_door_number') && !key.startsWith('missing_hw_set'))
              .sort((a, b) => b[1].length - a[1].length)
              .slice(0, 5)
              .map(([issueKey, doorNumbers]) => (
                <span key={issueKey} className="text-[11px] px-2 py-0.5 rounded bg-warning-dim text-warning border border-warning/20 font-mono">
                  {doorNumbers.length} opening{doorNumbers.length !== 1 ? 's' : ''}: {ISSUE_LABELS[issueKey] ?? issueKey.replace(/_/g, ' ')}
                </span>
              ))}
          </div>
        )}

        {children}
      </div>
    </>
  );
}
