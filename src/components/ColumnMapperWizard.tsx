"use client";

import { useState, useMemo, useCallback } from "react";
import PDFPageBrowser from "./PDFPageBrowser";
import type { PunchyObservation } from "@/lib/types";

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

type WizardPhase = "pageBrowser" | "step2" | "step3";

interface ColumnMapperWizardProps {
  data: DetectMappingResponse;
  pdfBuffer?: ArrayBuffer;
  pageCount?: number;
  punchyObservations?: PunchyObservation[];
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
  hw_set: "Hardware Heading",
  hw_heading: "Hardware Subheading",
  location: "Location",
  door_type: "Door Type",
  frame_type: "Frame Type",
  fire_rating: "Fire Rating",
  hand: "Hand / Swing",
};

// ─── Color for field badges ───

const FIELD_COLORS: Record<string, string> = {
  door_number: "var(--blue)",
  hw_set: "var(--green)",
  hw_heading: "var(--purple)",
  location: "var(--orange)",
  door_type: "var(--blue)",
  frame_type: "var(--red)",
  fire_rating: "var(--red)",
  hand: "var(--yellow)",
};

// ─── Punchy Column Suggestions ───

function PunchySuggestions({
  observations,
  onAccept,
  onDismiss,
}: {
  observations: PunchyObservation[];
  onAccept: (field: string) => void;
  onDismiss: (idx: number) => void;
}) {
  // Filter to only observations that have field_suggestions
  const withSuggestions = observations
    .map((obs, idx) => ({ obs, idx }))
    .filter(({ obs }) => (obs.field_suggestions?.length ?? 0) > 0);

  const [dismissed, setDismissed] = useState<Set<number>>(new Set());

  if (withSuggestions.length === 0) return null;

  const visible = withSuggestions.filter(({ idx }) => !dismissed.has(idx));
  if (visible.length === 0) return null;

  return (
    <div className="mb-4 space-y-2">
      {visible.map(({ obs, idx }) => (
        <div
          key={`ps-${idx}`}
          className="p-3 rounded-lg flex items-start gap-3"
          style={{
            backgroundColor: 'var(--blue-dim)',
            border: '1px solid var(--blue-dim)',
          }}
        >
          <span className="text-lg shrink-0">🤖</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-info font-medium" style={{ fontFamily: "'Orbitron', sans-serif" }}>
              Punchy found unmapped fields
            </p>
            <div className="mt-1.5 space-y-1">
              {(obs.field_suggestions ?? []).map((sug, si) => (
                <div key={si} className="flex items-center gap-2 text-xs">
                  <span className="text-primary">
                    <strong className="text-info">{sug.field}</strong>
                    {sug.column ? ` in column ${sug.column}` : ''}
                    {sug.pages ? ` (pages ${sug.pages})` : ''}
                    {sug.suggestion ? ` — ${sug.suggestion}` : ''}
                  </span>
                  <button
                    onClick={() => onAccept(sug.field)}
                    className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide transition-colors"
                    style={{
                      backgroundColor: 'var(--green-dim)',
                      color: 'var(--green)',
                      border: '1px solid var(--green-dim)',
                    }}
                  >
                    Map it
                  </button>
                </div>
              ))}
            </div>
          </div>
          <button
            onClick={() => {
              setDismissed(prev => new Set([...prev, idx]));
              onDismiss(idx);
            }}
            className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs text-tertiary hover:text-secondary hover:bg-tint transition-colors"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── Step indicator component ───

function StepIndicator({ currentStep, totalSteps }: { currentStep: number; totalSteps: number }) {
  return (
    <div className="flex items-center justify-center gap-3 mb-8">
      {Array.from({ length: totalSteps }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div
            className="flex items-center justify-center w-10 h-10 rounded-full font-display font-bold text-sm transition-all"
            style={{
              backgroundColor: i === currentStep ? "var(--blue-dim)" : "var(--tint)",
              borderColor: i === currentStep ? "var(--blue)" : "var(--tint-strong)",
              borderWidth: "1px",
              color: i === currentStep ? "var(--blue)" : "var(--text-tertiary)",
              boxShadow: i === currentStep ? "0 0 12px var(--blue-dim)" : "none",
            }}
          >
            {i + 1}
          </div>
          {i < totalSteps - 1 && (
            <div className="w-8 h-px" style={{
              background: i < currentStep
                ? "linear-gradient(90deg, var(--blue), var(--blue-dim))"
                : "var(--tint-strong)"
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
        <h2 className="font-display text-2xl font-bold text-primary mb-2">
          VERIFY YOUR DOOR SCHEDULE
        </h2>
        <p className="text-sm text-secondary leading-relaxed">
          We found a table in your submittal that looks like the master door list.
          Check that the preview below shows <span className="text-primary font-medium">door numbers</span>,{" "}
          <span className="text-primary font-medium">hardware sets</span>, and other door info
          — not a hardware set detail page or cover sheet.
        </p>
        {data.page_index !== undefined && (
          <p className="text-xs text-tertiary mt-2">
            Found on page {data.page_index + 1} of {data.total_pages}
          </p>
        )}
      </div>

      {/* What happens next */}
      <div className="p-3 rounded-lg bg-accent-dim border border-accent-dim">
        <p className="text-xs text-info">
          <strong>Next step:</strong> After you confirm, you&apos;ll be able to tell us which column is
          which (Door Number, Fire Rating, etc.) so we parse everything correctly.
        </p>
      </div>

      {/* Low confidence warning */}
      {data.low_confidence && (
        <div className="p-4 rounded-lg bg-warning-dim border border-warning-dim">
          <p className="text-warning font-semibold text-sm mb-1">
            Low Confidence Detection
          </p>
          <p className="text-xs text-secondary">
            We&apos;re not very confident this is the right table. Review it carefully,
            or click &quot;Not the right table&quot; to skip.
          </p>
        </div>
      )}

      {/* Sample table - dark theme, scrollable */}
      <div
        className="rounded-lg border border-border-dim-strong overflow-hidden flex flex-col"
        style={{ maxHeight: "420px", backgroundColor: "var(--background)" }}
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
                      color: "var(--blue)",
                      backgroundColor: "var(--background)",
                      borderBottomColor: "var(--blue-dim)",
                    }}
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[10px] uppercase tracking-widest text-tertiary">
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
                      ? "var(--tint)"
                      : "var(--tint-strong)",
                    borderBottom: "1px solid var(--tint)",
                  }}
                >
                  {data.headers.map((_, colIdx) => (
                    <td
                      key={colIdx}
                      className="px-3 py-2.5 text-sm max-w-[200px] truncate"
                      style={{ color: "var(--text-secondary)" }}
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
          <span className="text-[10px] text-tertiary ml-1">
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
  skippedFields,
  onToggleSkip,
  punchyObservations,
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
  skippedFields: Set<string>;
  onToggleSkip: (field: string) => void;
  punchyObservations?: PunchyObservation[];
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
        <h2 className="font-display text-2xl font-bold text-primary mb-2">
          MAP YOUR COLUMNS
        </h2>
        <p className="text-sm text-secondary leading-relaxed">
          We pre-filled our best guesses below — fix any that look wrong.
          Only <span className="text-danger font-medium">Door Number</span> is required.
          Map as many other fields as your PDF has.
        </p>
        <div className="mt-3 p-3 rounded-lg bg-accent-dim border border-accent-dim">
          <p className="text-xs text-info leading-relaxed">
            <strong>1.</strong> Click a field on the left to select it.{" "}
            <strong>2.</strong> Click the matching column on the right to assign it.
            Already-assigned fields show their column number — click them again to reassign.
          </p>
        </div>
      </div>

      {/* Punchy suggestions for unmapped fields */}
      {(punchyObservations?.length ?? 0) > 0 && (
        <PunchySuggestions
          observations={punchyObservations ?? []}
          onAccept={(field) => {
            // Select the field for mapping
            if (ALL_FIELDS.includes(field)) {
              onFieldClick(field);
            }
          }}
          onDismiss={() => { /* dismissed via internal state */ }}
        />
      )}

      <div className="grid grid-cols-2 gap-6 min-h-[500px]">
        {/* Left: Field cards */}
        <div className="space-y-3">
          <div className="text-xs uppercase tracking-widest text-tertiary font-semibold mb-3 ml-1">
            1. Pick a Field
          </div>
          <div className="stagger-children space-y-2">
            {ALL_FIELDS.map((field) => {
              const isMapped = field in mapping;
              const isSkipped = skippedFields.has(field);
              const isActive = activeField === field;
              const isRequired = REQUIRED_FIELDS.includes(field);
              const confidence = data.confidence_scores[field];
              const color = FIELD_COLORS[field];

              return (
                <div key={field} className="flex gap-1.5">
                  <button
                    onClick={() => {
                      if (isSkipped) return;
                      onFieldClick(isActive ? null : field);
                    }}
                    className={`flex-1 rounded-lg p-3 text-left transition-all ${
                      isActive ? "ring-2 ring-info scale-[1.02]" : ""
                    }`}
                    style={{
                      backgroundColor: isSkipped
                        ? "var(--tint)"
                        : `${color}10`,
                      border: `1px solid ${isSkipped ? "var(--border-dim)" : `${color}25`}`,
                      opacity: isSkipped ? 0.5 : 1,
                    }}
                    disabled={isSkipped}
                  >
                    <div className="space-y-0.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span
                          className="font-semibold text-sm"
                          style={{
                            color: isSkipped ? "var(--text-tertiary)" : color,
                            textDecoration: isSkipped ? "line-through" : "none",
                          }}
                        >
                          {fieldLabels[field]}
                        </span>
                        {isRequired && !isSkipped && (
                          <span className="text-danger text-xs">required</span>
                        )}
                      </div>
                      {isSkipped && (
                        <p className="text-xs text-tertiary italic">Not in this table</p>
                      )}
                      {!isSkipped && isMapped && (
                        <div className="text-xs" style={{ color }}>
                          <strong>→ Column {mapping[field] + 1}</strong>
                          {confidence !== undefined && (
                            <span className="ml-1 opacity-60">({Math.round(confidence * 100)}%)</span>
                          )}
                        </div>
                      )}
                      {!isSkipped && !isMapped && (
                        <p className="text-xs text-tertiary">Click to assign</p>
                      )}
                    </div>
                  </button>
                  {!isRequired && (
                    <button
                      onClick={() => onToggleSkip(field)}
                      className="flex-shrink-0 w-8 rounded-lg flex items-center justify-center text-xs transition-all"
                      style={{
                        backgroundColor: isSkipped
                          ? "var(--blue-dim)"
                          : "var(--tint)",
                        border: "1px solid var(--tint-strong)",
                        color: isSkipped ? "var(--blue)" : "var(--text-tertiary)",
                      }}
                      title={isSkipped ? "Re-enable this field" : "Not in this table"}
                    >
                      {isSkipped ? "↩" : "✕"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: Column headers */}
        <div className="space-y-3">
          <div className="text-xs uppercase tracking-widest text-tertiary font-semibold mb-3 ml-1">
            2. Assign to a Column
          </div>
          <div className="stagger-children space-y-2 max-h-[600px] overflow-y-auto">
            {data.headers.map((header, colIdx) => {
              const assignedField = reverseMapping[colIdx];
              const color = assignedField
                ? FIELD_COLORS[assignedField]
                : "var(--text-tertiary)";
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
                    borderLeftColor: assignedField ? color : "var(--tint-strong)",
                    background: assignedField
                      ? `${color}12`
                      : "var(--tint)",
                    boxShadow: isSelectable && activeField
                      ? "inset 0 0 8px var(--blue-dim)"
                      : "none",
                  }}
                >
                  <div className="space-y-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs uppercase tracking-widest text-tertiary">
                        Col {colIdx + 1}
                      </span>
                      <span className="text-sm font-semibold text-primary flex-1 truncate">
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
                          <div className="mt-1.5 p-2 rounded bg-danger-dim border border-danger">
                            <p className="text-[11px] text-danger font-medium">
                              All {total} sample rows are empty
                            </p>
                            <p className="text-[10px] text-tertiary mt-0.5">
                              This column may not have data in your PDF
                            </p>
                          </div>
                        );
                      }

                      return (
                        <div className="mt-1">
                          <p className="text-[10px] text-tertiary mb-1">
                            {nonEmpty.length} of {total} rows have data
                          </p>
                          <div className="space-y-0.5">
                            {nonEmpty.map(({ val, rIdx }) => (
                              <p key={rIdx} className="text-[11px] text-tertiary truncate">
                                <span className="text-tertiary mr-1">r{rIdx + 1}</span>
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
        <div className="p-3 rounded-lg bg-accent-dim border border-accent-dim">
          <p className="text-sm text-info">
            Assigning <strong>{fieldLabels[activeField]}</strong> — click a column on the right to assign it
          </p>
        </div>
      ) : (
        <div className="p-3 rounded-lg bg-tint border border-border-dim-strong">
          <p className="text-sm text-tertiary">
            Select a field on the left to begin mapping
          </p>
        </div>
      )}

      {/* Validation message */}
      {!canConfirm && (
        <div className="p-3 rounded-lg bg-danger-dim border border-danger">
          <p className="text-sm text-danger">
            <strong>Required field missing:</strong> Door Number must be mapped before confirming.
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between pt-4 gap-4 border-t border-border-dim pt-6">
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
        <h2 className="font-display text-2xl font-bold text-primary mb-2">
          CONFIRM & EXTRACT
        </h2>
        <p className="text-sm text-secondary leading-relaxed">
          Review the mapping below. The preview shows how your data will be read.
          When everything looks right, hit <span className="text-primary font-medium">Confirm &amp; Extract</span> to
          start parsing your submittal.
        </p>
        <p className="text-xs text-tertiary mt-2">
          You&apos;ll review all extracted data before anything is saved to your project.
        </p>
      </div>

      {/* Summary table showing all assignments */}
      <div
        className="rounded-lg border border-border-dim-strong p-6"
        style={{ backgroundColor: "var(--background)" }}
      >
        <div className="mb-4">
          <h3 className="font-semibold text-sm text-primary mb-3">
            Field Assignments
          </h3>
          <div className="space-y-2">
            {Object.entries(mapping).map(([field, colIdx]) => {
              const color = FIELD_COLORS[field];
              const confidence = data.confidence_scores[field];

              return (
                <div
                  key={field}
                  className="flex items-center justify-between p-3 rounded-lg"
                  style={{
                    backgroundColor: `${color}10`,
                    border: `1px solid ${color}25`,
                  }}
                >
                  <div className="flex-1">
                    <div className="font-semibold text-sm" style={{ color }}>
                      {fieldLabels[field]}
                    </div>
                    <div className="text-xs text-secondary mt-1">
                      Column {colIdx + 1}: <strong className="text-secondary">{data.headers[colIdx]}</strong>
                    </div>
                    {confidence !== undefined && (
                      <div className="text-xs text-tertiary mt-0.5">
                        Confidence: {Math.round(confidence * 100)}%
                      </div>
                    )}
                  </div>
                  {data.sample_rows.length > 0 && (
                    <div className="text-right text-xs text-secondary max-w-[150px] truncate">
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
        <div
          className="rounded-lg border border-border-dim-strong p-4"
          style={{ backgroundColor: "var(--background)" }}
        >
          <div className="text-xs uppercase tracking-widest text-tertiary font-semibold mb-3">
            Preview with Extracted Data
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  {Object.entries(mapping).map(([field]) => {
                    const color = FIELD_COLORS[field];
                    return (
                      <th
                        key={field}
                        className="px-2 py-2 text-left font-semibold whitespace-nowrap"
                        style={{
                          color,
                          backgroundColor: "var(--background)",
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
                    className={`border-b border-border-dim ${
                      rowIdx % 2 === 0 ? "bg-tint" : ""
                    }`}
                  >
                    {Object.entries(mapping).map(([field, colIdx]) => (
                      <td key={`${rowIdx}-${field}`}
                          className="px-2 py-2 text-primary truncate max-w-[150px]">
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
      <div className="flex items-center justify-between pt-4 gap-4 border-t border-border-dim pt-6">
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
  punchyObservations,
  onConfirm: onConfirmProp,
  onSkip: onSkipProp,
  onRedetect,
}: ColumnMapperWizardProps) {
  // Frontend labels take priority over backend's (which may have abbreviations)
  const fieldLabels = { ...(data.field_labels || {}), ...DEFAULT_FIELD_LABELS };

  // Wizard state — page browser is always Step 1
  const initialPhase: WizardPhase = pdfBuffer ? "pageBrowser" : "step2";
  const [phase, setPhase] = useState<WizardPhase>(initialPhase);
  const [currentData, setCurrentData] = useState<DetectMappingResponse>(data);
  const [mapping, setMapping] = useState<ColumnMapping>(() => ({ ...data.auto_mapping }));
  const [skippedFields, setSkippedFields] = useState<Set<string>>(new Set());
  const [activeField, setActiveField] = useState<string | null>(null);
  const [redetecting, setRedetecting] = useState(false);
  const [redetectError, setRedetectError] = useState<string | null>(null);

  // Step indicator: pageBrowser=0, step2=1, step3=2
  const stepIndex = phase === "pageBrowser" ? 0 : phase === "step2" ? 1 : 2;

  // Page browser handler — accepts multiple pages, detects on the first one
  const handlePageSelect = useCallback(async (pageIndices: number[]) => {
    if (!onRedetect || pageIndices.length === 0) return;
    setRedetecting(true);
    setRedetectError(null);
    try {
      // Detect columns from the first selected page
      const result = await onRedetect(pageIndices[0]);
      if (result?.success && (result.headers?.length ?? 0) > 0) {
        setCurrentData(result);
        setMapping({ ...result.auto_mapping });
        const firstUnmapped = REQUIRED_FIELDS.find((f) => !(f in (result.auto_mapping ?? {})));
        setActiveField(firstUnmapped ?? REQUIRED_FIELDS[0] ?? null);
        setPhase("step2");
      } else {
        setRedetectError(
          `No door schedule found on page ${pageIndices[0] + 1}. Try selecting different pages.`
        );
      }
    } catch {
      setRedetectError("Detection failed. Try different pages.");
    } finally {
      setRedetecting(false);
    }
  }, [onRedetect]);

  const handlePageBrowserCancel = useCallback(() => {
    onSkipProp();
  }, [onSkipProp]);

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

  const handleToggleSkip = useCallback((field: string) => {
    setSkippedFields((prev) => {
      const next = new Set(prev);
      if (next.has(field)) {
        next.delete(field);
      } else {
        next.add(field);
        // Also remove from mapping when skipping
        setMapping((m) => {
          const updated = { ...m };
          delete updated[field];
          return updated;
        });
        if (activeField === field) setActiveField(null);
      }
      return next;
    });
  }, [activeField]);

  const handleReset = useCallback(() => {
    setMapping({ ...currentData.auto_mapping });
    setSkippedFields(new Set());
    setActiveField(null);
  }, [currentData.auto_mapping]);

  const handleStep2Confirm = useCallback(() => {
    setPhase("step3");
  }, []);

  const handleStep2Back = useCallback(() => {
    setPhase(pdfBuffer ? "pageBrowser" : "step2");
  }, [pdfBuffer]);

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
          backgroundColor: "var(--background)",
          backdropFilter: "blur(30px)",
        }}
      >
        {/* Step indicator */}
        <StepIndicator currentStep={stepIndex} totalSteps={3} />

        {/* Phase content */}
        <div className="relative">
          {phase === "pageBrowser" && pdfBuffer && (
            <>
              <PDFPageBrowser
                pdfBuffer={pdfBuffer}
                pageCount={pageCountProp ?? currentData.total_pages}
                onSelectPages={handlePageSelect}
                onCancel={handlePageBrowserCancel}
                loading={redetecting}
              />
              {redetectError && (
                <div className="mt-4 p-3 rounded-lg bg-danger-dim border border-danger">
                  <p className="text-sm text-danger">{redetectError}</p>
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
              skippedFields={skippedFields}
              onToggleSkip={handleToggleSkip}
              punchyObservations={punchyObservations}
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
