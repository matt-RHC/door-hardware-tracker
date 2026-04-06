"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  ClassifyPagesResponse,
  DetectMappingResponse,
  ColumnMapping,
  DoorEntry,
} from "./types";

// Fields available for mapping
const MAPPABLE_FIELDS: { value: keyof DoorEntry | ""; label: string }[] = [
  { value: "", label: "(skip)" },
  { value: "door_number", label: "Door Number" },
  { value: "hw_set", label: "Hardware Set" },
  { value: "location", label: "Location" },
  { value: "door_type", label: "Door Type" },
  { value: "frame_type", label: "Frame Type" },
  { value: "fire_rating", label: "Fire Rating" },
  { value: "hand", label: "Hand" },
];

function confidenceBadge(confidence: number) {
  if (confidence >= 0.8) {
    return (
      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-[rgba(48,209,88,0.15)] text-[#30d158]">
        {Math.round(confidence * 100)}%
      </span>
    );
  }
  if (confidence >= 0.5) {
    return (
      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-[rgba(255,149,0,0.15)] text-[#ff9500]">
        {Math.round(confidence * 100)}%
      </span>
    );
  }
  return (
    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-[rgba(255,69,58,0.15)] text-[#ff453a]">
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
        classifyResult.summary.door_schedule_pages[0] ?? 1;

      const formData = new FormData();
      formData.append("file", file);
      formData.append("page", String(bestPage));

      const resp = await fetch("/api/detect-mapping", {
        method: "POST",
        body: formData,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(
          err.error || `Column detection failed (${resp.status})`
        );
      }

      const result: DetectMappingResponse = await resp.json();
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
    <div className="max-w-2xl mx-auto">
      <h3 className="text-[#f5f5f7] font-semibold mb-2">
        Step 2: Map Columns
      </h3>
      <p className="text-[#a1a1a6] text-sm mb-4">
        We detected the column headers from your door schedule. Review the
        mappings below and adjust any that look incorrect.
      </p>

      {loading && (
        <div className="flex items-center gap-2 text-[#0a84ff] text-sm mb-4">
          <div className="w-4 h-4 border-2 border-[#0a84ff] border-t-transparent rounded-full animate-spin" />
          {status}
        </div>
      )}

      {/* Column mapping table */}
      {mappings.length > 0 && (
        <div className="space-y-2">
          {/* Header */}
          <div className="grid grid-cols-[1fr_auto_1fr] gap-3 text-xs text-[#6e6e73] font-semibold uppercase px-3">
            <div>Source Header</div>
            <div className="w-12 text-center">Conf.</div>
            <div>Maps To</div>
          </div>

          {mappings.map((mapping, i) => {
            const detected = detectResult?.columns[i];
            return (
              <div
                key={mapping.source_header}
                className="grid grid-cols-[1fr_auto_1fr] gap-3 items-center bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2"
              >
                {/* Source header */}
                <div className="text-[#f5f5f7] text-sm font-mono truncate">
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
                  className="bg-white/[0.06] border border-white/[0.08] rounded-lg px-2 py-1.5 text-sm text-[#f5f5f7] focus:outline-none focus:ring-1 focus:ring-[#0a84ff]"
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
        <div className="mt-4 text-xs text-[#6e6e73]">
          <span className="font-semibold">Raw headers found:</span>{" "}
          {detectResult.raw_headers.join(" | ")}
        </div>
      )}

      {/* Navigation */}
      <div className="flex justify-between mt-6">
        <button
          onClick={onBack}
          disabled={loading}
          className="px-4 py-2 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] disabled:opacity-50 text-[#a1a1a6] rounded-lg transition-colors"
        >
          Back
        </button>
        <button
          onClick={handleNext}
          disabled={loading || mappings.length === 0}
          className="px-6 py-2 bg-[#0a84ff] hover:bg-[#0975de] text-white rounded-lg transition-colors font-semibold disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}
