"use client";

import type { FilterLevel } from "./types";

interface ReviewFiltersProps {
  filterLevel: FilterLevel;
  onFilterLevelChange: (level: FilterLevel) => void;
  search: string;
  onSearchChange: (search: string) => void;
}

const FILTER_OPTIONS: Array<[FilterLevel, string]> = [
  ["all", "All"],
  ["medium", "Needs Attention"],
  ["low", "Missing Data"],
];

export default function ReviewFilters({
  filterLevel,
  onFilterLevelChange,
  search,
  onSearchChange,
}: ReviewFiltersProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {FILTER_OPTIONS.map(([level, label]) => (
        <button
          key={level}
          onClick={() => onFilterLevelChange(level)}
          className={`text-xs px-3 py-1 rounded-full transition-colors ${
            filterLevel === level
              ? "bg-accent text-white"
              : "bg-tint border border-border-dim-strong text-secondary hover:bg-tint-strong"
          }`}
        >
          {label}
        </button>
      ))}
      <input
        type="text"
        placeholder="Search doors..."
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="ml-auto text-xs px-3 py-1.5 bg-tint border border-border-dim-strong rounded-lg text-primary placeholder-tertiary focus:border-accent focus:outline-none w-48"
      />
    </div>
  );
}
