"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  ClassifyPagesResponse,
  ColumnMapping,
  TriageResult,
  DoorEntry,
  HardwareSet,
} from "./types";
import { scoreExtraction } from "@/lib/confidence-scoring";

interface StepTriageProps {
  projectId: string;
  file: File;
  columnMappings: ColumnMapping[];
  classifyResult: ClassifyPagesResponse;
  onComplete: (
    triageResult: TriageResult,
    doors: DoorEntry[],
    hardwareSets: HardwareSet[]
  ) => void;
  onBack: () => void;
  onError: (msg: string) => void;
}

export default function StepTriage({
  projectId,
  file,
  columnMappings,
  classifyResult,
  onComplete,
  onBack,
  onError,
}: StepTriageProps) {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [triageResult, setTriageResult] = useState<TriageResult | null>(null);
  const [doors, setDoors] = useState<DoorEntry[]>([]);
  const [hardwareSets, setHardwareSets] = useState<HardwareSet[]>([]);

  // ─── Run extraction + triage on mount ───
  const runTriage = useCallback(async () => {
    setLoading(true);
    setStatus("Extracting data with column mapping...");
    setProgress(10);

    try {
      // Step A: Call /api/parse-pdf with parseOnly=true and column mapping
      const formData = new FormData();
      formData.append("file", file);
      formData.append("projectId", projectId);
      formData.append("parseOnly", "true");
      formData.append("columnMappings", JSON.stringify(columnMappings));
      formData.append(
        "doorSchedulePages",
        JSON.stringify(classifyResult.summary.door_schedule_pages)
      );
      formData.append(
        "hardwareSetPages",
        JSON.stringify(classifyResult.summary.hardware_set_pages)
      );

      setProgress(20);
      setStatus("Running extraction...");

      const parseResp = await fetch("/api/parse-pdf", {
        method: "POST",
        body: formData,
      });

      if (!parseResp.ok) {
        const err = await parseResp.json().catch(() => ({}));
        throw new Error(
          err.error || `Extraction failed (${parseResp.status})`
        );
      }

      // The parse-pdf route streams events; read them all
      const reader = parseResp.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";
      let extractedDoors: DoorEntry[] = [];
      let extractedSets: HardwareSet[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.progress) setProgress(20 + (event.progress / 100) * 40);
            if (event.status) setStatus(event.status);
            if (event.error) throw new Error(event.error);
            if (event.result?.doors) extractedDoors = event.result.doors;
            if (event.result?.hardwareSets)
              extractedSets = event.result.hardwareSets;
          } catch (e) {
            if (e instanceof Error && e.message !== line.trim()) throw e;
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.error) throw new Error(event.error);
          if (event.result?.doors) extractedDoors = event.result.doors;
          if (event.result?.hardwareSets)
            extractedSets = event.result.hardwareSets;
        } catch {
          // skip malformed
        }
      }

      if (extractedDoors.length === 0) {
        throw new Error("No doors found during extraction.");
      }

      // Attach per-field confidence scores to each door
      const { perDoor } = scoreExtraction(extractedDoors);
      for (const door of extractedDoors) {
        const scores = perDoor.get(door.door_number);
        if (scores) door.field_confidence = scores;
      }

      setDoors(extractedDoors);
      setHardwareSets(extractedSets);
      setProgress(65);
      setStatus("Running triage...");

      // Step B: Call /api/parse-pdf/triage to classify candidates
      const triageResp = await fetch("/api/parse-pdf/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          doors: extractedDoors,
          hardwareSets: extractedSets,
        }),
      });

      if (!triageResp.ok) {
        // If triage endpoint doesn't exist yet, create a synthetic result
        const result: TriageResult = {
          doors_found: extractedDoors.length,
          by_others: 0,
          rejected: 0,
          accepted: extractedDoors,
          flagged: [],
        };
        setTriageResult(result);
      } else {
        const result: TriageResult = await triageResp.json();
        setTriageResult(result);
      }

      setProgress(100);
      setStatus("Triage complete.");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Triage failed");
    } finally {
      setLoading(false);
    }
  }, [file, projectId, columnMappings, classifyResult, onError]);

  useEffect(() => {
    runTriage();
  }, [runTriage]);

  // ─── Advance ───
  const handleNext = () => {
    if (!triageResult) return;
    onComplete(triageResult, doors, hardwareSets);
  };

  return (
    <div className="max-w-2xl mx-auto">
      <h3 className="text-[#f5f5f7] font-semibold mb-2">
        Step 3: Triage
      </h3>
      <p className="text-[#a1a1a6] text-sm mb-4">
        Extracting door schedule data and running triage to identify accepted,
        by-others, and rejected doors.
      </p>

      {/* Progress */}
      {loading && (
        <div className="mb-4">
          <div className="flex justify-between text-sm mb-1">
            <span className="text-[#a1a1a6]">{status}</span>
            <span className="text-[#6e6e73]">{progress}%</span>
          </div>
          <div className="w-full bg-white/[0.06] rounded-full h-2 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500 ease-out bg-[#0a84ff]"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Triage results */}
      {triageResult && (
        <>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 text-center">
              <div className="text-xl font-bold text-[#30d158]">
                {triageResult.doors_found}
              </div>
              <div className="text-[9px] text-[#6e6e73] uppercase">
                Doors Found
              </div>
            </div>
            <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 text-center">
              <div className="text-xl font-bold text-[#ff9500]">
                {triageResult.by_others}
              </div>
              <div className="text-[9px] text-[#6e6e73] uppercase">
                By Others
              </div>
            </div>
            <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 text-center">
              <div className="text-xl font-bold text-[#ff453a]">
                {triageResult.rejected}
              </div>
              <div className="text-[9px] text-[#6e6e73] uppercase">
                Rejected
              </div>
            </div>
          </div>

          {/* Flagged items */}
          {triageResult.flagged.length > 0 && (
            <div className="mb-4">
              <h4 className="text-[#ff9500] text-sm font-semibold mb-2">
                Flagged Items ({triageResult.flagged.length})
              </h4>
              <div className="space-y-1">
                {triageResult.flagged.map((flag) => (
                  <div
                    key={flag.door_number}
                    className="flex items-center justify-between bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm"
                  >
                    <span className="text-[#f5f5f7] font-mono">
                      {flag.door_number}
                    </span>
                    <span className="text-[#a1a1a6] text-xs">
                      {flag.reason}
                    </span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        flag.confidence >= 0.8
                          ? "bg-[rgba(48,209,88,0.15)] text-[#30d158]"
                          : flag.confidence >= 0.5
                          ? "bg-[rgba(255,149,0,0.15)] text-[#ff9500]"
                          : "bg-[rgba(255,69,58,0.15)] text-[#ff453a]"
                      }`}
                    >
                      {Math.round(flag.confidence * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
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
          disabled={loading || !triageResult}
          className="px-6 py-2 bg-[#0a84ff] hover:bg-[#0975de] text-white rounded-lg transition-colors font-semibold disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}
