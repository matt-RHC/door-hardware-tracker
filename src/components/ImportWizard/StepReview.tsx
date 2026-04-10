"use client";

import { useState, useCallback, useMemo } from "react";
import { usePunchHighlight } from "./usePunchHighlight";
import type { DoorEntry, HardwareSet, ClassifyPagesResponse } from "./types";
import PDFPagePreview from "./PDFPagePreview";
import { findPageForSet } from "@/lib/punch-cards";

// ─── Confidence scoring ───

function getConfidence(door: DoorEntry): "high" | "medium" | "low" {
  if (!door.door_number || !door.hw_set) return "low";
  const fields = [
    door.location,
    door.door_type,
    door.frame_type,
    door.fire_rating,
    door.hand,
  ];
  const filled = fields.filter((f) => f && f.trim() !== "").length;
  if (filled >= 4) return "high";
  if (filled >= 2) return "medium";
  return "low";
}

// ─── Types ───

type DoorStringField =
  | "door_number"
  | "hw_set"
  | "location"
  | "door_type"
  | "frame_type"
  | "fire_rating"
  | "hand";

type SortDir = "asc" | "desc";

const FIELD_KEYS: DoorStringField[] = [
  "door_number",
  "hw_set",
  "location",
  "door_type",
  "frame_type",
  "fire_rating",
  "hand",
];

const FIELD_LABELS: Record<DoorStringField, string> = {
  door_number: "Door #",
  hw_set: "HW Set",
  location: "Location",
  door_type: "Door Type",
  frame_type: "Frame Type",
  fire_rating: "Fire Rating",
  hand: "Hand",
};

// ─── Grouped door type ───

interface DoorGroup {
  setId: string;
  heading: string;
  doors: Array<{ door: DoorEntry; originalIndex: number }>;
  highCount: number;
  medCount: number;
  lowCount: number;
}

// ─── Props ───

interface StepReviewProps {
  doors: DoorEntry[];
  hardwareSets: HardwareSet[];
  hasExistingData: boolean;
  /** For PDF preview per set. */
  classifyResult: ClassifyPagesResponse | null;
  /** PDF file buffer for rendering page previews. */
  pdfBuffer: ArrayBuffer | null;
  onComplete: (doors: DoorEntry[], hardwareSets: HardwareSet[]) => void;
  onBack: () => void;
  onRemapColumns?: () => void;
}

