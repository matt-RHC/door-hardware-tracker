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
  const [overrideUnmatched, setOverrideUnmatched] = useState(false);
  const [promoteFailed, setPromoteFailed] = useState(false);
  const [saveResult, setSaveResult] = useState<{
    openingsCount: number;
    itemsCount: number;
    unmatchedSets?: string[];
  } | null>(null);

  const totalItems = hardwareSets.reduce(
    (sum, s) => sum + (s.items ?? []).length,
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

  // Count doors that reference non-existent sets (blocks save unless overridden)
  const doorsWithUnmatchedSets = doors.filter(
    (d) => d.hw_set && !definedSetIds.has(d.hw_set)
  );
  const saveBlocked =
    doorsWithUnmatchedSets.length > 0 && !overrideUnmatched;

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

      // Staging succeeded but promote failed — show warning, not success
      if (!result.success && result.stagingSuccess) {
        setSaveResult({
          openingsCount: result.openingsCount,
          itemsCount: result.itemsCount,
          unmatchedSets: result.unmatchedSets,
        });
        setPromoteFailed(true);
        setStatus("Promotion failed");
        setSaveComplete(true);
        return;
      }

      if (!result.success) {
        throw new Error(result.error || "Save failed");
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

  // ─── Promote-failed state: staging OK but production write failed ───
  if (saveComplete && saveResult && promoteFailed) {
    return (
      <div className="max-w-lg mx-auto text-center py-8">
        <div className="text-5xl mb-4">&#x26A0;</div>
        <h3 className="text-xl font-bold text-warning mb-2">
          Promotion Failed
        </h3>
        <p className="text-secondary text-sm mb-4">
          Data saved to staging but final promotion failed. Your data is safe
          &mdash; contact support or retry.
        </p>

        <div className="grid grid-cols-2 gap-3 max-w-sm mx-auto text-sm mb-6">
          <div className="bg-tint border border-border-dim rounded-xl p-3">
            <div className="text-lg font-bold text-accent">
              {saveResult.openingsCount}
            </div>
            <div className="text-[9px] text-tertiary uppercase">
              Doors Staged
            </div>
          </div>
          <div className="bg-tint border border-border-dim rounded-xl p-3">
            <div className="text-lg font-bold text-warning">
              {saveResult.itemsCount}
            </div>
            <div className="text-[9px] text-tertiary uppercase">
              Items Staged
            </div>
          </div>
        </div>

        <button
          onClick={onComplete}
          className="px-8 py-2.5 bg-warning hover:bg-warning/80 text-white rounded-lg transition-colors font-semibold"
        >
          Done
        </button>
      </div>
    );
  }

  // ─── Success state ───
  if (saveComplete && saveResult) {
    return (
      <div className="max-w-lg mx-auto text-center py-8">
        <div className="text-5xl mb-4">&#x2713;</div>
        <h3 className="text-xl font-bold text-success mb-4">
          Import Complete
        </h3>

        <div className="grid grid-cols-2 gap-3 max-w-sm mx-auto text-sm mb-6">
          <div className="bg-tint border border-border-dim rounded-xl p-3">
            <div className="text-lg font-bold text-accent">
              {saveResult.openingsCount}
            </div>
            <div className="text-[9px] text-tertiary uppercase">
              Doors Saved
            </div>
          </div>
          <div className="bg-tint border border-border-dim rounded-xl p-3">
            <div className="text-lg font-bold text-success">
              {saveResult.itemsCount}
            </div>
            <div className="text-[9px] text-tertiary uppercase">
              Hardware Items
            </div>
          </div>
        </div>

        {saveResult.unmatchedSets && saveResult.unmatchedSets.length > 0 && (
          <div className="mb-4 p-3 bg-warning-dim border border-warning rounded-xl text-warning text-xs">
            {saveResult.unmatchedSets.length} unmatched set(s):{" "}
            {saveResult.unmatchedSets.join(", ")}
          </div>
        )}

        <button
          onClick={onComplete}
          className="px-8 py-2.5 bg-success hover:bg-success/80 text-white rounded-lg transition-colors font-semibold"
        >
          Done
        </button>
      </div>
    );
  }

  // ─── Confirm state ───
  return (
    <div className="max-w-lg mx-auto">
      <h3 className="text-primary font-semibold mb-2">
        Step 5: Confirm &amp; Save
      </h3>
      <p className="text-secondary text-sm mb-4">
        Review the summary below and save to your project.
      </p>

      {/* Summary */}
      <div className="space-y-2 mb-4">
        <div className="bg-tint border border-border-dim rounded-xl p-3 flex justify-between">
          <span className="text-secondary">Doors</span>
          <span className="text-primary font-mono">{doors.length}</span>
        </div>
        <div className="bg-tint border border-border-dim rounded-xl p-3 flex justify-between">
          <span className="text-secondary">Hardware Sets</span>
          <span className="text-primary font-mono">
            {hardwareSets.length}
          </span>
        </div>
        <div className="bg-tint border border-border-dim rounded-xl p-3 flex justify-between">
          <span className="text-secondary">Total Hardware Items</span>
          <span className="text-primary font-mono">{totalItems}</span>
        </div>
        {triageResult && triageResult.by_others > 0 && (
          <div className="bg-tint border border-border-dim rounded-xl p-3 flex justify-between">
            <span className="text-secondary">By Others (excluded)</span>
            <span className="text-warning font-mono">
              {triageResult.by_others}
            </span>
          </div>
        )}
      </div>

      {/* Blocking error: unmatched hardware sets */}
      {doorsWithUnmatchedSets.length > 0 && (
        <div className="mb-4 p-3 bg-danger-dim border border-danger rounded-xl">
          <p className="text-danger text-sm font-semibold">
            Cannot save: {doorsWithUnmatchedSets.length} door(s) reference
            hardware sets that don&apos;t exist. Go back and fix the hw_set
            assignments.
          </p>
          {!overrideUnmatched && (
            <button
              type="button"
              onClick={() => setOverrideUnmatched(true)}
              className="mt-1.5 text-warning text-xs underline hover:text-warning/80 transition-colors"
            >
              Save anyway (power user override)
            </button>
          )}
        </div>
      )}

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="space-y-2 mb-4">
          {warnings.map((w, i) => (
            <div
              key={i}
              className="p-3 bg-warning-dim border border-warning rounded-xl text-warning text-xs"
            >
              {w}
            </div>
          ))}
        </div>
      )}

      {/* Progress */}
      {loading && (
        <div className="mb-4 flex items-center gap-2 text-accent text-sm">
          <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          {status}
        </div>
      )}

      {/* Navigation */}
      <div className="flex justify-between mt-6">
        <button
          onClick={onBack}
          disabled={loading}
          className="px-4 py-2 bg-tint border border-border-dim-strong hover:bg-tint-strong disabled:opacity-50 text-secondary rounded-lg transition-colors"
        >
          Back
        </button>
        <button
          onClick={handleSave}
          disabled={loading || saveBlocked}
          className="px-6 py-2 bg-success hover:bg-success/80 text-white rounded-lg transition-colors font-semibold disabled:opacity-50"
        >
          {loading ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}
