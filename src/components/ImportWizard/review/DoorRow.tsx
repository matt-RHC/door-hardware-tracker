"use client";

import type { DoorEntry } from "../types";
import ConfidenceBadge from "../ConfidenceBadge";
import { getConfidence, getDoorIssues, confBorder } from "./utils";
import { ISSUE_LABELS } from "./types";

interface DoorRowProps {
  door: DoorEntry;
  isExpanded: boolean;
  onToggle: () => void;
  registerRef: (doorNumber: string, el: HTMLElement | null) => void;
}

export default function DoorRow({
  door,
  isExpanded,
  onToggle,
  registerRef,
}: DoorRowProps) {
  const conf = getConfidence(door);
  const issues = getDoorIssues(door);
  // Top 2 non-required issues for the inline hint
  const topIssues = issues
    .filter((i) => !i.startsWith('missing_door_number') && !i.startsWith('missing_hw_set'))
    .slice(0, 2);

  // Auto-approved rows recede (opacity-70) so the eye lands on rows that
  // still need a human. The confidence pill still reads at 70% opacity,
  // which is exactly the "quiet when fine" signal we want.
  const isAutoApproved = conf === 'high';

  return (
    <div
      ref={(el) => {
        if (door.door_number) registerRef(door.door_number, el);
      }}
      className={`${confBorder(door)} border-t border-border-dim bg-tint transition-opacity duration-150 ${
        isAutoApproved ? 'opacity-70' : ''
      }`}
    >
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 flex items-center gap-3 min-h-11 hover:bg-tint-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent transition-colors"
        aria-expanded={isExpanded}
      >
        <span
          className="text-tertiary text-xs shrink-0 transition-transform"
          style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
          aria-hidden="true"
        >
          {'\u25B8'}
        </span>
        <span className="font-mono text-sm font-semibold text-primary tabular-nums shrink-0 min-w-[3.5rem]">
          {door.door_number || '—'}
        </span>
        <span className="text-accent text-[12px] font-mono shrink-0 min-w-[4.5rem]">
          {door.hw_set || '—'}
        </span>
        <span className="text-secondary text-[12px] truncate flex-1">
          {door.location || <span className="text-tertiary">no location</span>}
        </span>
        {door.fire_rating && (
          <span className="text-tertiary text-[11px] shrink-0 tabular-nums">
            {door.fire_rating}
          </span>
        )}
        {topIssues.length > 0 && (
          <span className="hidden md:inline text-[10px] text-warning shrink-0 truncate max-w-[14rem]">
            {topIssues.map((i) => ISSUE_LABELS[i] ?? i.replace(/_/g, ' ')).join(', ')}
          </span>
        )}
        <ConfidenceBadge level={conf} variant="pill" />
      </button>
    </div>
  );
}
