"use client";

import type { DoorEntry } from "../types";
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

  return (
    <div
      ref={(el) => {
        if (door.door_number) registerRef(door.door_number, el);
      }}
      className={`${confBorder(door)} border-t border-border-dim bg-tint transition-colors duration-150`}
    >
      <button
        onClick={onToggle}
        className="w-full text-left px-3 py-2 flex items-center gap-3 min-h-11 hover:bg-tint-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        aria-expanded={isExpanded}
      >
        <span
          className="text-tertiary text-xs shrink-0 transition-transform"
          style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
          aria-hidden="true"
        >
          {'\u25B8'}
        </span>
        <span className="font-mono text-[13px] text-primary shrink-0 min-w-[3.5rem]">
          {door.door_number || '—'}
        </span>
        <span className="text-accent text-[12px] font-mono shrink-0 min-w-[4.5rem]">
          {door.hw_set || '—'}
        </span>
        <span className="text-secondary text-[12px] truncate flex-1">
          {door.location || <span className="text-tertiary">no location</span>}
        </span>
        {door.fire_rating && (
          <span className="text-tertiary text-[11px] shrink-0">
            {door.fire_rating}
          </span>
        )}
        {topIssues.length > 0 && (
          <span className="hidden md:inline text-[10px] text-warning shrink-0 truncate max-w-[14rem]">
            {topIssues.map((i) => ISSUE_LABELS[i] ?? i.replace(/_/g, ' ')).join(', ')}
          </span>
        )}
        <span className="flex items-center gap-1 shrink-0" aria-label={`confidence ${conf}`}>
          {conf === 'high' && <span className="w-2 h-2 rounded-full bg-success" />}
          {conf === 'medium' && <span className="w-2 h-2 rounded-full bg-warning" />}
          {conf === 'low' && <span className="w-2 h-2 rounded-full bg-danger" />}
        </span>
      </button>
    </div>
  );
}
