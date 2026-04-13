"use client";

import { useState, useCallback, useEffect } from "react";
import type { DoorEntry, HardwareSet } from "./types";
import WizardNav from "./WizardNav";

// ─── Types ───

interface FieldChange {
  field: string;
  old_value: string | null;
  new_value: string | null;
}

interface CompareResult {
  summary: {
    existing_count: number;
    new_count: number;
    matched: number;
    changed: number;
    added: number;
    removed: number;
  };
  matched: Array<{ door_number: string; hw_set: string }>;
  changed: Array<{
    door_number: string;
    existing_id: string;
    existing_hw_set: string | null;
    new_hw_set: string;
    changes: FieldChange[];
    hw_set_changed: boolean;
    progress_count: { total: number; checked: number };
    item_count: number;
  }>;
  added: Array<{
    door_number: string;
    hw_set: string;
    location: string;
    door_type: string;
    frame_type: string;
    fire_rating: string;
    hand: string;
  }>;
  removed: Array<{
    door_number: string;
    existing_id: string;
    hw_set: string | null;
    hw_heading: string | null;
    progress_count: { total: number; checked: number };
    item_count: number;
  }>;
  hardwareSets: Array<{ set_id: string; heading: string; item_count: number }>;
}

const FIELD_LABELS: Record<string, string> = {
  hw_set: "HW Set",
  location: "Location",
  door_type: "Door Type",
  frame_type: "Frame Type",
  fire_rating: "Fire Rating",
  hand: "Hand",
};

interface StepCompareProps {
  projectId: string;
  doors: DoorEntry[];
  hardwareSets: HardwareSet[];
  onComplete: () => void;
  onBack: () => void;
  onError: (msg: string) => void;
}

