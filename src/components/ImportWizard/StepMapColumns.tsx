"use client";

import { useState, useEffect, useCallback } from "react";
import { usePunchHighlight } from "./usePunchHighlight";
import type {
  ClassifyPagesResponse,
  DetectMappingResponse,
  ColumnMapping,
  DoorEntry,
} from "./types";
import { arrayBufferToBase64 } from "@/lib/pdf-utils";
import WizardNav from "./WizardNav";

// Fields available for mapping
const MAPPABLE_FIELDS: { value: keyof DoorEntry | ""; label: string }[] = [
  { value: "", label: "(skip)" },
  { value: "door_number", label: "Door Number" },
  { value: "hw_set", label: "Hardware Set" },
  { value: "hw_heading", label: "Hardware Heading" },
  { value: "location", label: "Location" },
  { value: "door_type", label: "Door Type" },
  { value: "frame_type", label: "Frame Type" },
  { value: "fire_rating", label: "Fire Rating" },
  { value: "hand", label: "Hand" },
];

function confidenceBadge(confidence: number) {
  if (confidence >= 0.8) {
    return (
      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-success-dim text-success">
        {Math.round(confidence * 100)}%
      </span>
    );
  }
  if (confidence >= 0.5) {
    return (
      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-warning-dim text-warning">
        {Math.round(confidence * 100)}%
      </span>
    );
  }
  return (
    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-danger-dim text-danger">
      {Math.round(confidence * 100)}%
    </span>
  );
}

interface StepMapColumnsProps {
  file: File;
  classifyResult: ClassifyPagesResponse;
  onComplete: (
    detectResult: DetectMappingResponse,
    columnMappings: ColumnMapping[]
  ) => void;
  onBack: () => void;
  onError: (msg: string) => void;
}

export default function StepMapColumns({
  file,
  classifyResult,
  onComplete,
  onBack,
  onError,
}: StepMapColumnsProps) {
  const { registerRef } = usePunchHighlight();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [detectResult, setDetectResult] =
    useState<DetectMappingResponse | null>(null);
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);

  // ─── Auto-detect on mount ───
  const runDetection = useCallback(async () => {
    setLoading(true);
    setStatus("Detecting column layout...");

    try {
      const bestPage =
        classifyResult.summary.door_schedule_pages[0] ?? 0;

      // Convert file to base64 — Python endpoint expects JSON, not FormData
      const arrayBuffer = await file.arrayBuffer();
      const pdfBase64 = arrayBufferToBase64(arrayBuffer);

      // Proxy route: enforces Supabase auth before forwarding to the
      // public Python endpoint with the internal shared secret.
      const resp = await fetch("/api/parse-pdf/detect-mapping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pdf_base64: pdfBase64, page_index: bestPage }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(
          err.error || `Column detection failed (${resp.status})`
        );
      }

      // Transform Python response to match DetectMappingResponse type.
      // Python returns: { headers: string[], auto_mapping: {field: colIdx}, confidence_scores: {field: score}, sample_rows, page_index }
      // TS expects:     { columns: DetectedColumn[], best_door_schedule_page: number, raw_headers: string[] }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw: any = await resp.json();
      const headers: string[] = raw.headers ?? [];
      const autoMapping: Record<string, number> = raw.auto_mapping ?? {};
      const confidenceScores: Record<string, number> = raw.confidence_scores ?? {};

      // Build reverse map: column index -> mapped field name
      const indexToField = new Map<number, string>();
      for (const [field, colIdx] of Object.entries(autoMapping)) {
        indexToField.set(colIdx as number, field);
      }

      const result: DetectMappingResponse = {
        columns: headers.map((header, i) => {
          const mappedField = indexToField.get(i) ?? null;
          const confidence = mappedField ? (confidenceScores[mappedField] ?? 0) : 0;
          return {
            source_header: header,
            mapped_field: mappedField as keyof DoorEntry | null,
            confidence,
          };
        }),
        best_door_schedule_page: raw.page_index ?? bestPage,
        raw_headers: headers,
      };
      setDetectResult(result);

      // Initialize mappings from detected columns
      const initial: ColumnMapping[] = result.columns.map((col) => ({
        source_header: col.source_header,
        mapped_field: col.mapped_field,
      }));
      setMappings(initial);

      setStatus("Column mapping detected. Review and adjust as needed.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Detection failed");
    } finally {
      setLoading(false);
    }
  }, [file, classifyResult, onError]);

  useEffect(() => {
    runDetection();
  }, [runDetection]);

  // ─── Update a single mapping ───
  const updateMapping = (index: number, field: keyof DoorEntry | "") => {
    setMappings((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        mapped_field: field === "" ? null : field,
      };
      return next;
    });
  };

  // ─── Advance ───
  const handleNext = () => {
    if (!detectResult) return;

    // Validate: at least door_number must be mapped
    const hasDoorNumber = mappings.some(
      (m) => m.mapped_field === "door_number"
    );
    if (!hasDoorNumber) {
      onError(
        'You must map at least one column to "Door Number" to continue.'
      );
      return;
    }

    onComplete(detectResult, mappings);
  };

  return (
    <div className="max-w-4xl mx-auto">
      <h3
        className="text-[11px] font-semibold uppercase text-secondary tracking-wider"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Map Columns
      </h3>
      <p className="text-sm text-tertiary mt-1 mb-4">
        We detected the column headers from your door schedule. Review the
        mappings below and adjust any that look incorrect.
      </p>

      {loading && (
        <div className="flex items-center gap-2 text-accent text-sm mb-4">
          <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          {status}
        </div>
      )}

      {/* Column mapping table */}
      {mappings.length > 0 && (
        <div className="space-y-2">
          {/* Header */}
          <div className="grid grid-cols-[1fr_auto_1fr] gap-3 text-xs text-tertiary font-semibold uppercase px-3">
            <div>Source Header</div>
            <div className="w-12 text-center">Conf.</div>
            <div>Maps To</div>
          </div>

          {mappings.map((mapping, i) => {
            const detected = detectResult?.columns[i];
            return (
              <div
                key={mapping.source_header}
                ref={(el) => {
                  if (detected?.mapped_field) registerRef(detected.mapped_field, el);
                }}
                className="grid grid-cols-[1fr_auto_1fr] gap-3 items-center bg-tint border border-border-dim-strong rounded-xl px-3 py-2"
              >
                {/* Source header */}
                <div className="text-primary text-sm font-mono truncate">
                  {mapping.source_header}
                </div>

                {/* Confidence */}
                <div className="w-12 text-center">
                  {detected && confidenceBadge(detected.confidence)}
                </div>

                {/* Mapping select */}
                <select
                  value={mapping.mapped_field ?? ""}
                  onChange={(e) =>
                    updateMapping(
                      i,
                      e.target.value as keyof DoorEntry | ""
                    )
                  }
                  className="bg-tint border border-border-dim-strong rounded-lg px-2 py-1.5 text-sm text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  {MAPPABLE_FIELDS.map((field) => (
                    <option key={field.value} value={field.value}>
                      {field.label}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}

      {/* Raw headers info */}
      {detectResult && detectResult.raw_headers.length > 0 && (
        <div className="mt-4 text-xs text-tertiary">
          <span className="font-semibold">Raw headers found:</span>{" "}
          {detectResult.raw_headers.join(" | ")}
        </div>
      )}

      {/* Navigation */}
      <WizardNav
        onBack={onBack}
        onNext={handleNext}
        nextLabel="Next"
        nextDisabled={loading || mappings.length === 0}
      />
    </div>
  );
}
