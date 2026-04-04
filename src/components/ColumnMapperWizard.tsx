"use client";

import { useState, useMemo } from "react";

// ─── Types ───

export interface ColumnMapping {
  [field: string]: number;
}

export interface DetectMappingResponse {
  success: boolean;
  page_index: number;
  total_pages: number;
  headers: string[];
  auto_mapping: ColumnMapping;
  confidence_scores: Record<string, number>;
  avg_confidence?: number;
  low_confidence?: boolean;
  sample_rows: string[][];
  field_labels: Record<string, string>;
  detection_method: string;
  error?: string;
}

interface ColumnMapperWizardProps {
  data: DetectMappingResponse;
  onConfirm: (mapping: ColumnMapping) => void;
  onSkip: () => void;
}

// ─── Field metadata ───

const ALL_FIELDS = [
  "door_number",
  "hw_set",
  "hw_heading",
  "location",
  "door_type",
  "frame_type",
  "fire_rating",
  "hand",
];

const REQUIRED_FIELDS = ["door_number"];

const DEFAULT_FIELD_LABELS: Record<string, string> = {
  door_number: "Door Number",
  hw_set: "HW Set",
  hw_heading: "HW Heading",
  location: "Location",
  door_type: "Door Type",
  frame_type: "Frame Type",
  fire_rating: "Fire Rating",
  hand: "Hand/Swing",
};

// ─── Color for field badges ───

const FIELD_COLORS: Record<string, string> = {
  door_number: "#0a84ff",
  hw_set: "#30d158",
  hw_heading: "#bf5af2",
  location: "#ff9f0a",
  door_type: "#64d2ff",
  frame_type: "#ff6482",
  fire_rating: "#ff453a",
  hand: "#ffd60a",
};

// ─── Main Component ───