export default function StepCompare({
  projectId,
  doors,
  hardwareSets,
  onComplete,
  onBack,
  onError,
}: StepCompareProps) {
  // Internal sub-step: 0=comparing, 1=removed, 2=changed, 3=new, 4=confirm, 5=done
  const [subStep, setSubStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);
  const [removedActions, setRemovedActions] = useState<Record<string, "keep" | "delete">>({});
  const [changedTransfer, setChangedTransfer] = useState<Record<string, boolean>>({});
  const [newExcluded, setNewExcluded] = useState<Record<string, boolean>>({});
  const [applyResult, setApplyResult] = useState<Record<string, number> | null>(null);
  const [showApplyConfirm, setShowApplyConfirm] = useState(false);

  // Auto-run compare on mount
  const runCompare = useCallback(async () => {
    setLoading(true);
    setStatus("Comparing with existing data...");

    try {
      const resp = await fetch("/api/parse-pdf/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, hardwareSets, doors }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Compare failed (${resp.status})`);
      }

      const result: CompareResult = await resp.json();
      setCompareResult(result);

      // Initialize default decisions
      const defaultRemoved: Record<string, "keep" | "delete"> = {};
      for (const r of result.removed) {
        defaultRemoved[r.door_number] = r.progress_count.checked > 0 ? "keep" : "delete";
      }
      setRemovedActions(defaultRemoved);

      const defaultChanged: Record<string, boolean> = {};
      for (const c of result.changed) {
        defaultChanged[c.door_number] = c.progress_count.checked > 0 && !c.hw_set_changed;
      }
      setChangedTransfer(defaultChanged);

      // Skip to first relevant sub-step
      let firstStep = 1;
      if (result.removed.length === 0) firstStep = 2;
      if (firstStep === 2 && result.changed.length === 0) firstStep = 3;
      if (firstStep === 3 && result.added.length === 0) firstStep = 4;
      setSubStep(firstStep);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Compare failed");
    } finally {
      setLoading(false);
      setStatus("");
    }
  }, [projectId, hardwareSets, doors, onError]);

  useEffect(() => {
    runCompare();
  }, [runCompare]);

  const applyRevision = async () => {
    if (!compareResult) return;
    setLoading(true);
    setStatus("Applying changes...");

    try {
      const resp = await fetch("/api/parse-pdf/apply-revision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          hardwareSets,
          allDoors: doors,
          removed_decisions: compareResult.removed.map((r) => ({
            door_number: r.door_number,
            existing_id: r.existing_id,
            action: removedActions[r.door_number] || "keep",
          })),
          changed_decisions: compareResult.changed.map((c) => ({
            door_number: c.door_number,
            existing_id: c.existing_id,
            transfer_progress: changedTransfer[c.door_number] ?? true,
          })),
          new_door_numbers: compareResult.added
            .filter((a) => !newExcluded[a.door_number])
            .map((a) => a.door_number),
          matched_door_numbers: compareResult.matched.map((m) => m.door_number),
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Apply failed (${resp.status})`);
      }

      const result = await resp.json();
      setApplyResult(result.summary);
      setSubStep(5);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Apply failed");
    } finally {
      setLoading(false);
      setStatus("");
    }
  };

  const handleSubNext = () => {
    if (!compareResult) return;
    let next = subStep + 1;
    if (next === 1 && compareResult.removed.length === 0) next++;
    if (next === 2 && compareResult.changed.length === 0) next++;
    if (next === 3 && compareResult.added.length === 0) next++;
    setSubStep(next);
  };

  const handleSubBack = () => {
    if (!compareResult) return;
    let prev = subStep - 1;
    if (prev === 3 && compareResult.added.length === 0) prev--;
    if (prev === 2 && compareResult.changed.length === 0) prev--;
    if (prev === 1 && compareResult.removed.length === 0) prev--;
    setSubStep(Math.max(0, prev));
  };

  // ─── Render ───
  return (
    <div className="flex flex-col h-full">
      {/* Sub-step indicator */}
      {compareResult && subStep < 5 && (
        <div className="flex items-center gap-1 mb-4 text-xs text-tertiary">
          {["Removed", "Changed", "New", "Apply"].map((label, i) => {
            const idx = i + 1;
            return (
              <div key={label} className="flex items-center gap-1">
                <span className={subStep === idx ? "text-accent font-semibold" : subStep > idx ? "text-success" : ""}>
                  {subStep > idx ? "✓ " : ""}{label}
                </span>
                {i < 3 && <span className="text-primary/[0.1]">→</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* Loading state */}
      {subStep === 0 && (
        <div className="flex items-center gap-2 text-accent text-sm py-8">
          <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          {status || "Comparing..."}
        </div>
      )}

      {/* Summary banner (shown on all sub-steps after compare) */}
      {compareResult && subStep >= 1 && subStep <= 4 && (
        <div className="grid grid-cols-4 gap-2 mb-4">
          <div className="bg-tint border border-border-dim rounded-xl p-2 text-center">
            <div className="text-lg font-bold text-success">{compareResult.summary.matched}</div>
            <div className="text-[9px] text-tertiary uppercase">Matched</div>
          </div>
          <div className="bg-tint border border-border-dim rounded-xl p-2 text-center">
            <div className="text-lg font-bold text-warning">{compareResult.summary.changed}</div>
            <div className="text-[9px] text-tertiary uppercase">Changed</div>
          </div>
          <div className="bg-tint border border-border-dim rounded-xl p-2 text-center">
            <div className="text-lg font-bold text-accent">{compareResult.summary.added}</div>
            <div className="text-[9px] text-tertiary uppercase">Added</div>
          </div>
          <div className="bg-tint border border-border-dim rounded-xl p-2 text-center">
            <div className="text-lg font-bold text-danger">{compareResult.summary.removed}</div>
            <div className="text-[9px] text-tertiary uppercase">Removed</div>
          </div>
        </div>
      )}

      {/* Sub-step content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* ── Removed doors ── */}
        {subStep === 1 && compareResult && (
          <div>
            <p className="text-secondary text-sm mb-3">
              These <strong className="text-danger">{compareResult.removed.length} doors</strong> exist in your project but are <strong>not in the revised submittal</strong>.
            </p>
            <div className="flex gap-2 mb-3">
              <button onClick={() => { const u: Record<string, "keep" | "delete"> = {}; compareResult.removed.forEach(r => u[r.door_number] = "keep"); setRemovedActions(u); }} className="text-xs px-3 py-1 rounded-lg bg-tint border border-border-dim-strong text-secondary hover:bg-tint-strong transition-colors">Keep All</button>
              <button onClick={() => { const u: Record<string, "keep" | "delete"> = {}; compareResult.removed.forEach(r => u[r.door_number] = "delete"); setRemovedActions(u); }} className="text-xs px-3 py-1 rounded-lg bg-danger-dim border border-danger text-danger hover:bg-danger-dim transition-colors">Delete All</button>
            </div>
            <div className="space-y-2">
              {compareResult.removed.map(r => (
                <div key={r.door_number} className="bg-tint border border-border-dim-strong rounded-xl p-3 flex items-center justify-between">
                  <div>
                    <span className="text-primary font-mono text-sm">{r.door_number}</span>
                    <span className="text-tertiary text-xs ml-2">{r.hw_set || "—"}</span>
                    {r.progress_count.checked > 0 && <span className="ml-2 text-xs text-warning">{r.progress_count.checked}/{r.progress_count.total} progress</span>}
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => setRemovedActions(p => ({ ...p, [r.door_number]: "keep" }))} className={`text-xs px-3 py-1 rounded-lg transition-colors ${removedActions[r.door_number] === "keep" ? "bg-success text-white" : "bg-tint border border-border-dim-strong text-secondary hover:bg-tint-strong"}`}>Keep</button>
                    <button onClick={() => setRemovedActions(p => ({ ...p, [r.door_number]: "delete" }))} className={`text-xs px-3 py-1 rounded-lg transition-colors ${removedActions[r.door_number] === "delete" ? "bg-danger text-white" : "bg-tint border border-border-dim-strong text-secondary hover:bg-tint-strong"}`}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Changed doors ── */}
        {subStep === 2 && compareResult && (
          <div>
            <p className="text-secondary text-sm mb-3">
              These <strong className="text-warning">{compareResult.changed.length} doors</strong> have changed fields. Decide whether to <strong>transfer existing progress</strong> or <strong>reset it</strong>.
            </p>
            <div className="flex gap-2 mb-3">
              <button onClick={() => { const u: Record<string, boolean> = {}; compareResult.changed.forEach(c => u[c.door_number] = true); setChangedTransfer(u); }} className="text-xs px-3 py-1 rounded-lg bg-tint border border-border-dim-strong text-secondary hover:bg-tint-strong transition-colors">Transfer All</button>
              <button onClick={() => { const u: Record<string, boolean> = {}; compareResult.changed.forEach(c => u[c.door_number] = false); setChangedTransfer(u); }} className="text-xs px-3 py-1 rounded-lg bg-tint border border-border-dim-strong text-secondary hover:bg-tint-strong transition-colors">Reset All</button>
            </div>
            <div className="space-y-3">
              {compareResult.changed.map(c => (
                <div key={c.door_number} className="bg-tint border border-border-dim-strong rounded-xl p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <span className="text-primary font-mono text-sm">{c.door_number}</span>
                      {c.hw_set_changed && <span className="ml-2 text-xs bg-warning-dim text-warning px-1.5 py-0.5 rounded-lg">HW Set Changed</span>}
                      {c.progress_count.checked > 0 && <span className="ml-2 text-xs text-tertiary">{c.progress_count.checked}/{c.progress_count.total} progress</span>}
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => setChangedTransfer(p => ({ ...p, [c.door_number]: true }))} className={`text-xs px-3 py-1 rounded-lg transition-colors ${changedTransfer[c.door_number] ? "bg-success text-white" : "bg-tint border border-border-dim-strong text-secondary hover:bg-tint-strong"}`}>Transfer</button>
                      <button onClick={() => setChangedTransfer(p => ({ ...p, [c.door_number]: false }))} className={`text-xs px-3 py-1 rounded-lg transition-colors ${!changedTransfer[c.door_number] ? "bg-warning text-white" : "bg-tint border border-border-dim-strong text-secondary hover:bg-tint-strong"}`}>Reset</button>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-xs">
                    <div className="text-tertiary font-semibold">Field</div>
                    <div className="text-danger font-semibold">Old</div>
                    <div className="text-success font-semibold">New</div>
                    {c.changes.map(ch => (
                      <div key={ch.field} className="contents">
                        <div className="text-tertiary">{FIELD_LABELS[ch.field] || ch.field}</div>
                        <div className="text-danger line-through font-mono">{ch.old_value || "—"}</div>
                        <div className="text-success font-mono">{ch.new_value || "—"}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── New doors ── */}
        {subStep === 3 && compareResult && (
          <div>
            <p className="text-secondary text-sm mb-3">
              <strong className="text-accent">{compareResult.added.length - Object.values(newExcluded).filter(Boolean).length} new doors</strong> will be added.
              {Object.values(newExcluded).filter(Boolean).length > 0 && <span className="text-danger"> ({Object.values(newExcluded).filter(Boolean).length} excluded)</span>}
            </p>
            <div className="flex gap-2 mb-3">
              <button onClick={() => { const a: Record<string, boolean> = {}; compareResult.added.forEach(d => a[d.door_number] = false); setNewExcluded(a); }} className="text-xs px-3 py-1 rounded-lg bg-tint border border-border-dim-strong text-secondary hover:bg-tint-strong transition-colors">Add All</button>
              <button onClick={() => { const a: Record<string, boolean> = {}; compareResult.added.forEach(d => a[d.door_number] = true); setNewExcluded(a); }} className="text-xs px-3 py-1 rounded-lg bg-danger-dim border border-danger text-danger hover:bg-danger-dim transition-colors">Skip All</button>
            </div>
            <div className="space-y-2 max-h-[50vh] overflow-y-auto">
              {compareResult.added.map(a => (
                <div key={a.door_number} className={`border rounded-xl p-3 flex items-center justify-between transition-colors ${newExcluded[a.door_number] ? "bg-tint border-border-dim opacity-50" : "bg-tint border-border-dim-strong"}`}>
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-primary font-mono text-sm">{a.door_number}</span>
                    <span className="text-accent text-xs">{a.hw_set}</span>
                    <span className="text-tertiary text-xs">{a.door_type || "—"}</span>
                    <span className="text-tertiary text-xs">{a.fire_rating || "—"}</span>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button onClick={() => setNewExcluded(p => ({ ...p, [a.door_number]: false }))} className={`text-xs px-3 py-1 rounded-lg transition-colors ${!newExcluded[a.door_number] ? "bg-success text-white" : "bg-tint text-secondary hover:bg-tint-strong"}`}>Add</button>
                    <button onClick={() => setNewExcluded(p => ({ ...p, [a.door_number]: true }))} className={`text-xs px-3 py-1 rounded-lg transition-colors ${newExcluded[a.door_number] ? "bg-danger text-white" : "bg-tint text-secondary hover:bg-tint-strong"}`}>Skip</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Confirm & Apply ── */}
        {subStep === 4 && compareResult && (
          <div>
            <h3 className="text-primary font-semibold mb-3">Review Changes</h3>
            <div className="space-y-2 text-sm">
              <div className="bg-tint border border-border-dim rounded-xl p-3 flex justify-between">
                <span className="text-secondary">Unchanged doors</span>
                <span className="text-success font-mono">{compareResult.summary.matched}</span>
              </div>
              {compareResult.changed.length > 0 && (
                <div className="bg-tint border border-border-dim rounded-xl p-3">
                  <div className="flex justify-between mb-1">
                    <span className="text-secondary">Updated doors</span>
                    <span className="text-warning font-mono">{compareResult.changed.length}</span>
                  </div>
                  <div className="text-xs text-tertiary">
                    {Object.values(changedTransfer).filter(Boolean).length} with progress transferred, {Object.values(changedTransfer).filter(v => !v).length} reset
                  </div>
                </div>
              )}
              {compareResult.added.length > 0 && (
                <div className="bg-tint border border-border-dim rounded-xl p-3 flex justify-between">
                  <span className="text-secondary">New doors to add</span>
                  <span className="text-accent font-mono">{compareResult.added.filter(a => !newExcluded[a.door_number]).length}</span>
                </div>
              )}
              {compareResult.removed.length > 0 && (
                <div className="bg-tint border border-border-dim rounded-xl p-3">
                  <div className="flex justify-between mb-1">
                    <span className="text-secondary">Removed doors</span>
                    <span className="text-danger font-mono">{compareResult.removed.length}</span>
                  </div>
                  <div className="text-xs text-tertiary">
                    {Object.values(removedActions).filter(v => v === "keep").length} kept, {Object.values(removedActions).filter(v => v === "delete").length} deleted
                  </div>
                </div>
              )}
            </div>
            {loading && (
              <div className="flex items-center gap-2 text-accent text-sm mt-4">
                <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                {status}
              </div>
            )}
          </div>
        )}

        {/* ── Done ── */}
        {subStep === 5 && applyResult && (
          <div className="text-center py-8">
            <div className="text-4xl mb-4">✓</div>
            <h3 className="text-xl font-bold text-success mb-4">Revision Applied</h3>
            <div className="grid grid-cols-2 gap-3 max-w-sm mx-auto text-sm">
              {applyResult.doors_added > 0 && <div className="text-secondary">Doors added: <span className="text-accent">{applyResult.doors_added}</span></div>}
              {applyResult.doors_updated > 0 && <div className="text-secondary">Doors updated: <span className="text-warning">{applyResult.doors_updated}</span></div>}
              {applyResult.doors_deleted > 0 && <div className="text-secondary">Doors removed: <span className="text-danger">{applyResult.doors_deleted}</span></div>}
              {applyResult.doors_kept > 0 && <div className="text-secondary">Doors kept: <span className="text-success">{applyResult.doors_kept}</span></div>}
              {applyResult.progress_transferred > 0 && <div className="text-secondary">Progress kept: <span className="text-success">{applyResult.progress_transferred}</span></div>}
              {applyResult.progress_reset > 0 && <div className="text-secondary">Progress reset: <span className="text-warning">{applyResult.progress_reset}</span></div>}
            </div>
          </div>
        )}
      </div>

      {/* Footer buttons */}
      {subStep === 5 ? (
        <WizardNav
          onNext={onComplete}
          nextLabel="Done"
          nextVariant="success"
        />
      ) : (
        <WizardNav
          onBack={subStep <= 1 ? onBack : handleSubBack}
          onNext={subStep === 4 ? () => setShowApplyConfirm(true) : handleSubNext}
          nextLabel={loading ? "Processing..." : subStep === 4 ? "Apply Changes" : "Next"}
          nextDisabled={loading || subStep === 0}
          nextVariant={subStep === 4 ? "success" : "accent"}
        />
      )}

      {/* Apply Changes confirmation modal */}
      {showApplyConfirm && compareResult && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="panel w-full max-w-md p-6 animate-fade-in-up">
            <h2 className="text-primary font-semibold text-lg mb-3">Confirm Apply Changes</h2>
            <p className="text-secondary text-sm mb-4">
              This action is <strong className="text-danger">irreversible</strong>. The following changes will be applied to your project:
            </p>
            <div className="space-y-2 mb-6 text-sm">
              {compareResult.added.filter(a => !newExcluded[a.door_number]).length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-accent">+</span>
                  <span className="text-secondary">
                    <strong className="text-accent">{compareResult.added.filter(a => !newExcluded[a.door_number]).length}</strong> door{compareResult.added.filter(a => !newExcluded[a.door_number]).length !== 1 ? "s" : ""} will be added
                  </span>
                </div>
              )}
              {Object.values(removedActions).filter(v => v === "delete").length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-danger">&minus;</span>
                  <span className="text-secondary">
                    <strong className="text-danger">{Object.values(removedActions).filter(v => v === "delete").length}</strong> door{Object.values(removedActions).filter(v => v === "delete").length !== 1 ? "s" : ""} will be permanently deleted
                  </span>
                </div>
              )}
              {compareResult.changed.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-warning">~</span>
                  <span className="text-secondary">
                    <strong className="text-warning">{compareResult.changed.length}</strong> door{compareResult.changed.length !== 1 ? "s" : ""} will be modified
                    {Object.values(changedTransfer).filter(v => !v).length > 0 && (
                      <span className="text-danger"> ({Object.values(changedTransfer).filter(v => !v).length} with progress reset)</span>
                    )}
                  </span>
                </div>
              )}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setShowApplyConfirm(false)}
                className="glow-btn--ghost flex-1 min-h-11 rounded-lg text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowApplyConfirm(false);
                  applyRevision();
                }}
                className="glow-btn--danger flex-1 min-h-11 rounded-lg text-sm font-semibold"
              >
                Apply Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
