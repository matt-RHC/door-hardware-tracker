"use client";

import { useState, useCallback, useRef, useEffect } from "react";

/* ─── Types (shared with PDFUploadModal) ─── */
interface HardwareItem {
  qty: number;
  qty_total?: number;
  qty_door_count?: number;
  qty_source?: string;
  name: string;
  model: string;
  finish: string;
  manufacturer: string;
}

interface HardwareSet {
  set_id: string;
  generic_set_id?: string;
  heading: string;
  heading_door_count?: number;
  heading_leaf_count?: number;
  items: HardwareItem[];
}

interface DoorEntry {
  door_number: string;
  hw_set: string;
  location: string;
  door_type: string;
  frame_type: string;
  fire_rating: string;
  hand: string;
}

interface FlaggedDoor {
  door: DoorEntry;
  reason: string;
  pattern: string;
  dominant_pattern: string;
}

/* ─── Editable Cell ─── */
function EditableCell({
  value,
  onChange,
  warning,
}: {
  value: string;
  onChange: (v: string) => void;
  warning?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft.trim() !== value) onChange(draft.trim());
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
        className="w-full bg-white/[0.08] text-[#f5f5f7] px-2 py-1 rounded text-sm border border-[#0a84ff]/50 outline-none"
      />
    );
  }

  return (
    <div
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
      title={warning || "Click to edit"}
      className={`px-2 py-1 rounded text-sm cursor-pointer hover:bg-white/[0.06] transition-colors truncate ${
        warning
          ? "bg-[rgba(255,214,10,0.08)] border border-[rgba(255,214,10,0.2)] text-[#ffd60a]"
          : "text-[#f5f5f7]"
      }`}
    >
      {value || <span className="text-[#6e6e73] italic">empty</span>}
    </div>
  );
}

/* ─── Main Component ─── */
interface ImportReviewTableProps {
  projectId: string;
  doors: DoorEntry[];
  sets: HardwareSet[];
  flaggedDoors?: FlaggedDoor[];
  onClose: () => void;
  onComplete: () => void;
}