export default function ColumnMapperWizard({
  data,
  onConfirm,
  onSkip,
}: ColumnMapperWizardProps) {
  const fieldLabels = { ...DEFAULT_FIELD_LABELS, ...(data.field_labels || {}) };

  // Initialize mapping from auto-detection
  const [mapping, setMapping] = useState<ColumnMapping>(() => ({ ...data.auto_mapping }));

  // Which field is currently being assigned (user clicked a field button)
  const [activeField, setActiveField] = useState<string | null>(null);

  // Build reverse mapping: column index → field name
  const reverseMapping = useMemo(() => {
    const rev: Record<number, string> = {};
    for (const [field, colIdx] of Object.entries(mapping)) {
      rev[colIdx] = field;
    }
    return rev;
  }, [mapping]);

  // Check if required fields are mapped
  const canConfirm = REQUIRED_FIELDS.every((f) => f in mapping);

  // Assign a column to the active field
  const assignColumn = (colIdx: number) => {
    if (!activeField) return;

    setMapping((prev) => {
      const next = { ...prev };
      // Remove any existing assignment for this column
      for (const [field, idx] of Object.entries(next)) {
        if (idx === colIdx) {
          delete next[field];
        }
      }
      // Assign the active field to this column
      next[activeField] = colIdx;
      return next;
    });
    setActiveField(null);
  };

  // Unassign a field
  const unassignField = (field: string) => {
    setMapping((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  // Reset to auto-detected
  const resetMapping = () => {
    setMapping({ ...data.auto_mapping });
    setActiveField(null);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <h3 className="text-[#f5f5f7] text-lg font-semibold mb-1">
          Column Mapping
        </h3>
        <p className="text-[#a1a1a6] text-sm">
          Verify the auto-detected column assignments below. Click a field label,
          then click a column header to reassign.
          {data.page_index !== undefined && (
            <span className="text-[#6e6e73]">
              {" "}(Detected on page {data.page_index + 1} of {data.total_pages})
            </span>
          )}
        </p>
      </div>

      {/* Low confidence warning */}
      {data.low_confidence && (
        <div className="px-4 py-3 bg-[rgba(255,159,10,0.08)] border border-[rgba(255,159,10,0.3)] rounded-lg">
          <p className="text-[13px] text-[#ff9f0a] font-medium">
            Low confidence detection
          </p>
          <p className="text-[12px] text-[#a1a1a6] mt-1">
            The auto-detected mapping may be incorrect. Please verify each column
            assignment carefully, or click &quot;Skip&quot; to let the system auto-detect
            per chunk.
          </p>
        </div>
      )}

      {/* Field assignment panel */}
      <div className="flex flex-wrap gap-2">
        {ALL_FIELDS.map((field) => {
          const isMapped = field in mapping;
          const isActive = activeField === field;
          const isRequired = REQUIRED_FIELDS.includes(field);
          const confidence = data.confidence_scores[field];
          const color = FIELD_COLORS[field] || "#a1a1a6";

          return (
            <button
              key={field}
              onClick={() => setActiveField(isActive ? null : field)}
              className={`relative px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                isActive
                  ? "ring-2 ring-offset-1 ring-offset-black"
                  : ""
              }`}
              style={{
                borderColor: isMapped ? color : "rgba(255,255,255,0.08)",
                backgroundColor: isMapped
                  ? `${color}15`
                  : isActive
                  ? "rgba(255,255,255,0.06)"
                  : "rgba(255,255,255,0.02)",
                color: isMapped ? color : "#6e6e73",
                ...(isActive ? { ringColor: color } : {}),
              }}
            >
              {fieldLabels[field]}
              {isRequired && !isMapped && (
                <span className="text-[#ff453a] ml-1">*</span>
              )}
              {isMapped && (
                <span className="ml-1.5 opacity-60">
                  → Col {mapping[field] + 1}
                </span>
              )}
              {confidence !== undefined && isMapped && (
                <span className="ml-1 opacity-40">
                  ({Math.round(confidence * 100)}%)
                </span>
              )}
              {isMapped && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    unassignField(field);
                  }}
                  className="ml-1.5 opacity-40 hover:opacity-100"
                  title="Unassign"
                >
                  ×
                </button>
              )}
            </button>
          );
        })}
      </div>

      {activeField && (
        <p className="text-sm text-[#0a84ff] animate-pulse">
          Click a column header below to assign it as{" "}
          <strong>{fieldLabels[activeField]}</strong>
        </p>
      )}

      {/* Sample table */}
      <div className="overflow-x-auto rounded-xl border border-white/[0.08]">
        <table className="w-full text-sm">
          <thead>
            <tr>
              {data.headers.map((header, colIdx) => {
                const assignedField = reverseMapping[colIdx];
                const color = assignedField
                  ? FIELD_COLORS[assignedField] || "#a1a1a6"
                  : undefined;

                return (
                  <th
                    key={colIdx}
                    onClick={() => activeField && assignColumn(colIdx)}
                    className={`px-3 py-2 text-left font-medium whitespace-nowrap transition-all ${
                      activeField
                        ? "cursor-pointer hover:bg-white/[0.08]"
                        : ""
                    }`}
                    style={{
                      backgroundColor: color
                        ? `${color}15`
                        : "rgba(255,255,255,0.02)",
                      borderBottom: color
                        ? `2px solid ${color}`
                        : "1px solid rgba(255,255,255,0.06)",
                      color: color || "#a1a1a6",
                    }}
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-wider opacity-50">
                        Col {colIdx + 1}
                      </span>
                      <span>{header || "(empty)"}</span>
                      {assignedField && (
                        <span
                          className="text-[10px] font-bold uppercase tracking-wider"
                          style={{ color }}
                        >
                          → {fieldLabels[assignedField]}
                        </span>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {data.sample_rows.map((row, rowIdx) => (
              <tr
                key={rowIdx}
                className="border-t border-white/[0.04] hover:bg-white/[0.02]"
              >
                {data.headers.map((_, colIdx) => {
                  const val = row[colIdx] || "";
                  const assignedField = reverseMapping[colIdx];
                  const color = assignedField
                    ? FIELD_COLORS[assignedField]
                    : undefined;

                  return (
                    <td
                      key={colIdx}
                      className="px-3 py-1.5 text-[#f5f5f7] whitespace-nowrap max-w-[200px] truncate"
                      style={
                        color
                          ? { backgroundColor: `${color}08` }
                          : undefined
                      }
                    >
                      {val}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-2">
        <div className="flex gap-2">
          <button
            onClick={resetMapping}
            className="text-xs px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[#a1a1a6] hover:bg-white/[0.08] transition-colors"
          >
            Reset to Auto-Detect
          </button>
          <button
            onClick={onSkip}
            className="text-xs px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[#6e6e73] hover:bg-white/[0.08] transition-colors"
          >
            Skip (use auto-detect)
          </button>
        </div>
        <button
          onClick={() => onConfirm(mapping)}
          disabled={!canConfirm}
          className="px-5 py-2 rounded-lg bg-[#30d158] hover:bg-[#26c14a] text-white font-semibold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Confirm Mapping
        </button>
      </div>
    </div>
  );
}
