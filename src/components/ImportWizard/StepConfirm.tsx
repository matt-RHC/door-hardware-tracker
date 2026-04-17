"use client";

import { useState } from "react";
import type { DoorEntry, HardwareSet, TriageResult } from "./types";
import WizardNav from "./WizardNav";
import PromoteConfirmModal from "./PromoteConfirmModal";
import { useToast } from "@/components/ToastProvider";
import {
  buildDefinedSetIds,
  buildDoorToSetMap,
  buildSetLookupMap,
  findDoorsWithUnmatchedSets,
  wouldProduceZeroItems,
} from "@/lib/parse-pdf-helpers";

interface StepConfirmProps {
  projectId: string;
  doors: DoorEntry[];
  hardwareSets: HardwareSet[];
  triageResult: TriageResult | null;
  onComplete: () => void;
  onBack: () => void;
  onBackToReview: () => void;
  onError: (msg: string) => void;
}

export default function StepConfirm({
  projectId,
  doors,
  hardwareSets,
  triageResult,
  onComplete,
  onBack,
  onBackToReview,
  onError,
}: StepConfirmProps) {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [saveComplete, setSaveComplete] = useState(false);
  const [overrideUnmatched, setOverrideUnmatched] = useState(false);
  const [acknowledgeOrphans, setAcknowledgeOrphans] = useState(false);
  const [promoteFailed, setPromoteFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  // Promote gate: clicking Save opens the confirmation modal; the modal's
  // Confirm button is what actually fires the API call. Staging → prod is
  // a one-way write, so one deliberate pause is worth the extra click.
  const [showConfirm, setShowConfirm] = useState(false);
  const [saveResult, setSaveResult] = useState<{
    openingsCount: number;
    itemsCount: number;
    expectedItemsCount?: number;
    unmatchedSets?: string[];
    partial?: boolean;
    failedChunks?: Array<{ offset: number; count: number; error: string }>;
  } | null>(null);

  const totalItems = hardwareSets.reduce(
    (sum, s) => sum + (s.items ?? []).length,
    0
  );

  // Warnings
  //
  // `definedSetIds` contains BOTH the specific `set_id` and the
  // `generic_set_id` for every hardware set. Doors in the opening list
  // often reference the generic parent id (e.g., "DH4A") while the
  // extracted set is stored under a specific sub-heading id (e.g.,
  // "DH4A.0" / "DH4A.1"). Without the generic fallback, the save button
  // would be blocked for any multi-heading project — the exact Radius
  // DC DH4A case from 2026-04-11.
  //
  // `findDoorsWithUnmatchedSets` also excludes `by_others` doors, which
  // intentionally have no valid hw_set (hardware supplied by a
  // different contractor) and must not count as "unmatched."
  const warnings: string[] = [];
  const definedSetIds = buildDefinedSetIds(hardwareSets);
  const nonByOthersDoors = doors.filter((d) => !d.by_others);
  const mappedSetIds = new Set(
    nonByOthersDoors.map((d) => d.hw_set).filter(Boolean)
  );
  const unmatchedRefs = [...mappedSetIds].filter((id) => !definedSetIds.has(id));
  if (unmatchedRefs.length > 0) {
    warnings.push(
      `${unmatchedRefs.length} hardware set(s) referenced by doors but not defined: ${unmatchedRefs.join(", ")}`
    );
  }
  const lowConfDoors = nonByOthersDoors.filter(
    (d) => !d.door_number || !d.hw_set
  );
  if (lowConfDoors.length > 0) {
    warnings.push(
      `${lowConfDoors.length} door(s) missing door number or hardware set assignment.`
    );
  }

  // Count doors that reference non-existent sets (blocks save unless overridden)
  const doorsWithUnmatchedSets = findDoorsWithUnmatchedSets(doors, definedSetIds);

  // Pre-flight orphan detection: mirror the server's wouldProduceZeroItems
  // filter so the user is warned BEFORE /save is called. Doors here would be
  // silently dropped by the server, which is usually fine (e.g. inactive leaf
  // pairs) but surprising if the door was supposed to have hardware. Catches
  // the class of promotion failures that prompted the fix/promotion-orphan-items
  // branch — see merge_extraction validation in migration 034.
  const clientSetMap = buildSetLookupMap(hardwareSets);
  const clientDoorToSetMap = buildDoorToSetMap(hardwareSets);
  const orphanDoors = doors.filter((d) =>
    wouldProduceZeroItems(d, clientSetMap, clientDoorToSetMap),
  );

  const saveBlocked =
    doors.length === 0 ||
    (doorsWithUnmatchedSets.length > 0 && !overrideUnmatched) ||
    (orphanDoors.length > 0 && !acknowledgeOrphans);

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
          expectedItemsCount: result.expectedItemsCount,
          unmatchedSets: result.unmatchedSets,
          partial: result.partial,
          failedChunks: result.failedChunks,
        });
        setPromoteFailed(true);
        setStatus("Promotion failed");
        setSaveComplete(true);
        showToast(
          "warning",
          "Saved to staging but promotion failed. You can retry below.",
        );
        return;
      }

      if (!result.success) {
        throw new Error(result.error || "Save failed");
      }

      setSaveResult({
        openingsCount: result.openingsCount,
        itemsCount: result.itemsCount,
        expectedItemsCount: result.expectedItemsCount,
        unmatchedSets: result.unmatchedSets,
        partial: result.partial,
        failedChunks: result.failedChunks,
      });

      setStatus("Save complete!");
      setSaveComplete(true);
      // One satisfying confirmation per high-stakes action (per styling
      // pass scope). Partial saves still show the toast because some
      // openings DID land; the inline "Partial Save" card spells out
      // the caveat on the success screen.
      showToast(
        "success",
        `Promoted ${result.openingsCount} opening${result.openingsCount !== 1 ? "s" : ""} to production`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      showToast("error", msg);
      onError(msg);
    } finally {
      setLoading(false);
      setShowConfirm(false);
    }
  };

  // ─── Retry promotion after a previous failure ───
  // Re-runs the same save endpoint. If promotion succeeds, we drop into
  // the normal success view; if it fails again we surface the API error
  // inline so the user can decide to back up or exit.
  const handleRetryPromotion = async () => {
    setRetrying(true);
    setRetryError(null);

    try {
      const saveResp = await fetch("/api/parse-pdf/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          hardwareSets,
          doors,
        }),
      });

      const result = await saveResp.json().catch(() => ({}));

      if (!saveResp.ok) {
        setRetryError(result?.error || `Retry failed (${saveResp.status})`);
        return;
      }

      // Promotion still failing — keep the failed view, show the new error.
      if (!result.success && result.stagingSuccess) {
        setSaveResult({
          openingsCount: result.openingsCount,
          itemsCount: result.itemsCount,
          expectedItemsCount: result.expectedItemsCount,
          unmatchedSets: result.unmatchedSets,
          partial: result.partial,
          failedChunks: result.failedChunks,
        });
        setRetryError(result.error || "Promotion failed again.");
        return;
      }

      if (!result.success) {
        setRetryError(result.error || "Retry failed.");
        return;
      }

      // Success — flip into the normal post-save view.
      setSaveResult({
        openingsCount: result.openingsCount,
        itemsCount: result.itemsCount,
        expectedItemsCount: result.expectedItemsCount,
        unmatchedSets: result.unmatchedSets,
        partial: result.partial,
        failedChunks: result.failedChunks,
      });
      setPromoteFailed(false);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : "Retry failed.");
    } finally {
      setRetrying(false);
    }
  };

  // ─── "Back to Review": drop the failed state and let the wizard rewind. ───
  const handleBackToReview = () => {
    setPromoteFailed(false);
    setSaveComplete(false);
    setRetryError(null);
    setSaveResult(null);
    onBackToReview();
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
          Data saved to staging but final promotion failed.
        </p>

        <div className="grid grid-cols-2 gap-3 max-w-sm mx-auto text-sm mb-6">
          <div className="bg-tint border border-border-dim rounded-md p-3">
            <div className="text-lg font-bold text-accent">
              {saveResult.openingsCount}
            </div>
            <div className="text-[9px] text-tertiary uppercase">
              Doors Staged
            </div>
          </div>
          <div className="bg-tint border border-border-dim rounded-md p-3">
            <div className="text-lg font-bold text-warning">
              {saveResult.itemsCount}
            </div>
            <div className="text-[9px] text-tertiary uppercase">
              Items Staged
            </div>
          </div>
        </div>

        {retryError && (
          <div className="mb-4 p-3 bg-danger-dim border border-danger rounded-md text-danger text-xs text-left">
            {retryError}
          </div>
        )}

        <div className="flex flex-col items-center gap-3">
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              onClick={handleRetryPromotion}
              disabled={retrying}
              className="px-6 py-2.5 bg-accent hover:bg-accent/80 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors font-semibold inline-flex items-center gap-2"
            >
              {retrying && (
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              )}
              {retrying ? "Retrying..." : "Retry Promotion"}
            </button>
            <button
              onClick={handleBackToReview}
              disabled={retrying}
              className="px-6 py-2.5 bg-tint hover:bg-tint/70 disabled:opacity-50 disabled:cursor-not-allowed text-primary border border-border-dim rounded-lg transition-colors font-semibold"
            >
              &larr; Back to Review
            </button>
          </div>
          <button
            onClick={onComplete}
            disabled={retrying}
            className="text-tertiary hover:text-secondary disabled:opacity-50 disabled:cursor-not-allowed text-xs underline transition-colors"
          >
            Exit
          </button>
        </div>
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
          <div className="bg-tint border border-border-dim rounded-md p-3">
            <div className="text-lg font-bold text-accent">
              {saveResult.openingsCount}
            </div>
            <div className="text-[9px] text-tertiary uppercase">
              Doors Saved
            </div>
          </div>
          <div className="bg-tint border border-border-dim rounded-md p-3">
            <div className="text-lg font-bold text-success">
              {saveResult.itemsCount}
            </div>
            <div className="text-[9px] text-tertiary uppercase">
              Hardware Items
            </div>
          </div>
        </div>

        {saveResult.partial && (
          <div className="mb-4 p-3 bg-warning-dim border border-warning rounded-md text-sm">
            <p className="text-warning font-semibold mb-1">Partial Save</p>
            <p className="text-secondary text-xs">
              {saveResult.itemsCount} of {saveResult.expectedItemsCount ?? "?"} hardware items were saved successfully.
              {saveResult.failedChunks && ` ${saveResult.failedChunks.length} batch(es) failed to insert.`}
              {" "}Some hardware items may be missing — review the project data.
            </p>
          </div>
        )}

        {saveResult.unmatchedSets && saveResult.unmatchedSets.length > 0 && (
          <div className="mb-4 p-3 bg-warning-dim border border-warning rounded-md text-warning text-xs">
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
    <div className="max-w-2xl mx-auto">
      <h3
        className="text-[11px] font-semibold uppercase text-secondary tracking-wider"
        style={{ fontFamily: "var(--font-display)" }}
      >
        Confirm &amp; Save
      </h3>
      <p className="text-sm text-tertiary mt-1 mb-4">
        Review the summary below and save to your project.
      </p>

      {/* Summary */}
      <div className="space-y-2 mb-4">
        <div className="bg-tint border border-border-dim rounded-md p-3 flex justify-between">
          <span className="text-secondary">Doors</span>
          <span className="text-primary font-mono">{doors.length}</span>
        </div>
        <div className="bg-tint border border-border-dim rounded-md p-3 flex justify-between">
          <span className="text-secondary">Hardware Sets</span>
          <span className="text-primary font-mono">
            {hardwareSets.length}
          </span>
        </div>
        <div className="bg-tint border border-border-dim rounded-md p-3 flex justify-between">
          <span className="text-secondary">Total Hardware Items</span>
          <span className="text-primary font-mono">{totalItems}</span>
        </div>
        {triageResult && triageResult.by_others > 0 && (
          <div className="bg-tint border border-border-dim rounded-md p-3 flex justify-between">
            <span className="text-secondary">By Others (excluded)</span>
            <span className="text-warning font-mono">
              {triageResult.by_others}
            </span>
          </div>
        )}
      </div>

      {/* Blocking error: unmatched hardware sets */}
      {doorsWithUnmatchedSets.length > 0 && (
        <div className="mb-4 p-3 bg-danger-dim border border-danger rounded-md">
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

      {/* Orphan doors pre-flight: these will be filtered server-side because
          they would produce zero hardware items (no matching set + no door
          or frame type). Block save until the user explicitly acknowledges. */}
      {orphanDoors.length > 0 && (
        <div className="mb-4 p-3 bg-warning-dim border border-warning rounded-md">
          <p className="text-warning text-sm font-semibold mb-1">
            {orphanDoors.length} door(s) will be excluded (no hardware will be
            saved for them):
          </p>
          <p className="text-secondary text-xs font-mono mb-2">
            {orphanDoors.map((d) => d.door_number).join(", ")}
          </p>
          <p className="text-secondary text-xs mb-2">
            These doors either reference a hardware set that wasn&apos;t
            extracted, or have no door/frame type — saving them would block
            promotion. Go back and fix them, or acknowledge to proceed without
            them.
          </p>
          <label className="flex items-center gap-2 text-xs text-warning cursor-pointer">
            <input
              type="checkbox"
              checked={acknowledgeOrphans}
              onChange={(e) => setAcknowledgeOrphans(e.target.checked)}
              className="rounded"
            />
            Save without these doors
          </label>
        </div>
      )}

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="space-y-2 mb-4">
          {warnings.map((w, i) => (
            <div
              key={i}
              className="p-3 bg-warning-dim border border-warning rounded-md text-warning text-xs"
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

      {/* Navigation — Save opens the confirmation modal; the modal's
          Confirm button is what actually calls handleSave. */}
      <WizardNav
        onBack={onBack}
        onNext={() => setShowConfirm(true)}
        nextLabel={loading ? "Saving..." : "Save"}
        nextDisabled={loading || saveBlocked}
        nextVariant="success"
      />

      <PromoteConfirmModal
        isOpen={showConfirm}
        openingCount={doors.length - orphanDoors.length}
        isPromoting={loading}
        onConfirm={handleSave}
        onCancel={() => setShowConfirm(false)}
      />
    </div>
  );
}
