"use client";

import { useState, useCallback } from "react";
import { usePunchHighlight } from "./usePunchHighlight";
import type { DoorEntry, HardwareSet } from "./types";

function confidenceBadge(level: "high" | "medium" | "low") {
  switch (level) {
    case "high":
      return (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[rgba(48,209,88,0.15)] text-[#30d158]">
          High
        </span>
      );
    case "medium":
      return (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[rgba(255,149,0,0.15)] text-[#ff9500]">
          Med
        </span>
      );
    case "low":
      return (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[rgba(255,69,58,0.15)] text-[#ff453a]">
          Low
        </span>
      );
  }
}

// Simple heuristic: doors with all fields populated are "high", missing hw_set or door_number are "low", else "medium"
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

const FIELD_KEYS: (keyof DoorEntry)[] = [
  "door_number",
  "hw_set",
  "location",
  "door_type",
  "frame_type",
  "fire_rating",
  "hand",
];

const FIELD_LABELS: Record<keyof DoorEntry, string> = {
  door_number: "Door #",
  hw_set: "HW Set",
  location: "Location",
  door_type: "Door Type",
  frame_type: "Frame Type",
  fire_rating: "Fire Rating",
  hand: "Hand",
};

interface StepReviewProps {
  doors: DoorEntry[];
  hardwareSets: HardwareSet[];
  hasExistingData: boolean;
  onComplete: (doors: DoorEntry[], hardwareSets: HardwareSet[]) => void;
  onBack: () => void;
}

export default function StepReview({
  doors: initialDoors,
  hardwareSets,
  hasExistingData,
  onComplete,
  onBack,
}: StepReviewProps) {
  const { registerRef } = usePunchHighlight();
  const [doors, setDoors] = useState<DoorEntry[]>(initialDoors);
  const [editingCell, setEditingCell] = useState<{
    row: number;
    field: keyof DoorEntry;
  } | null>(null);
  const [editValue, setEditValue] = useState("");

  // ─── Inline editing ───
  const startEdit = useCallback(
    (rowIndex: number, field: keyof DoorEntry) => {
      setEditingCell({ row: rowIndex, field });
      setEditValue(doors[rowIndex][field]);
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

  // Stats
  const highCount = doors.filter((d) => getConfidence(d) === "high").length;
  const medCount = doors.filter((d) => getConfidence(d) === "medium").length;
  const lowCount = doors.filter((d) => getConfidence(d) === "low").length;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[#f5f5f7] font-semibold">Step 4: Review</h3>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-[#30d158]">{highCount} high</span>
          <span className="text-[#ff9500]">{medCount} med</span>
          <span className="text-[#ff453a]">{lowCount} low</span>
        </div>
      </div>
      <p className="text-[#a1a1a6] text-sm mb-4">
        Review extracted doors and hardware. Click any cell to edit.
        {hasExistingData && (
          <span className="text-[#ff9500] ml-1">
            (Revision mode: existing data will be compared on save.)
          </span>
        )}
      </p>

      {/* Table */}
      <div className="overflow-x-auto border border-white/[0.08] rounded-xl">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-white/[0.04]">
              <th className="px-2 py-2 text-left text-[10px] text-[#6e6e73] uppercase font-semibold w-10">
                #
              </th>
              {FIELD_KEYS.map((field) => (
                <th
                  key={field}
                  className="px-2 py-2 text-left text-[10px] text-[#6e6e73] uppercase font-semibold"
                >
                  {FIELD_LABELS[field]}
                </th>
              ))}
              <th className="px-2 py-2 text-center text-[10px] text-[#6e6e73] uppercase font-semibold w-14">
                Conf.
              </th>
            </tr>
          </thead>
          <tbody>
            {doors.map((door, rowIdx) => {
              const conf = getConfidence(door);
              return (
                <tr
                  key={`${door.door_number}-${rowIdx}`}
                  ref={(el) => {
                    if (door.door_number) registerRef(door.door_number, el);
                  }}
                  className="border-t border-white/[0.04] hover:bg-white/[0.02]"
                >
                  <td className="px-2 py-1.5 text-[#6e6e73] text-xs">
                    {rowIdx + 1}
                  </td>
                  {FIELD_KEYS.map((field) => {
                    const isEditing =
                      editingCell?.row === rowIdx &&
                      editingCell?.field === field;
                    return (
                      <td key={field} className="px-2 py-1.5">
                        {isEditing ? (
                          <input
                            autoFocus
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={commitEdit}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitEdit();
                              if (e.key === "Escape") cancelEdit();
                            }}
                            className="w-full bg-white/[0.08] border border-[#0a84ff] rounded px-1.5 py-0.5 text-[#f5f5f7] text-xs focus:outline-none"
                          />
                        ) : (
                          <span
                            onClick={() => startEdit(rowIdx, field)}
                            className={`cursor-pointer text-xs font-mono ${
                              door[field]
                                ? "text-[#f5f5f7]"
                                : "text-[#6e6e73] italic"
                            }`}
                          >
                            {door[field] || "\u2014"}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td className="px-2 py-1.5 text-center">
                    {confidenceBadge(conf)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Hardware sets summary */}
      {hardwareSets.length > 0 && (
        <div className="mt-4">
          <h4 className="text-[#a1a1a6] text-xs font-semibold uppercase mb-2">
            Hardware Sets ({hardwareSets.length})
          </h4>
          <div className="flex flex-wrap gap-2">
            {hardwareSets.map((set) => (
              <div
                key={set.set_id}
                className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-2 py-1 text-xs"
              >
                <span className="text-[#0a84ff] font-mono">{set.set_id}</span>
                <span className="text-[#6e6e73] ml-1">
                  ({set.items.length} items)
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="flex justify-between mt-6">
        <button
          onClick={onBack}
          className="px-4 py-2 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] text-[#a1a1a6] rounded-lg transition-colors"
        >
          Back
        </button>
        <button
          onClick={() => onComplete(doors, hardwareSets)}
          className="px-6 py-2 bg-[#0a84ff] hover:bg-[#0975de] text-white rounded-lg transition-colors font-semibold"
        >
          Next
        </button>
      </div>
    </div>
  );
}
