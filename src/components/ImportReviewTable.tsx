"use client";

import { useState, useCallback, useRef, useEffect } from "react";

/* --- Types (shared with PDFUploadModal) --- */
interface HardwareItem {
  qty: number;
  name: string;
  model: string;
  finish: string;
  manufacturer: string;
}

interface HardwareSet {
  set_id: string;
  heading: string;
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

/* --- Editable Cell --- */
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

/* --- Main Component --- */
interface ImportReviewTableProps {
  projectId: string;
  doors: DoorEntry[];
  sets: HardwareSet[];
  onClose: () => void;
  onComplete: () => void;
}

export default function ImportReviewTable({
  projectId,
  doors: initialDoors,
  sets,
  onClose,
  onComplete,
}: ImportReviewTableProps) {
  const [doors, setDoors] = useState<DoorEntry[]>(initialDoors);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSets, setShowSets] = useState(false);
  const [deletedRows, setDeletedRows] = useState<Set<number>>(new Set());

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

  const activeDoors = doors.filter((_, i) => !deletedRows.has(i));
  const warningCount = doors.reduce((count, d, i) => {
    return count + Object.keys(getWarnings(d, i)).length;
  }, 0);

  const handleConfirmAndSave = async () => {
    const finalDoors = doors.filter((_, i) => !deletedRows.has(i));
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
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.08] bg-[#1c1c1e]">
        <div>
          <h2 className="text-xl font-semibold text-[#f5f5f7]">
            Review Extracted Data
          </h2>
          <p className="text-sm text-[#a1a1a6] mt-1">
            {activeDoors.length} openings &middot; {sets.length} hardware sets
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

      {/* Error banner */}
      {error && (
        <div className="mx-6 mt-3 p-3 bg-[rgba(255,69,58,0.1)] border border-[rgba(255,69,58,0.2)] rounded-xl text-[#ff6961] text-sm">
          {error}
        </div>
      )}

      {/* Info banner */}
      <div className="mx-6 mt-3 p-3 bg-[rgba(10,132,255,0.08)] border border-[rgba(10,132,255,0.15)] rounded-xl text-[#0a84ff] text-sm">
        Click any cell to edit. Remove rows with the &times; button. This is your chance to fix any parsing errors before data is saved.
      </div>

      {/* Hardware Sets Panel (collapsible) */}
      {showSets && (
        <div className="mx-6 mt-3 max-h-48 overflow-y-auto bg-[#2c2c2e] rounded-xl border border-white/[0.08] p-4">
          <h3 className="text-sm font-semibold text-[#f5f5f7] mb-2">
            Hardware Sets ({sets.length})
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {sets.map((s) => (
              <div
                key={s.set_id}
                className={`p-2 rounded-lg text-xs ${
                  orphanedSets.includes(s)
                    ? "bg-[rgba(255,159,10,0.1)] border border-[rgba(255,159,10,0.2)] text-[#ff9f0a]"
                    : "bg-white/[0.04] text-[#a1a1a6]"
                }`}
              >
                <span className="font-semibold text-[#f5f5f7]">{s.set_id}</span>
                {" -- "}
                {s.heading || "No heading"}
                <span className="ml-1 text-[#6e6e73]">
                  ({s.items.length} item{s.items.length !== 1 ? "s" : ""})
                </span>
                {orphanedSets.includes(s) && (
                  <span className="ml-1 text-[#ff9f0a]">(orphaned)</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Table */}
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
              return (
                <tr
                  key={idx}
                  className={`border-b border-white/[0.04] ${
                    isDeleted
                      ? "opacity-30 line-through"
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
                      {isDeleted ? (
                        <span className="px-2 py-1 text-[#6e6e73]">
                          {door[col.key]}
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
                  <td className="px-2 py-1 text-center">
                    <button
                      onClick={() => toggleDeleteRow(idx)}
                      title={isDeleted ? "Restore row" : "Remove row"}
                      className={`w-6 h-6 rounded-full text-xs font-bold transition-colors ${
                        isDeleted
                          ? "bg-[rgba(48,209,88,0.15)] text-[#30d158] hover:bg-[rgba(48,209,88,0.25)]"
                          : "bg-[rgba(255,69,58,0.1)] text-[#ff6961] hover:bg-[rgba(255,69,58,0.2)]"
                      }`}
                    >
                      {isDeleted ? "\u21ba" : "\u00d7"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Footer: Add Row */}
      <div className="px-6 pb-4 flex justify-between items-center">
        <button
          onClick={addRow}
          disabled={saving}
          className="px-4 py-1.5 text-sm bg-white/[0.04] border border-white/[0.08] text-[#a1a1a6] rounded-lg hover:bg-white/[0.07] disabled:opacity-50 transition-colors"
        >
          + Add Row
        </button>
        <div className="text-xs text-[#6e6e73]">
          {activeDoors.length} opening{activeDoors.length !== 1 ? "s" : ""} will
          be saved &middot; {deletedRows.size > 0 && (
            <span className="text-[#ff9f0a]">
              {deletedRows.size} removed
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
