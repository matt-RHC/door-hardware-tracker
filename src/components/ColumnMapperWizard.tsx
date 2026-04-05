"use client";

import { useState, useMemo, useCallback } from "react";
import PDFPageBrowser from "./PDFPageBrowser";

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

type WizardPhase = "step1" | "pageBrowser" | "step2" | "step3";

interface ColumnMapperWizardProps {
  data: DetectMappingResponse;
  pdfBuffer?: ArrayBuffer;
  pageCount?: number;
  onConfirm: (mapping: ColumnMapping) => void;
  onSkip: () => void;
  onRedetect?: (pageIndex: number) => Promise<DetectMappingResponse | null>;
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
  hw_set: "Hardware Set",
  hw_heading: "Hardware Heading",
  location: "Location",
  door_type: "Door Type",
  frame_type: "Frame Type",
  fire_rating: "Fire Rating",
  hand: "Hand / Swing",
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

// ─── Step indicator component ───

function StepIndicator({ currentStep, totalSteps }: { currentStep: number; totalSteps: number }) {
  return (
    <div className="flex items-center justify-center gap-3 mb-8">
      {Array.from({ length: totalSteps }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div
            className="flex items-center justify-center w-10 h-10 rounded-full font-display font-bold text-sm transition-all"
            style={{
              backgroundColor: i === currentStep ? "rgba(90,200,250,0.2)" : "rgba(255,255,255,0.03)",
              borderColor: i === currentStep ? "rgba(90,200,250,0.5)" : "rgba(255,255,255,0.1)",
              borderWidth: "1px",
              color: i === currentStep ? "#5ac8fa" : "#636366",
              boxShadow: i === currentStep ? "0 0 12px rgba(90,200,250,0.2)" : "none",
            }}
          >
            {i + 1}
          </div>
          {i < totalSteps - 1 && (
            <div className="w-8 h-px" style={{
              background: i < currentStep
                ? "linear-gradient(90deg, #5ac8fa, rgba(90,200,250,0.3))"
                : "rgba(255,255,255,0.1)"
            }} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Step 1: Identify Table ───

function Step1IdentifyTable({
  data,
  onConfirm,
  onSkip,
}: {
  data: DetectMappingResponse;
  onConfirm: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="space-y-6 animate-fade-in-up">
      <div>
        <h2 className="font-display text-2xl font-bold text-white mb-2">
          VERIFY YOUR DOOR SCHEDULE
        </h2>
        <p className="text-sm text-[#a1a1a6] leading-relaxed">
          We found a table in your submittal that looks like the master door list.
          Check that the preview below shows <span className="text-[#e8e8ed] font-medium">door numbers</span>,{" "}
          <span className="text-[#e8e8ed] font-medium">hardware sets</span>, and other door info
          — not a hardware set detail page or cover sheet.
        </p>
        {data.page_index !== undefined && (
          <p className="text-xs text-[#636366] mt-2">
            Found on page {data.page_index + 1} of {data.total_pages}
          </p>
        )}
      </div>

      {/* What happens next */}
      <div className="p-3 rounded-lg bg-[rgba(90,200,250,0.06)] border border-[rgba(90,200,250,0.15)]">
        <p className="text-xs text-[#5ac8fa]">
          <strong>Next step:</strong> After you confirm, you&apos;ll be able to tell us which column is
          which (Door Number, Fire Rating, etc.) so we parse everything correctly.
        </p>
      </div>

      {/* Low confidence warning */}
      {data.low_confidence && (
        <div className="p-4 rounded-lg bg-[rgba(255,159,10,0.08)] border border-[rgba(255,159,10,0.25)]">
          <p className="text-[#ff9f0a] font-semibold text-sm mb-1">
            Low Confidence Detection
          </p>
          <p className="text-xs text-[#a1a1a6]">
            We&apos;re not very confident this is the right table. Review it carefully,
            or click &quot;Not the right table&quot; to skip.
          </p>
        </div>
      )}

      {/* Sample table - dark theme, scrollable */}
      <div
        className="rounded-lg border border-[rgba(255,255,255,0.08)] overflow-hidden flex flex-col"
        style={{ maxHeight: "420px", backgroundColor: "rgba(10,10,14,0.95)" }}
      >
        <div className="overflow-auto flex-1">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10">
              <tr>
                {data.headers.map((header, idx) => (
                  <th
                    key={idx}
                    className="px-3 py-3 text-left font-semibold whitespace-nowrap border-b"
                    style={{
                      color: "#5ac8fa",
                      backgroundColor: "rgba(10,10,14,0.98)",
                      borderBottomColor: "rgba(90,200,250,0.25)",
                    }}
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-widest text-[#4a4a4e]">
                        Col {idx + 1}
                      </span>
                      <span className="text-sm">{header || "(empty)"}</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.sample_rows.map((row, rowIdx) => (
                <tr
                  key={rowIdx}
                  style={{
                    backgroundColor: rowIdx % 2 === 0
                      ? "rgba(255,255,255,0.02)"
                      : "rgba(0,0,0,0.15)",
                    borderBottom: "1px solid rgba(255,255,255,0.05)",
                  }}
                >
                  {data.headers.map((_, colIdx) => (
                    <td
                      key={colIdx}
                      className="px-3 py-2.5 text-sm max-w-[200px] truncate"
                      style={{ color: "#d1d1d6" }}
                    >
                      {row[colIdx] || "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between pt-4 gap-4">
        <div className="flex flex-col items-start gap-1">
          <button onClick={onSkip} className="glow-btn glow-btn--ghost">
            Not the right table
          </button>
          <span className="text-[10px] text-[#4a4a4e] ml-1">
            Skip to auto-detect per page
          </span>
        </div>
        <button onClick={onConfirm} className="glow-btn glow-btn--primary">
          Looks Good, Map Columns
        </button>
      </div>
    </div>
  );
}

// ─── Step 2: Map Columns ───

function Step2MapColumns({
  data,
  mapping,
  activeField,
  onFieldClick,
  onColumnClick,
  onReset,
  onConfirm,
  onBack,
  fieldLabels,
}: {
  data: DetectMappingResponse;
  mapping: ColumnMapping;
  activeField: string | null;
  onFieldClick: (field: string | null) => void;
  onColumnClick: (colIdx: number) => void;
  onReset: () => void;
  onConfirm: () => void;
  onBack: () => void;
  fieldLabels: Record<string, string>;
}) {
  // Reverse mapping: column index → field name
  const reverseMapping = useMemo(() => {
    const rev: Record<number, string> = {};
    for (const [field, colIdx] of Object.entries(mapping)) {
      rev[colIdx] = field;
    }
    return rev;
  }, [mapping]);

  // Check if required fields are mapped
  const canConfirm = REQUIRED_FIELDS.every((f) => f in mapping);

  // Unassign a field
  const unassignField = (field: string) => {
    // This is handled by parent, but we show it in UI
  };

  const getFieldGlowClass = (field: string): string => {
    const colorMap: Record<string, string> = {
      door_number: "glow-card--blue",
      hw_set: "glow-card--green",
      hw_heading: "glow-card--purple",
      location: "glow-card--orange",
      door_type: "glow-card",
      frame_type: "glow-card--red",
      fire_rating: "glow-card--red",
      hand: "glow-card",
    };
    return colorMap[field] || "glow-card";
  };

  return (
    <div className="space-y-6 animate-fade-in-up">
      <div>
        <h2 className="font-display text-2xl font-bold text-white mb-2">
          MAP YOUR COLUMNS
        </h2>
        <p className="text-sm text-[#a1a1a6] leading-relaxed">
          We pre-filled our best guesses below — fix any that look wrong.
          Only <span className="text-[#ff453a] font-medium">Door Number</span> is required.
          Map as many other fields as your PDF has.
        </p>
        <div className="mt-3 p-3 rounded-lg bg-[rgba(90,200,250,0.06)] border border-[rgba(90,200,250,0.15)]">
          <p className="text-xs text-[#5ac8fa] leading-relaxed">
            <strong>1.</strong> Click a field on the left to select it.{" "}
            <strong>2.</strong> Click the matching column on the right to assign it.
            Already-assigned fields show their column number — click them again to reassign.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6 min-h-[500px]">
        {/* Left: Field cards */}
        <div className="space-y-3">
          <div className="text-xs uppercase tracking-widest text-[#636366] font-semibold mb-3 ml-1">
            1. Pick a Field
          </div>
          <div className="stagger-children space-y-2">
            {ALL_FIELDS.map((field) => {
              const isMapped = field in mapping;
              const isActive = activeField === field;
              const isRequired = REQUIRED_FIELDS.includes(field);
              const confidence = data.confidence_scores[field];
              const color = FIELD_COLORS[field];
              const glowClass = getFieldGlowClass(field);

              return (
                <button
                  key={field}
                  onClick={() => onFieldClick(isActive ? null : field)}
                  className={`glow-card ${glowClass} w-full p-4 text-left transition-all ${
                    isActive ? "ring-2 ring-offset-2 ring-offset-[#050508] scale-105" : ""
                  }`}
                  style={{
                    minHeight: "56px",
                    boxShadow: isActive
                      ? `0 0 20px ${color}40, inset 0 0 12px ${color}08`
                      : "none",
                  }}
                >
                  <div className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className="font-semibold text-sm"
                        style={{ color: "#f5f5f7", textShadow: "0 1px 4px rgba(0,0,0,0.6)" }}
                      >
                        {fieldLabels[field]}
                      </span>
                      {isRequired && <span className="text-[#ff453a]">*</span>}
                    </div>
                    {isMapped && (
                      <div className="text-xs" style={{ color }}>
                        <strong>→ Column {mapping[field] + 1}</strong>
                        {confidence !== undefined && (
                          <span className="ml-1 opacity-60">({Math.round(confidence * 100)}%)</span>
                        )}
                      </div>
                    )}
                    {!isMapped && (
                      <p className="text-xs text-[#8e8e93]">Click to assign column</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right: Column headers */}
        <div className="space-y-3">
          <div className="text-xs uppercase tracking-widest text-[#636366] font-semibold mb-3 ml-1">
            2. Assign to a Column
          </div>
          <div className="stagger-children space-y-2 max-h-[600px] overflow-y-auto">
            {data.headers.map((header, colIdx) => {
              const assignedField = reverseMapping[colIdx];
              const color = assignedField
                ? FIELD_COLORS[assignedField]
                : "#636366";
              const isSelectable = activeField !== null;

              return (
                <button
                  key={colIdx}
                  onClick={() => isSelectable && onColumnClick(colIdx)}
                  disabled={!isSelectable}
                  className={`glow-card p-4 w-full text-left transition-all min-h-[56px] ${
                    isSelectable
                      ? "cursor-pointer hover:scale-102"
                      : "opacity-60 cursor-default"
                  }`}
                  style={{
                    borderLeftColor: assignedField ? color : "rgba(255,255,255,0.08)",
                    background: assignedField
                      ? `${color}12`
                      : "rgba(255,255,255,0.02)",
                    boxShadow: isSelectable && activeField
                      ? "inset 0 0 8px rgba(90,200,250,0.1)"
                      : "none",
                  }}
                >
                  <div className="space-y-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs uppercase tracking-widest text-[#636366]">
                        Col {colIdx + 1}
                      </span>
                      <span className="text-sm font-semibold text-[#e8e8ed] flex-1 truncate">
                        {header || "(empty)"}
                      </span>
                    </div>
                    {assignedField && (
                      <div className="text-xs" style={{ color }}>
                        <strong>→ {fieldLabels[assignedField]}</strong>
                      </div>
                    )}
                    {data.sample_rows.length > 0 && (() => {
                      const nonEmpty = data.sample_rows
                        .map((row, rIdx) => ({ val: row[colIdx]?.trim(), rIdx }))
                        .filter((r) => r.val);
                      const total = data.sample_rows.length;

                      if (nonEmpty.length === 0) {
                        return (
                          <div className="mt-1.5 p-2 rounded bg-[rgba(255,69,58,0.08)] border border-[rgba(255,69,58,0.2)]">
                            <p className="text-[11px] text-[#ff453a] font-medium">
                              All {total} sample rows are empty
                            </p>
                            <p className="text-[10px] text-[#636366] mt-0.5">
                              This column may not have data in your PDF
                            </p>
                          </div>
                        );
                      }

                      return (
                        <div className="mt-1">
                          <p className="text-[10px] text-[#4a4a4e] mb-1">
                            {nonEmpty.length} of {total} rows have data
                          </p>
                          <div className="space-y-0.5">
                            {nonEmpty.map(({ val, rIdx }) => (
                              <p key={rIdx} className="text-[11px] text-[#8e8e93] truncate">
                                <span className="text-[#4a4a4e] mr-1">r{rIdx + 1}</span>
                                {val}
                              </p>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Status message */}
      {activeField ? (
        <div className="p-3 rounded-lg bg-[rgba(90,200,250,0.1)] border border-[rgba(90,200,250,0.2)]">
          <p className="text-sm text-[#5ac8fa]">
            Assigning <strong>{fieldLabels[activeField]}</strong> — click a column on the right to assign it
          </p>
        </div>
      ) : (
        <div className="p-3 rounded-lg bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.08)]">
          <p className="text-sm text-[#636366]">
            Select a field on the left to begin mapping
          </p>
        </div>
      )}

      {/* Validation message */}
      {!canConfirm && (
        <div className="p-3 rounded-lg bg-[rgba(255,69,58,0.1)] border border-[rgba(255,69,58,0.2)]">
          <p className="text-sm text-[#ff453a]">
            <strong>Required field missing:</strong> Door Number must be mapped before confirming.
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between pt-4 gap-4 border-t border-[rgba(255,255,255,0.06)] pt-6">
        <div className="flex gap-2">
          <button onClick={onReset} className="glow-btn glow-btn--ghost text-xs">
            Reset Mappings
          </button>
          <button onClick={onBack} className="glow-btn glow-btn--ghost">
            Back
          </button>
        </div>
        <button
          onClick={onConfirm}
          disabled={!canConfirm}
          className="glow-btn glow-btn--primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

// ─── Step 3: Confirm ───

function Step3Confirm({
  data,
  mapping,
  onConfirm,
  onBack,
  fieldLabels,
}: {
  data: DetectMappingResponse;
  mapping: ColumnMapping;
  onConfirm: () => void;
  onBack: () => void;
  fieldLabels: Record<string, string>;
}) {
  // Reverse mapping
  const reverseMapping = useMemo(() => {
    const rev: Record<number, string> = {};
    for (const [field, colIdx] of Object.entries(mapping)) {
      rev[colIdx] = field;
    }
    return rev;
  }, [mapping]);

  return (
    <div className="space-y-6 animate-fade-in-up">
      <div>
        <h2 className="font-display text-2xl font-bold text-white mb-2">
          CONFIRM & EXTRACT
        </h2>
        <p className="text-sm text-[#a1a1a6] leading-relaxed">
          Review the mapping below. The preview shows how your data will be read.
          When everything looks right, hit <span className="text-[#e8e8ed] font-medium">Confirm &amp; Extract</span> to
          start parsing your submittal.
        </p>
        <p className="text-xs text-[#636366] mt-2">
          You&apos;ll review all extracted data before anything is saved to your project.
        </p>
      </div>

      {/* Summary table showing all assignments */}
      <div className="glow-card p-6">
        <div className="mb-4">
          <h3 className="font-semibold text-sm text-[#e8e8ed] mb-3">
            Field Assignments
          </h3>
          <div className="space-y-2">
            {Object.entries(mapping).map(([field, colIdx]) => {
              const color = FIELD_COLORS[field];
              const confidence = data.confidence_scores[field];

              return (
                <div
                  key={field}
                  className="flex items-center justify-between p-3 rounded border"
                  style={{
                    backgroundColor: `${color}08`,
                    borderColor: `${color}20`,
                  }}
                >
                  <div className="flex-1">
                    <div className="font-semibold text-sm" style={{ color }}>
                      {fieldLabels[field]}
                    </div>
                    <div className="text-xs text-[#8e8e93] mt-1">
                      Column {colIdx + 1}: <strong>{data.headers[colIdx]}</strong>
                    </div>
                    {confidence !== undefined && (
                      <div className="text-xs text-[#8e8e93] mt-0.5">
                        Confidence: {Math.round(confidence * 100)}%
                      </div>
                    )}
                  </div>
                  {data.sample_rows.length > 0 && (
                    <div className="text-right text-xs text-[#636366] max-w-[150px] truncate">
                      Sample: &quot;{data.sample_rows[0][colIdx]}&quot;
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Sample data preview table */}
      {data.sample_rows.length > 0 && (
        <div className="glow-card p-4">
          <div className="text-xs uppercase tracking-widest text-[#636366] font-semibold mb-3">
            Preview with Extracted Data
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  {Object.entries(mapping).map(([field, colIdx]) => {
                    const color = FIELD_COLORS[field];
                    return (
                      <th
                        key={field}
                        className="px-2 py-2 text-left font-semibold whitespace-nowrap"
                        style={{
                          color,
                          backgroundColor: `${color}08`,
                          borderBottom: `2px solid ${color}30`,
                        }}
                      >
                        {fieldLabels[field]}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {data.sample_rows.map((row, rowIdx) => (
                  <tr
                    key={rowIdx}
                    className={`border-b border-[rgba(255,255,255,0.04)] ${
                      rowIdx % 2 === 0 ? "bg-[rgba(255,255,255,0.01)]" : ""
                    }`}
                  >
                    {Object.entries(mapping).map(([field, colIdx]) => (
                      <td key={`${rowIdx}-${field}`}
                          className="px-2 py-2 text-[#e8e8ed] truncate max-w-[150px]">
                        {row[colIdx] || "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between pt-4 gap-4 border-t border-[rgba(255,255,255,0.06)] pt-6">
        <button onClick={onBack} className="glow-btn glow-btn--ghost">
          Back
        </button>
        <button onClick={onConfirm} className="glow-btn glow-btn--primary glow-btn--success">
          Confirm & Extract
        </button>
      </div>
    </div>
  );
}

// ─── Main Component ───

export default function ColumnMapperWizard({
  data,
  pdfBuffer,
  pageCount: pageCountProp,
  onConfirm: onConfirmProp,
  onSkip: onSkipProp,
  onRedetect,
}: ColumnMapperWizardProps) {
  // Frontend labels take priority over backend's (which may have abbreviations)
  const fieldLabels = { ...(data.field_labels || {}), ...DEFAULT_FIELD_LABELS };

  // Wizard state — phase-based instead of numeric steps
  const [phase, setPhase] = useState<WizardPhase>("step1");
  const [currentData, setCurrentData] = useState<DetectMappingResponse>(data);
  const [mapping, setMapping] = useState<ColumnMapping>(() => ({ ...data.auto_mapping }));
  const [activeField, setActiveField] = useState<string | null>(null);
  const [redetecting, setRedetecting] = useState(false);
  const [redetectError, setRedetectError] = useState<string | null>(null);

  // Step indicator position
  const stepIndex = phase === "step1" || phase === "pageBrowser" ? 0 : phase === "step2" ? 1 : 2;

  // Step 1 handlers
  const handleStep1Confirm = useCallback(() => {
    setPhase("step2");
    const firstUnmapped = REQUIRED_FIELDS.find((f) => !(f in mapping));
    setActiveField(firstUnmapped ?? REQUIRED_FIELDS[0] ?? null);
  }, [mapping]);

  const handleStep1Skip = useCallback(() => {
    // If page browser is available, go there instead of skipping entirely
    if (pdfBuffer && onRedetect) {
      setPhase("pageBrowser");
    } else {
      onSkipProp();
    }
  }, [pdfBuffer, onRedetect, onSkipProp]);

  // Page browser handler
  const handlePageSelect = useCallback(async (pageIndex: number) => {
    if (!onRedetect) return;
    setRedetecting(true);
    setRedetectError(null);
    try {
      const result = await onRedetect(pageIndex);
      if (result?.success && (result.headers?.length ?? 0) > 0) {
        setCurrentData(result);
        setMapping({ ...result.auto_mapping });
        setActiveField(null);
        setPhase("step1");
      } else {
        setRedetectError(
          `No door schedule found on page ${pageIndex + 1}. Try selecting a different page.`
        );
      }
    } catch {
      setRedetectError("Detection failed. Try a different page.");
    } finally {
      setRedetecting(false);
    }
  }, [onRedetect]);

  const handlePageBrowserCancel = useCallback(() => {
    setRedetectError(null);
    setPhase("step1");
  }, []);

  // Step 2 handlers
  const handleFieldClick = useCallback((field: string | null) => {
    if (field === null) {
      setActiveField(null);
    } else {
      setActiveField((prev) => (prev === field ? null : field));
    }
  }, []);

  const handleColumnClick = useCallback((colIdx: number) => {
    if (!activeField) return;

    setMapping((prev) => {
      const next = { ...prev };
      for (const [field, idx] of Object.entries(next)) {
        if (idx === colIdx) {
          delete next[field];
        }
      }
      next[activeField] = colIdx;
      return next;
    });
    setActiveField(null);
  }, [activeField]);

  const handleReset = useCallback(() => {
    setMapping({ ...currentData.auto_mapping });
    setActiveField(null);
  }, [currentData.auto_mapping]);

  const handleStep2Confirm = useCallback(() => {
    setPhase("step3");
  }, []);

  const handleStep2Back = useCallback(() => {
    setPhase("step1");
  }, []);

  // Step 3 handlers
  const handleStep3Confirm = useCallback(() => {
    onConfirmProp(mapping);
  }, [mapping, onConfirmProp]);

  const handleStep3Back = useCallback(() => {
    setPhase("step2");
  }, []);

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div
        className="panel corner-brackets relative w-full max-w-6xl max-h-[90vh] overflow-y-auto p-8 md:p-10"
        style={{
          backgroundColor: "rgba(12,12,16,0.98)",
          backdropFilter: "blur(30px)",
        }}
      >
        {/* Step indicator */}
        <StepIndicator currentStep={stepIndex} totalSteps={3} />

        {/* Phase content */}
        <div className="relative">
          {phase === "step1" && (
            <Step1IdentifyTable
              data={currentData}
              onConfirm={handleStep1Confirm}
              onSkip={handleStep1Skip}
            />
          )}
          {phase === "pageBrowser" && pdfBuffer && (
            <>
              <PDFPageBrowser
                pdfBuffer={pdfBuffer}
                pageCount={pageCountProp ?? currentData.total_pages}
                onSelectPage={handlePageSelect}
                onCancel={handlePageBrowserCancel}
                loading={redetecting}
              />
              {redetectError && (
                <div className="mt-4 p-3 rounded-lg bg-[rgba(255,69,58,0.1)] border border-[rgba(255,69,58,0.2)]">
                  <p className="text-sm text-[#ff453a]">{redetectError}</p>
                </div>
              )}
            </>
          )}
          {phase === "step2" && (
            <Step2MapColumns
              data={currentData}
              mapping={mapping}
              activeField={activeField}
              onFieldClick={handleFieldClick}
              onColumnClick={handleColumnClick}
              onReset={handleReset}
              onConfirm={handleStep2Confirm}
              onBack={handleStep2Back}
              fieldLabels={fieldLabels}
            />
          )}
          {phase === "step3" && (
            <Step3Confirm
              data={currentData}
              mapping={mapping}
              onConfirm={handleStep3Confirm}
              onBack={handleStep3Back}
              fieldLabels={fieldLabels}
            />
          )}
        </div>
      </div>
    </div>
  );
}
