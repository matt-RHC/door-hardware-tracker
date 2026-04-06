"use client";

import { useState } from "react";
import type { DoorEntry, HardwareSet, TriageResult } from "./types";

interface StepConfirmProps {
  projectId: string;
  doors: DoorEntry[];
  hardwareSets: HardwareSet[];
  triageResult: TriageResult | null;
  onComplete: () => void;
  onBack: () => void;
  onError: (msg: string) => void;
}

export default function StepConfirm({
  projectId,
  doors,
  hardwareSets,
  triageResult,
  onComplete,
  onBack,
  onError,
}: StepConfirmProps) {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [saveComplete, setSaveComplete] = useState(false);
  const [saveResult, setSaveResult] = useState<{
    openingsCount: number;
    itemsCount: number;
    unmatchedSets?: string[];
  } | null>(null);

  const totalItems = hardwareSets.reduce(
    (sum, s) => sum + s.items.length,
    0
  );

  // Warnings
  const warnings: string[] = [];
  const mappedSetIds = new Set(doors.map((d) => d.hw_set).filter(Boolean));
  const definedSetIds = new Set(hardwareSets.map((s) => s.set_id));
  const unmatchedRefs = [...mappedSetIds].filter((id) => !definedSetIds.has(id));
  if (unmatchedRefs.length > 0) {
    warnings.push(
      `${unmatchedRefs.length} hardware set(s) referenced by doors but not defined: ${unmatchedRefs.join(", ")}`
    );
  }
  const lowConfDoors = doors.filter(
    (d) => !d.door_number || !d.hw_set
  );
  if (lowConfDoors.length > 0) {
    warnings.push(
      `${lowConfDoors.length} door(s) missing door number or hardware set assignment.`
    );
  }

  // ─── Save flow: createExtractionRun + writeStagingData + promoteExtraction ───
  const handleSave = async () => {
    setLoading(true);
    setStatus("Creating extraction run...");

    try {
      // Step 1: Create extraction run (staging)
      // For now, use the existing /api/parse-pdf/save endpoint
      // which handles the full save pipeline
      setStatus("Saving doors and hardware items...");

      const saveResp = await fetch("/api/parse-pdf/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          hardwareSets,
          doors,
        }),
      });

      if (!saveResp.ok) {
        const err = await saveResp.json().catch(() => ({}));
        throw new Error(err.error || `Save failed (${saveResp.status})`);
      }

      const result = await saveResp.json();
      if (!result.success) {
        throw new Error("Save completed but no success response received");
      }

      setSaveResult({
        openingsCount: result.openingsCount,
        itemsCount: result.itemsCount,
        unmatchedSets: result.unmatchedSets,
      });

      setStatus("Save complete!");
      setSaveComplete(true);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setLoading(false);
    }
  };

  // ─── Success state ───
  if (saveComplete && saveResult) {
    return (
      <div className="max-w-lg mx-auto text-center py-8">
        <div className="text-5xl mb-4">&#x2713;</div>
        <h3 className="text-xl font-bold text-[#30d158] mb-4">
          Import Complete
        </h3>

        <div className="grid grid-cols-2 gap-3 max-w-sm mx-auto text-sm mb-6">
          <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3">
            <div className="text-lg font-bold text-[#0a84ff]">
              {saveResult.openingsCount}
            </div>
            <div className="text-[9px] text-[#6e6e73] uppercase">
              Doors Saved
            </div>
          </div>
          <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3">
            <div className="text-lg font-bold text-[#30d158]">
              {saveResult.itemsCount}
            </div>
            <div className="text-[9px] text-[#6e6e73] uppercase">
              Hardware Items
            </div>
          </div>
        </div>

        {saveResult.unmatchedSets && saveResult.unmatchedSets.length > 0 && (
          <div className="mb-4 p-3 bg-[rgba(255,149,0,0.1)] border border-[rgba(255,149,0,0.2)] rounded-xl text-[#ff9500] text-xs">
            {saveResult.unmatchedSets.length} unmatched set(s):{" "}
            {saveResult.unmatchedSets.join(", ")}
          </div>
        )}

        <button
          onClick={onComplete}
          className="px-8 py-2.5 bg-[#30d158] hover:bg-[#26c14a] text-white rounded-lg transition-colors font-semibold"
        >
          Done
        </button>
      </div>
    );
  }

  // ─── Confirm state ───
  return (
    <div className="max-w-lg mx-auto">
      <h3 className="text-[#f5f5f7] font-semibold mb-2">
        Step 5: Confirm &amp; Save
      </h3>
      <p className="text-[#a1a1a6] text-sm mb-4">
        Review the summary below and save to your project.
      </p>

      {/* Summary */}
      <div className="space-y-2 mb-4">
        <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 flex justify-between">
          <span className="text-[#a1a1a6]">Doors</span>
          <span className="text-[#f5f5f7] font-mono">{doors.length}</span>
        </div>
        <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 flex justify-between">
          <span className="text-[#a1a1a6]">Hardware Sets</span>
          <span className="text-[#f5f5f7] font-mono">
            {hardwareSets.length}
          </span>
        </div>
        <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 flex justify-between">
          <span className="text-[#a1a1a6]">Total Hardware Items</span>
          <span className="text-[#f5f5f7] font-mono">{totalItems}</span>
        </div>
        {triageResult && triageResult.by_others > 0 && (
          <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 flex justify-between">
            <span className="text-[#a1a1a6]">By Others (excluded)</span>
            <span className="text-[#ff9500] font-mono">
              {triageResult.by_others}
            </span>
          </div>
        )}
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="space-y-2 mb-4">
          {warnings.map((w, i) => (
            <div
              key={i}
              className="p-3 bg-[rgba(255,149,0,0.08)] border border-[rgba(255,149,0,0.15)] rounded-xl text-[#ff9500] text-xs"
            >
              {w}
            </div>
          ))}
        </div>
      )}

      {/* Progress */}
      {loading && (
        <div className="mb-4 flex items-center gap-2 text-[#0a84ff] text-sm">
          <div className="w-4 h-4 border-2 border-[#0a84ff] border-t-transparent rounded-full animate-spin" />
          {status}
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
          onClick={handleSave}
          disabled={loading}
          className="px-6 py-2 bg-[#30d158] hover:bg-[#26c14a] text-white rounded-lg transition-colors font-semibold disabled:opacity-50"
        >
          {loading ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}