export default function ImportReviewTable({
  projectId,
  doors: initialDoors,
  sets,
  flaggedDoors = [],
  onClose,
  onComplete,
}: ImportReviewTableProps) {
  const [doors, setDoors] = useState<DoorEntry[]>(initialDoors);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSets, setShowSets] = useState(false);
  const [deletedRows, setDeletedRows] = useState<Set<number>>(new Set());
  const [byOthersRows, setByOthersRows] = useState<Set<number>>(new Set());

  // Flagged doors: user decides which to include
  const [approvedFlagged, setApprovedFlagged] = useState<Set<number>>(new Set());
  const hasFlaggedDoors = flaggedDoors.length > 0;

  // Auto-detect likely "By Others" candidates: N/A hw_set, OH/Gate door types
  const isByOthersCandidate = useCallback((door: DoorEntry): boolean => {
    const hwSet = door.hw_set?.trim().toUpperCase();
    const doorType = door.door_type?.trim().toUpperCase();
    return (
      hwSet === "N/A" ||
      hwSet === "NA" ||
      hwSet === "BY OTHERS" ||
      hwSet === "" ||
      doorType === "OH" ||
      doorType === "OVERHEAD" ||
      doorType === "GATE" ||
      doorType === "ROLL-UP" ||
      doorType === "ROLLUP" ||
      doorType === "COILING"
    );
  }, []);

  // Cross-validation warnings
  const knownSetIds = new Set(sets.map((s) => s.set_id));
  const doorSetCounts = new Map<string, number>();
  for (const d of doors) {
    doorSetCounts.set(d.hw_set, (doorSetCounts.get(d.hw_set) || 0) + 1);
  }

  const getWarnings = useCallback(
    (door: DoorEntry, idx: number): Record<string, string> => {
      const w: Record<string, string> = {};
      if (deletedRows.has(idx)) return w;
      if (door.hw_set && !knownSetIds.has(door.hw_set)) {
        w.hw_set = `Set "${door.hw_set}" has no hardware definition`;
      }
      if (!door.door_number.trim()) {
        w.door_number = "Missing door number";
      }
      if (!door.hw_set.trim()) {
        w.hw_set = "No hardware set assigned";
      }
      return w;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doors, deletedRows]
  );

  const updateDoor = (idx: number, field: keyof DoorEntry, value: string) => {
    setDoors((prev) => {
      const updated = [...prev];
      updated[idx] = { ...updated[idx], [field]: value };
      return updated;
    });
  };

  const toggleDeleteRow = (idx: number) => {
    setDeletedRows((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
    // Clear from byOthers if marking as deleted
    setByOthersRows((prev) => {
      const next = new Set(prev);
      next.delete(idx);
      return next;
    });
  };

  const toggleByOthers = (idx: number) => {
    setByOthersRows((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
    // Clear from deleted if marking as byOthers
    setDeletedRows((prev) => {
      const next = new Set(prev);
      next.delete(idx);
      return next;
    });
  };

  const markAllSuggestedByOthers = () => {
    const suggested = new Set(byOthersRows);
    doors.forEach((door, idx) => {
      if (!deletedRows.has(idx) && isByOthersCandidate(door)) {
        suggested.add(idx);
      }
    });
    setByOthersRows(suggested);
  };

  const clearAllByOthers = () => {
    setByOthersRows(new Set());
  };

  const addRow = () => {
    setDoors((prev) => [
      ...prev,
      {
        door_number: "",
        hw_set: "",
        location: "",
        door_type: "",
        frame_type: "",
        fire_rating: "",
        hand: "",
      },
    ]);
  };

  // Orphaned sets: defined but no doors reference them
  const referencedSets = new Set(doors.filter((_, i) => !deletedRows.has(i)).map((d) => d.hw_set));
  const orphanedSets = sets.filter((s) => !referencedSets.has(s.set_id));

  const activeDoors = doors.filter((_, i) => !deletedRows.has(i) && !byOthersRows.has(i));
  const byOthersCount = byOthersRows.size;
  const suggestedByOthersCount = doors.filter((d, i) => !deletedRows.has(i) && !byOthersRows.has(i) && isByOthersCandidate(d)).length;
  const warningCount = doors.reduce((count, d, i) => {
    return count + Object.keys(getWarnings(d, i)).length;
  }, 0);

  const toggleFlaggedApproval = (idx: number) => {
    setApprovedFlagged((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const approveAllFlagged = () => {
    setApprovedFlagged(new Set(flaggedDoors.map((_, i) => i)));
  };

  const handleConfirmAndSave = async () => {
    // Filter out deleted and "by others" rows, then add approved flagged doors
    const mainDoors = doors.filter((_, i) => !deletedRows.has(i) && !byOthersRows.has(i));
    const restoredDoors = flaggedDoors
      .filter((_, i) => approvedFlagged.has(i))
      .map((f) => f.door);
    const finalDoors = [...mainDoors, ...restoredDoors];
    if (finalDoors.length === 0) {
      setError("Cannot save with zero openings. Add at least one door.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const resp = await fetch("/api/parse-pdf/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          hardwareSets: sets,
          doors: finalDoors,
        }),
      });

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        throw new Error(errBody.error || `Save failed (${resp.status})`);
      }

      const result = await resp.json();
      if (!result.success) throw new Error("Save returned no success");

      // Store PDF hash if available
      onComplete();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const columns: { key: keyof DoorEntry; label: string; width: string }[] = [
    { key: "door_number", label: "Door #", width: "w-[100px]" },
    { key: "hw_set", label: "HW Set", width: "w-[90px]" },
    { key: "location", label: "Location", width: "w-[180px]" },
    { key: "door_type", label: "Door Type", width: "w-[100px]" },
    { key: "frame_type", label: "Frame Type", width: "w-[100px]" },
    { key: "fire_rating", label: "Fire Rating", width: "w-[90px]" },
    { key: "hand", label: "Hand", width: "w-[70px]" },
  ];

  return (
    <div className="fixed inset-0 bg-black/90 backdrop-blur-lg flex flex-col z-50">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.08] bg-[#1c1c1e]">
        <div>
          <h2 className="text-xl font-semibold text-[#f5f5f7]">
            Review Extracted Data
          </h2>
          <p className="text-sm text-[#a1a1a6] mt-1">
            {activeDoors.length} openings &middot; {sets.length} hardware sets
            {byOthersCount > 0 && (
              <span className="ml-2 text-[#a78bfa]">
                &middot; {byOthersCount} by others
              </span>
            )}
            {warningCount > 0 && (
              <span className="ml-2 text-[#ffd60a]">
                &middot; {warningCount} warning{warningCount !== 1 ? "s" : ""}
              </span>
            )}
            {orphanedSets.length > 0 && (
              <span className="ml-2 text-[#ff9f0a]">
                &middot; {orphanedSets.length} orphaned set
                {orphanedSets.length !== 1 ? "s" : ""}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {suggestedByOthersCount > 0 && (
            <button
              onClick={markAllSuggestedByOthers}
              className="px-3 py-1.5 text-sm bg-[rgba(167,139,250,0.1)] border border-[rgba(167,139,250,0.25)] text-[#a78bfa] rounded-lg hover:bg-[rgba(167,139,250,0.18)] transition-colors"
            >
              Mark {suggestedByOthersCount} as By Others
            </button>
          )}
          {byOthersCount > 0 && (
            <button
              onClick={clearAllByOthers}
              className="px-3 py-1.5 text-sm bg-white/[0.04] border border-white/[0.08] text-[#a1a1a6] rounded-lg hover:bg-white/[0.07] transition-colors"
            >
              Clear By Others
            </button>
          )}
          <button
            onClick={() => setShowSets(!showSets)}
            className="px-3 py-1.5 text-sm bg-white/[0.04] border border-white/[0.08] text-[#a1a1a6] rounded-lg hover:bg-white/[0.07] transition-colors"
          >
            {showSets ? "Hide" : "Show"} Hardware Sets
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-1.5 text-sm bg-white/[0.04] border border-white/[0.08] text-[#a1a1a6] rounded-lg hover:bg-white/[0.07] disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirmAndSave}
            disabled={saving || activeDoors.length === 0}
            className="px-5 py-1.5 text-sm bg-[#30d158] text-black font-semibold rounded-lg hover:opacity-90 disabled:bg-white/[0.06] disabled:text-[#6e6e73] transition-colors"
          >
            {saving ? "Saving..." : "Confirm & Save"}
          </button>
        </div>
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className="mx-6 mt-3 p-3 bg-[rgba(255,69,58,0.1)] border border-[rgba(255,69,58,0.2)] rounded-xl text-[#ff6961] text-sm">
          {error}
        </div>
      )}

      {/* ── Info banner ── */}
      <div className="mx-6 mt-3 p-3 bg-[rgba(10,132,255,0.08)] border border-[rgba(10,132,255,0.15)] rounded-xl text-[#0a84ff] text-sm">
        Click any cell to edit. Remove rows with the &times; button. This is your chance to fix any parsing errors before data is saved.
      </div>

      {/* ── Hardware Sets Panel (collapsible) ── */}
      {showSets && (
        <div className="mx-6 mt-3 max-h-48 overflow-y-auto bg-[#2c2c2e] rounded-xl border border-white/[0.08] p-4">
          <h3 className="text-sm font-semibold text-[#f5f5f7] mb-2">
            Hardware Sets ({sets.length})
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {sets.map((s) => (
              <div
                key={s.set_id}
                className={`p-2 rounded-lg text-xs ${
                  orphanedSets.includes(s)
                    ? "bg-[rgba(255,159,10,0.1)] border border-[rgba(255,159,10,0.2)] text-[#ff9f0a]"
                    : "bg-white/[0.04] text-[#a1a1a6]"
                }`}
              >
                <div className="flex items-center gap-1 mb-1">
                  <span className="font-semibold text-[#f5f5f7]">{s.set_id}</span>
                  {" — "}
                  {s.heading || "No heading"}
                  {orphanedSets.includes(s) && (
                    <span className="ml-1 text-[#ff9f0a]">(orphaned)</span>
                  )}
                </div>
                <div className="space-y-0.5">
                  {s.items.map((item, i) => {
                    const hasMeta = item.qty_total != null && item.qty_door_count != null;
                    const isFlagged = item.qty_source === "flagged";
                    const isDivided = item.qty_source === "divided";
                    const isCapped = item.qty_source === "capped";
                    const tooltip = hasMeta
                      ? `${item.qty_total} total ÷ ${item.qty_door_count} = ${item.qty} each`
                      : undefined;
                    return (
                      <div
                        key={i}
                        className="flex items-center gap-2 text-[10px]"
                        title={tooltip}
                      >
                        <span className={`font-mono w-5 text-right ${
                          isFlagged ? "text-[#ff9f0a] font-bold" :
                          isDivided ? "text-[#30d158]" :
                          isCapped ? "text-[#ffd60a]" :
                          "text-[#a1a1a6]"
                        }`}>
                          {item.qty}
                        </span>
                        <span className="text-[#e8e8ed] truncate flex-1">{item.name}</span>
                        {isFlagged && (
                          <span className="text-[#ff9f0a] shrink-0" title={`Does not divide evenly: ${item.qty_total} ÷ ${item.qty_door_count}`}>
                            !!
                          </span>
                        )}
                        {isDivided && hasMeta && (
                          <span className="text-[#6e6e73] shrink-0">
                            {item.qty_total}&divide;{item.qty_door_count}
                          </span>
                        )}
                        {isCapped && (
                          <span className="text-[#ffd60a] shrink-0" title="Qty capped (no door count available)">
                            cap
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Table ── */}
      <div className="flex-1 overflow-auto mx-6 mt-3 mb-6 rounded-xl border border-white/[0.08] bg-[#1c1c1e]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-[#2c2c2e] border-b border-white/[0.08]">
            <tr>
              <th className="w-10 px-2 py-2 text-center text-[#6e6e73] font-medium">#</th>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`${col.width} px-2 py-2 text-left text-[#a1a1a6] font-medium`}
                >
                  {col.label}
                </th>
              ))}
              <th className="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {doors.map((door, idx) => {
              const warnings = getWarnings(door, idx);
              const isDeleted = deletedRows.has(idx);
              const isByOthers = byOthersRows.has(idx);
              const isCandidate = !isDeleted && !isByOthers && isByOthersCandidate(door);
              return (
                <tr
                  key={idx}
                  className={`border-b border-white/[0.04] ${
                    isDeleted
                      ? "opacity-30 line-through"
                      : isByOthers
                      ? "opacity-50 bg-[rgba(167,139,250,0.04)]"
                      : isCandidate
                      ? "bg-[rgba(167,139,250,0.02)]"
                      : Object.keys(warnings).length > 0
                      ? "bg-[rgba(255,214,10,0.03)]"
                      : "hover:bg-white/[0.02]"
                  }`}
                >
                  <td className="px-2 py-1 text-center text-[#6e6e73] text-xs">
                    {idx + 1}
                  </td>
                  {columns.map((col) => (
                    <td key={col.key} className={`${col.width} px-1 py-1`}>
                      {isDeleted || isByOthers ? (
                        <span className="px-2 py-1 text-[#6e6e73]">
                          {door[col.key] || <span className="italic">empty</span>}
                        </span>
                      ) : (
                        <EditableCell
                          value={door[col.key]}
                          onChange={(v) => updateDoor(idx, col.key, v)}
                          warning={warnings[col.key]}
                        />
                      )}
                    </td>
                  ))}
                  <td className="px-2 py-1 text-center whitespace-nowrap">
                    <button
                      onClick={() => toggleByOthers(idx)}
                      title={isByOthers ? "Include this opening" : "Mark as By Others (excluded)"}
                      className={`w-auto px-1.5 h-6 rounded text-[10px] font-semibold uppercase tracking-wide transition-colors mr-1 ${
                        isByOthers
                          ? "bg-[rgba(167,139,250,0.2)] text-[#a78bfa] hover:bg-[rgba(167,139,250,0.3)]"
                          : isCandidate
                          ? "bg-[rgba(167,139,250,0.08)] text-[#a78bfa]/60 hover:bg-[rgba(167,139,250,0.15)] border border-dashed border-[rgba(167,139,250,0.2)]"
                          : "bg-white/[0.03] text-[#6e6e73] hover:bg-[rgba(167,139,250,0.1)] hover:text-[#a78bfa]"
                      }`}
                    >
                      {isByOthers ? "BO" : "BO"}
                    </button>
                    <button
                      onClick={() => toggleDeleteRow(idx)}
                      title={isDeleted ? "Restore row" : "Remove row"}
                      className={`w-6 h-6 rounded-full text-xs font-bold transition-colors ${
                        isDeleted
                          ? "bg-[rgba(48,209,88,0.15)] text-[#30d158] hover:bg-[rgba(48,209,88,0.25)]"
                          : "bg-[rgba(255,69,58,0.1)] text-[#ff6961] hover:bg-[rgba(255,69,58,0.2)]"
                      }`}
                    >
                      {isDeleted ? "↺" : "×"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Flagged Doors Review ── */}
      {hasFlaggedDoors && (
        <div className="mx-6 mb-4 border border-[rgba(255,159,10,0.3)] rounded-lg overflow-hidden">
          <div className="px-4 py-3 bg-[rgba(255,159,10,0.06)] flex items-center justify-between">
            <div>
              <h4 className="text-[13px] font-bold text-[#ff9f0a]">
                {flaggedDoors.length} DOOR{flaggedDoors.length !== 1 ? "S" : ""} FLAGGED FOR REVIEW
              </h4>
              <p className="text-[11px] text-[#a1a1a6] mt-0.5">
                These don&apos;t match the dominant door number pattern. Include the ones that are valid openings.
              </p>
            </div>
            <button
              onClick={approveAllFlagged}
              className="text-[11px] px-3 py-1 bg-[rgba(255,159,10,0.15)] text-[#ff9f0a] rounded-lg hover:bg-[rgba(255,159,10,0.25)] transition-colors"
            >
              Include All
            </button>
          </div>
          <div className="divide-y divide-white/[0.04]">
            {flaggedDoors.map((flagged, idx) => {
              const isApproved = approvedFlagged.has(idx);
              return (
                <div
                  key={idx}
                  className={`px-4 py-2 flex items-center gap-3 transition-colors ${
                    isApproved
                      ? "bg-[rgba(48,209,88,0.04)]"
                      : "bg-transparent hover:bg-white/[0.02]"
                  }`}
                >
                  <button
                    onClick={() => toggleFlaggedApproval(idx)}
                    className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                      isApproved
                        ? "bg-[rgba(48,209,88,0.2)] text-[#30d158] border-2 border-[#30d158]"
                        : "bg-white/[0.04] text-[#6e6e73] border-2 border-[rgba(110,110,115,0.3)] hover:border-[#ff9f0a] hover:text-[#ff9f0a]"
                    }`}
                  >
                    {isApproved ? "✓" : "+"}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-[13px] font-medium ${isApproved ? "text-[#30d158]" : "text-[#e8e8ed]"}`}>
                        {flagged.door.door_number}
                      </span>
                      {flagged.door.hw_set && (
                        <span className="text-[11px] text-[#6e6e73]">
                          Set: {flagged.door.hw_set}
                        </span>
                      )}
                      {flagged.door.location && (
                        <span className="text-[11px] text-[#6e6e73] truncate">
                          {flagged.door.location}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-[#636366] mt-0.5 truncate">
                      {flagged.reason}
                    </p>
                  </div>
                  <span className={`shrink-0 text-[10px] font-mono px-2 py-0.5 rounded ${
                    isApproved
                      ? "bg-[rgba(48,209,88,0.1)] text-[#30d158]"
                      : "bg-white/[0.04] text-[#6e6e73]"
                  }`}>
                    {isApproved ? "INCLUDED" : "EXCLUDED"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Footer: Add Row ── */}
      <div className="px-6 pb-4 flex justify-between items-center">
        <button
          onClick={addRow}
          disabled={saving}
          className="px-4 py-1.5 text-sm bg-white/[0.04] border border-white/[0.08] text-[#a1a1a6] rounded-lg hover:bg-white/[0.07] disabled:opacity-50 transition-colors"
        >
          + Add Row
        </button>
        <div className="text-xs text-[#6e6e73]">
          {activeDoors.length + approvedFlagged.size} opening{(activeDoors.length + approvedFlagged.size) !== 1 ? "s" : ""} will
          be saved
          {approvedFlagged.size > 0 && (
            <span className="text-[#30d158]">
              {" "}&middot; {approvedFlagged.size} restored from flagged
            </span>
          )}
          {hasFlaggedDoors && flaggedDoors.length - approvedFlagged.size > 0 && (
            <span className="text-[#ff9f0a]">
              {" "}&middot; {flaggedDoors.length - approvedFlagged.size} flagged (excluded)
            </span>
          )}
          {byOthersCount > 0 && (
            <span className="text-[#a78bfa]">
              {" "}&middot; {byOthersCount} by others (excluded)
            </span>
          )}
          {deletedRows.size > 0 && (
            <span className="text-[#ff9f0a]">
              {" "}&middot; {deletedRows.size} removed
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