export default function StepReview({
  doors: initialDoors,
  hardwareSets,
  hasExistingData,
  classifyResult,
  pdfBuffer,
  onComplete,
  onBack,
  onRemapColumns,
}: StepReviewProps) {
  const { registerRef } = usePunchHighlight();
  const [doors, setDoors] = useState<DoorEntry[]>(initialDoors);
  // Which set groups have their PDF preview open (lazy-mounted when expanded)
  const [previewOpen, setPreviewOpen] = useState<Set<string>>(new Set());
  const [editingCell, setEditingCell] = useState<{
    row: number;
    field: DoorStringField;
  } | null>(null);
  const [editValue, setEditValue] = useState("");

  // ─── Search & filter ───
  const [search, setSearch] = useState("");
  const [filterLevel, setFilterLevel] = useState<
    "all" | "high" | "medium" | "low"
  >("all");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set()
  );
  const [sortField, setSortField] = useState<DoorStringField>("door_number");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // ─── Inline editing ───
  const startEdit = useCallback(
    (originalIndex: number, field: DoorStringField) => {
      setEditingCell({ row: originalIndex, field });
      setEditValue(doors[originalIndex]?.[field] ?? "");
    },
    [doors]
  );

  const commitEdit = useCallback(() => {
    if (!editingCell) return;
    setDoors((prev) => {
      const next = [...prev];
      next[editingCell.row] = {
        ...next[editingCell.row],
        [editingCell.field]: editValue,
      };
      return next;
    });
    setEditingCell(null);
    setEditValue("");
  }, [editingCell, editValue]);

  const cancelEdit = useCallback(() => {
    setEditingCell(null);
    setEditValue("");
  }, []);

  // ─── Stats ───
  const highCount = doors.filter((d) => getConfidence(d) === "high").length;
  const medCount = doors.filter((d) => getConfidence(d) === "medium").length;
  const lowCount = doors.filter((d) => getConfidence(d) === "low").length;
  const totalDoors = doors.length;

  // ─── Filter + search ───
  const filteredDoors = useMemo(() => {
    const lowerSearch = search.toLowerCase().trim();
    return doors.map((door, idx) => ({ door, originalIndex: idx })).filter(({ door }) => {
      // Confidence filter
      if (filterLevel !== "all" && getConfidence(door) !== filterLevel) return false;
      // Search
      if (lowerSearch) {
        const searchable = [
          door.door_number,
          door.hw_set,
          door.location,
          door.door_type,
          door.fire_rating,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!searchable.includes(lowerSearch)) return false;
      }
      return true;
    });
  }, [doors, search, filterLevel]);

  // ─── Sort ───
  const sortedDoors = useMemo(() => {
    const sorted = [...filteredDoors];
    sorted.sort((a, b) => {
      const aVal = (a.door[sortField] ?? "").toLowerCase();
      const bVal = (b.door[sortField] ?? "").toLowerCase();
      const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [filteredDoors, sortField, sortDir]);

  // ─── Group by hardware set ───
  const groups: DoorGroup[] = useMemo(() => {
    // Register sets under BOTH set_id and generic_set_id — doors may be
    // assigned to either depending on heading format (e.g., "DH1.01" vs "DH1-10")
    const setMap = new Map<string, HardwareSet>();
    for (const set of hardwareSets) {
      setMap.set(set.set_id, set);
      if (set.generic_set_id && set.generic_set_id !== set.set_id) {
        setMap.set(set.generic_set_id, set);
      }
    }

    const groupMap = new Map<string, DoorGroup>();
    for (const item of sortedDoors) {
      const setId = item.door.hw_set || "(unassigned)";
      if (!groupMap.has(setId)) {
        const set = setMap.get(setId);
        groupMap.set(setId, {
          setId,
          heading: set?.heading ?? "",
          doors: [],
          highCount: 0,
          medCount: 0,
          lowCount: 0,
        });
      }
      const group = groupMap.get(setId)!;
      group.doors.push(item);
      const conf = getConfidence(item.door);
      if (conf === "high") group.highCount++;
      else if (conf === "medium") group.medCount++;
      else group.lowCount++;
    }

    return Array.from(groupMap.values());
  }, [sortedDoors, hardwareSets]);

  // Auto-collapse all-green groups on first render
  useMemo(() => {
    const autoCollapsed = new Set<string>();
    for (const group of groups) {
      if (
        group.doors.length > 0 &&
        group.medCount === 0 &&
        group.lowCount === 0
      ) {
        autoCollapsed.add(group.setId);
      }
    }
    if (autoCollapsed.size > 0 && collapsedGroups.size === 0) {
      setCollapsedGroups(autoCollapsed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.length]);

  const toggleGroup = useCallback((setId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(setId)) next.delete(setId);
      else next.add(setId);
      return next;
    });
  }, []);

  // Max simultaneous PDF previews — protects mobile memory. On very large
  // projects (35+ sets), rendering all canvases at once can crash the tab.
  const MAX_OPEN_PREVIEWS = 3;

  const togglePreview = useCallback((setId: string) => {
    setPreviewOpen((prev) => {
      const next = new Set(prev);
      if (next.has(setId)) {
        next.delete(setId);
      } else {
        // If already at max, close the oldest (first inserted) preview
        if (next.size >= MAX_OPEN_PREVIEWS) {
          const oldest = next.values().next().value;
          if (oldest !== undefined) next.delete(oldest);
        }
        next.add(setId);
      }
      return next;
    });
  }, []);

  const handleSort = useCallback(
    (field: DoorStringField) => {
      if (sortField === field) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortField(field);
        setSortDir("asc");
      }
    },
    [sortField]
  );

  // ─── Confidence border color ───
  const confBorder = (door: DoorEntry) => {
    const c = getConfidence(door);
    if (c === "high") return "row-accent-green";
    if (c === "medium") return "row-accent-amber";
    return "row-accent-red";
  };

  return (
    <div className="flex flex-col h-full max-w-5xl mx-auto">
      {/* ── Summary Stats Bar ── */}
      <div className="mb-4 p-3 bg-tint border border-border-dim rounded-xl">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-primary font-medium">
            {totalDoors} doors extracted
          </span>
          {hasExistingData && (
            <span className="text-xs bg-warning-dim text-warning px-2 py-0.5 rounded-full">
              Revision
            </span>
          )}
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
          <span className="text-warning">{medCount} need review</span>
          <span className="text-danger">{lowCount} missing data</span>
        </div>

        {/* Filter chips + search */}
        <div className="flex items-center gap-2 flex-wrap">
          {(
            [
              ["all", "All"],
              ["medium", "Needs Review"],
              ["low", "Missing Data"],
            ] as const
          ).map(([level, label]) => (
            <button
              key={level}
              onClick={() => setFilterLevel(level)}
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
            onChange={(e) => setSearch(e.target.value)}
            className="ml-auto text-xs px-3 py-1.5 bg-tint border border-border-dim-strong rounded-lg text-primary placeholder-tertiary focus:border-accent focus:outline-none w-48"
          />
        </div>
      </div>

      {/* ── Grouped Table ── */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {groups.length === 0 && (
          <p className="text-tertiary text-sm text-center py-8">
            No doors match your filters.
          </p>
        )}

        {groups.map((group) => {
          const isCollapsed = collapsedGroups.has(group.setId);
          const isPreviewOpen = previewOpen.has(group.setId);
          // Find the PDF page that contains this set's definition
          const pdfPageIdx =
            classifyResult?.pages && pdfBuffer
              ? (findPageForSet(group.setId, classifyResult.pages) ??
                 // Fall back: look by the underlying HardwareSet.generic_set_id
                 (() => {
                   const set = hardwareSets.find(
                     (s) => s.set_id === group.setId || s.generic_set_id === group.setId,
                   );
                   const altId = set?.generic_set_id ?? set?.set_id;
                   return altId ? findPageForSet(altId, classifyResult.pages) : null;
                 })())
              : null;
          return (
            <div key={group.setId} className="mb-3">
              {/* Group header */}
              <button
                onClick={() => toggleGroup(group.setId)}
                className="group-header w-full mb-0.5"
              >
                <span className="text-tertiary text-xs transition-transform inline-block" style={{ transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)" }}>
                  ▾
                </span>
                <span className="text-accent font-mono text-sm font-medium">
                  {group.setId}
                </span>
                {group.heading && (
                  <span className="text-tertiary text-xs truncate">
                    {group.heading}
                  </span>
                )}
                <span className="ml-auto text-tertiary text-xs">
                  {group.doors.length} doors
                </span>
                {/* Mini confidence dots */}
                <span className="flex items-center gap-1 ml-2">
                  {group.highCount > 0 && (
                    <span className="w-2 h-2 rounded-full bg-[var(--green)]" title={`${group.highCount} ready`} />
                  )}
                  {group.medCount > 0 && (
                    <span className="w-2 h-2 rounded-full bg-[var(--orange)]" title={`${group.medCount} need review`} />
                  )}
                  {group.lowCount > 0 && (
                    <span className="w-2 h-2 rounded-full bg-[var(--red)]" title={`${group.lowCount} missing data`} />
                  )}
                </span>
              </button>

              {/* PDF preview toggle — only when we have PDF data and a valid page */}
              {pdfBuffer && pdfPageIdx != null && (
                <div className="mb-1">
                  <button
                    onClick={() => togglePreview(group.setId)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-accent-dim border border-accent text-accent text-[11px] font-medium hover:bg-tint-strong transition-colors min-h-9 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    aria-label={isPreviewOpen ? "Hide PDF page" : "View PDF page"}
                  >
                    <span aria-hidden="true">{isPreviewOpen ? "\u25BE" : "\u25B8"}</span>
                    <span>{isPreviewOpen ? "Hide" : "View"} PDF page {pdfPageIdx + 1}</span>
                  </button>
                </div>
              )}

              {/* PDF page preview (lazy-mounted to save memory) */}
              {isPreviewOpen && pdfBuffer && pdfPageIdx != null && (
                <div className="mb-2 max-w-full md:max-w-2xl">
                  <PDFPagePreview
                    pdfBuffer={pdfBuffer}
                    pageIndex={pdfPageIdx}
                    label={`${group.setId} — Hardware set definition`}
                  />
                </div>
              )}

              {/* Group table */}
              {!isCollapsed && (
                <div className="overflow-x-auto border border-border-dim rounded-lg">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-tint sticky top-0 z-10 shadow-[0_1px_0_var(--border-dim)]">
                        {FIELD_KEYS.map((field) => (
                          <th
                            key={field}
                            onClick={() => handleSort(field)}
                            className="px-3 py-2 text-left text-[11px] text-tertiary uppercase font-semibold cursor-pointer hover:text-secondary select-none"
                          >
                            {FIELD_LABELS[field]}
                            {sortField === field && (
                              <span className="ml-1 text-accent">
                                {sortDir === "asc" ? "▲" : "▼"}
                              </span>
                            )}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {group.doors.map(({ door, originalIndex }, i) => {
                        return (
                          <tr
                            key={`${door.door_number}-${originalIndex}`}
                            ref={(el) => {
                              if (door.door_number)
                                registerRef(door.door_number, el);
                            }}
                            className={`${confBorder(door)} border-t border-border-dim hover:bg-tint transition-colors duration-150 ${
                              i % 2 === 1 ? "bg-white/[0.015]" : ""
                            }`}
                            style={{ minHeight: "40px" }}
                          >
                            {FIELD_KEYS.map((field) => {
                              const isEditing =
                                editingCell?.row === originalIndex &&
                                editingCell?.field === field;
                              return (
                                <td
                                  key={field}
                                  className="px-3 py-2"
                                >
                                  {isEditing ? (
                                    <input
                                      autoFocus
                                      type="text"
                                      value={editValue}
                                      onChange={(e) =>
                                        setEditValue(e.target.value)
                                      }
                                      onBlur={commitEdit}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") commitEdit();
                                        if (e.key === "Escape") cancelEdit();
                                      }}
                                      className="w-full bg-tint-strong border border-accent rounded px-2 py-1 text-primary text-[13px] focus:outline-none"
                                    />
                                  ) : (
                                    <span
                                      onClick={() =>
                                        startEdit(originalIndex, field)
                                      }
                                      className={`cursor-pointer text-[13px] font-mono ${
                                        door[field]
                                          ? "text-primary"
                                          : "text-tertiary border-b border-dashed border-tertiary/30"
                                      }`}
                                    >
                                      {door[field] || "\u00A0"}
                                    </span>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Navigation ── */}
      <div className="flex justify-between mt-4 pt-4 border-t border-border-dim-strong">
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="px-4 py-2 bg-tint border border-border-dim-strong hover:bg-tint-strong text-secondary rounded-lg transition-colors"
          >
            Back
          </button>
          {onRemapColumns && (
            <button
              onClick={onRemapColumns}
              className="px-3 py-2 bg-warning-dim border border-warning hover:bg-warning-dim text-warning rounded-lg transition-colors text-sm"
            >
              Remap Columns
            </button>
          )}
        </div>
        <button
          onClick={() => onComplete(doors, hardwareSets)}
          className="px-6 py-2 bg-accent hover:bg-accent/80 text-white rounded-lg transition-colors font-semibold"
        >
          Next
        </button>
      </div>
    </div>
  );
}
