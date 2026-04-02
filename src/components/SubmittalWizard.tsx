"use client";

import { useState } from "react";

// ─── Types ───

interface HardwareSet {
  set_id: string;
  heading: string;
  items: Array<{ qty: number; name: string; model: string; finish: string; manufacturer: string }>;
}

interface ParsedDoor {
  door_number: string;
  hw_set: string;
  location: string;
  door_type: string;
  frame_type: string;
  fire_rating: string;
  hand: string;
}

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

// ─── Props ───

interface SubmittalWizardProps {
  projectId: string;
  parsedDoors: ParsedDoor[];
  parsedSets: HardwareSet[];
  onClose: () => void;
  onComplete: () => void;
}

// ─── Field label helpers ───

const FIELD_LABELS: Record<string, string> = {
  hw_set: "HW Set",
  location: "Location",
  door_type: "Door Type",
  frame_type: "Frame Type",
  fire_rating: "Fire Rating",
  hand: "Hand",
};

// ─── Step indicators ───

function StepBar({ current, total }: { current: number; total: number }) {
  const steps = ["Compare", "Removed", "Changed", "New", "Apply"];
  return (
    <div className="flex items-center gap-1 mb-6">
      {steps.slice(0, total).map((label, i) => (
        <div key={label} className="flex items-center gap-1">
          <div
            className={`flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold transition-all ${
              i < current
                ? "bg-green-600 text-white"
                : i === current
                ? "bg-cyan-600 text-white ring-2 ring-cyan-400"
                : "bg-slate-700 text-slate-400"
            }`}
          >
            {i < current ? "✓" : i + 1}
          </div>
          <span
            className={`text-xs hidden sm:inline ${
              i === current ? "text-cyan-400 font-semibold" : "text-slate-500"
            }`}
          >
            {label}
          </span>
          {i < total - 1 && (
            <div className={`w-4 h-px ${i < current ? "bg-green-600" : "bg-slate-700"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Main Wizard Component ───

export default function SubmittalWizard({
  projectId,
  parsedDoors,
  parsedSets,
  onClose,
  onComplete,
}: SubmittalWizardProps) {
  const [step, setStep] = useState(0); // 0=compare, 1=removed, 2=changed, 3=new, 4=apply
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  // Compare result from server
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);

  // User decisions
  const [removedActions, setRemovedActions] = useState<Record<string, "keep" | "delete">>({});
  const [changedTransfer, setChangedTransfer] = useState<Record<string, boolean>>({});

  // Apply result
  const [applyResult, setApplyResult] = useState<Record<string, number> | null>(null);

  // ─── Step 0: Run comparison ───
  const runCompare = async () => {
    setLoading(true);
    setError(null);
    setStatus("Comparing with existing data...");

    try {
      const resp = await fetch("/api/parse-pdf/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          hardwareSets: parsedSets,
          doors: parsedDoors,
        }),
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
        // Default: transfer progress if it exists and HW set didn't change
        defaultChanged[c.door_number] = c.progress_count.checked > 0 && !c.hw_set_changed;
      }
      setChangedTransfer(defaultChanged);

      setStep(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Compare failed");
    } finally {
      setLoading(false);
      setStatus("");
    }
  };

  // ─── Step 4: Apply all decisions ───
  const applyRevision = async () => {
    if (!compareResult) return;
    setLoading(true);
    setError(null);
    setStatus("Applying changes...");

    try {
      const resp = await fetch("/api/parse-pdf/apply-revision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          hardwareSets: parsedSets,
          allDoors: parsedDoors,
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
          new_door_numbers: compareResult.added.map((a) => a.door_number),
          matched_door_numbers: compareResult.matched.map((m) => m.door_number),
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Apply failed (${resp.status})`);
      }

      const result = await resp.json();
      setApplyResult(result.summary);
      setStatus("Revision applied successfully!");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Apply failed");
    } finally {
      setLoading(false);
    }
  };

  // ─── Navigation helpers ───
  const canGoNext = () => {
    if (step === 0) return true;
    if (step === 4 && applyResult) return false; // Done
    return compareResult !== null;
  };

  const handleNext = () => {
    if (step === 0) {
      runCompare();
      return;
    }
    // Skip steps with no items
    let next = step + 1;
    if (next === 1 && compareResult && compareResult.removed.length === 0) next++;
    if (next === 2 && compareResult && compareResult.changed.length === 0) next++;
    if (next === 3 && compareResult && compareResult.added.length === 0) next++;
    setStep(next);
  };

  const handleBack = () => {
    let prev = step - 1;
    if (prev === 3 && compareResult && compareResult.added.length === 0) prev--;
    if (prev === 2 && compareResult && compareResult.changed.length === 0) prev--;
    if (prev === 1 && compareResult && compareResult.removed.length === 0) prev--;
    setStep(Math.max(0, prev));
  };

  // ─── Render ───
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 rounded-lg border border-slate-800 p-6 max-w-2xl w-full max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-bold text-white">Revised Submittal</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">&times;</button>
        </div>

        <StepBar current={step} total={5} />

        {error && (
          <div className="mb-4 p-3 bg-red-900/20 border border-red-900 rounded text-red-200 text-sm">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-0">
          {/* ─── Step 0: Summary ─── */}
          {step === 0 && (
            <div>
              <p className="text-slate-300 mb-4">
                Your new submittal has <strong className="text-white">{parsedDoors.length} doors</strong> and{" "}
                <strong className="text-white">{parsedSets.length} hardware sets</strong>.
              </p>
              <p className="text-slate-400 text-sm mb-4">
                Click &quot;Compare&quot; to see what changed compared to the current project data.
                You&apos;ll be guided through each category of changes before anything is applied.
              </p>
              {loading && (
                <div className="flex items-center gap-2 text-cyan-400 text-sm">
                  <div className="w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
                  {status}
                </div>
              )}
            </div>
          )}

          {/* ─── Step 1: Removed Doors ─── */}
          {step === 1 && compareResult && (
            <div>
              {/* Summary banner */}
              <div className="grid grid-cols-4 gap-2 mb-4">
                <div className="bg-slate-800 rounded p-2 text-center">
                  <div className="text-lg font-bold text-green-400">{compareResult.summary.matched}</div>
                  <div className="text-[10px] text-slate-400 uppercase">Unchanged</div>
                </div>
                <div className="bg-slate-800 rounded p-2 text-center">
                  <div className="text-lg font-bold text-yellow-400">{compareResult.summary.changed}</div>
                  <div className="text-[10px] text-slate-400 uppercase">Changed</div>
                </div>
                <div className="bg-slate-800 rounded p-2 text-center">
                  <div className="text-lg font-bold text-cyan-400">{compareResult.summary.added}</div>
                  <div className="text-[10px] text-slate-400 uppercase">New</div>
                </div>
                <div className="bg-slate-800 rounded p-2 text-center">
                  <div className="text-lg font-bold text-red-400">{compareResult.summary.removed}</div>
                  <div className="text-[10px] text-slate-400 uppercase">Removed</div>
                </div>
              </div>

              {compareResult.removed.length === 0 ? (
                <p className="text-slate-400 text-sm">No doors were removed in the revised submittal.</p>
              ) : (
                <>
                  <p className="text-slate-300 text-sm mb-3">
                    These <strong className="text-red-400">{compareResult.removed.length} doors</strong> exist in
                    your current project but are <strong>not in the revised submittal</strong>. What would you like to do with each?
                  </p>

                  {/* Batch actions */}
                  <div className="flex gap-2 mb-3">
                    <button
                      onClick={() => {
                        const updated: Record<string, "keep" | "delete"> = {};
                        compareResult.removed.forEach((r) => (updated[r.door_number] = "keep"));
                        setRemovedActions(updated);
                      }}
                      className="text-xs px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
                    >
                      Keep All
                    </button>
                    <button
                      onClick={() => {
                        const updated: Record<string, "keep" | "delete"> = {};
                        compareResult.removed.forEach((r) => (updated[r.door_number] = "delete"));
                        setRemovedActions(updated);
                      }}
                      className="text-xs px-3 py-1 rounded bg-red-900/30 hover:bg-red-900/50 text-red-300 transition-colors"
                    >
                      Delete All
                    </button>
                  </div>

                  <div className="space-y-2">
                    {compareResult.removed.map((r) => (
                      <div key={r.door_number} className="bg-slate-800 rounded p-3 flex items-center justify-between">
                        <div>
                          <span className="text-white font-mono text-sm">{r.door_number}</span>
                          <span className="text-slate-500 text-xs ml-2">{r.hw_set || "—"}</span>
                          {r.progress_count.checked > 0 && (
                            <span className="ml-2 text-xs text-yellow-400">
                              {r.progress_count.checked}/{r.progress_count.total} progress
                            </span>
                          )}
                        </div>
                        <div className="flex gap-1">
                          <button
                            onClick={() => setRemovedActions((p) => ({ ...p, [r.door_number]: "keep" }))}
                            className={`text-xs px-3 py-1 rounded transition-colors ${
                              removedActions[r.door_number] === "keep"
                                ? "bg-green-600 text-white"
                                : "bg-slate-700 text-slate-400 hover:bg-slate-600"
                            }`}
                          >
                            Keep
                          </button>
                          <button
                            onClick={() => setRemovedActions((p) => ({ ...p, [r.door_number]: "delete" }))}
                            className={`text-xs px-3 py-1 rounded transition-colors ${
                              removedActions[r.door_number] === "delete"
                                ? "bg-red-600 text-white"
                                : "bg-slate-700 text-slate-400 hover:bg-slate-600"
                            }`}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ─── Step 2: Changed Doors ─── */}
          {step === 2 && compareResult && (
            <div>
              {compareResult.changed.length === 0 ? (
                <p className="text-slate-400 text-sm">No doors had field changes.</p>
              ) : (
                <>
                  <p className="text-slate-300 text-sm mb-3">
                    These <strong className="text-yellow-400">{compareResult.changed.length} doors</strong> have
                    changed fields. For each, decide whether to <strong>transfer existing progress</strong> or{" "}
                    <strong>reset it</strong>.
                  </p>

                  {/* Batch actions */}
                  <div className="flex gap-2 mb-3">
                    <button
                      onClick={() => {
                        const updated: Record<string, boolean> = {};
                        compareResult.changed.forEach((c) => (updated[c.door_number] = true));
                        setChangedTransfer(updated);
                      }}
                      className="text-xs px-3 py-1 rounded bg-green-900/30 hover:bg-green-900/50 text-green-300 transition-colors"
                    >
                      Transfer All Progress
                    </button>
                    <button
                      onClick={() => {
                        const updated: Record<string, boolean> = {};
                        compareResult.changed.forEach((c) => (updated[c.door_number] = false));
                        setChangedTransfer(updated);
                      }}
                      className="text-xs px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
                    >
                      Reset All Progress
                    </button>
                  </div>

                  <div className="space-y-3">
                    {compareResult.changed.map((c) => (
                      <div key={c.door_number} className="bg-slate-800 rounded p-3">
                        <div className="flex items-center justify-between mb-2">
                          <div>
                            <span className="text-white font-mono text-sm">{c.door_number}</span>
                            {c.hw_set_changed && (
                              <span className="ml-2 text-xs bg-yellow-900/40 text-yellow-300 px-1.5 py-0.5 rounded">
                                HW Set Changed
                              </span>
                            )}
                            {c.progress_count.checked > 0 && (
                              <span className="ml-2 text-xs text-slate-400">
                                {c.progress_count.checked}/{c.progress_count.total} progress
                              </span>
                            )}
                          </div>
                          <div className="flex gap-1">
                            <button
                              onClick={() => setChangedTransfer((p) => ({ ...p, [c.door_number]: true }))}
                              className={`text-xs px-3 py-1 rounded transition-colors ${
                                changedTransfer[c.door_number]
                                  ? "bg-green-600 text-white"
                                  : "bg-slate-700 text-slate-400 hover:bg-slate-600"
                              }`}
                            >
                              Transfer
                            </button>
                            <button
                              onClick={() => setChangedTransfer((p) => ({ ...p, [c.door_number]: false }))}
                              className={`text-xs px-3 py-1 rounded transition-colors ${
                                !changedTransfer[c.door_number]
                                  ? "bg-orange-600 text-white"
                                  : "bg-slate-700 text-slate-400 hover:bg-slate-600"
                              }`}
                            >
                              Reset
                            </button>
                          </div>
                        </div>

                        {/* Side-by-side field changes */}
                        <div className="grid grid-cols-3 gap-1 text-xs">
                          <div className="text-slate-500 font-semibold">Field</div>
                          <div className="text-red-400/70 font-semibold">Old</div>
                          <div className="text-green-400/70 font-semibold">New</div>
                          {c.changes.map((ch) => (
                            <div key={ch.field} className="contents">
                              <div className="text-slate-400">{FIELD_LABELS[ch.field] || ch.field}</div>
                              <div className="text-red-300 font-mono">{ch.old_value || "—"}</div>
                              <div className="text-green-300 font-mono">{ch.new_value || "—"}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ─── Step 3: New Doors ─── */}
          {step === 3 && compareResult && (
            <div>
              {compareResult.added.length === 0 ? (
                <p className="text-slate-400 text-sm">No new doors in the revised submittal.</p>
              ) : (
                <>
                  <p className="text-slate-300 text-sm mb-3">
                    These <strong className="text-cyan-400">{compareResult.added.length} new doors</strong> will be
                    added to your project.
                  </p>
                  <div className="space-y-2">
                    {compareResult.added.map((a) => (
                      <div key={a.door_number} className="bg-slate-800 rounded p-3 flex items-center gap-3">
                        <span className="text-white font-mono text-sm">{a.door_number}</span>
                        <span className="text-cyan-400 text-xs">{a.hw_set}</span>
                        <span className="text-slate-500 text-xs">{a.door_type || "—"}</span>
                        <span className="text-slate-500 text-xs">{a.fire_rating || "—"}</span>
                        <span className="text-slate-500 text-xs">{a.hand || "—"}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ─── Step 4: Confirm & Apply ─── */}
          {step === 4 && compareResult && (
            <div>
              {applyResult ? (
                <div className="text-center py-8">
                  <div className="text-4xl mb-4">✓</div>
                  <h3 className="text-xl font-bold text-green-400 mb-4">Revision Applied</h3>
                  <div className="grid grid-cols-2 gap-3 max-w-sm mx-auto text-sm">
                    {applyResult.doors_added > 0 && (
                      <div className="text-slate-300">Doors added: <span className="text-cyan-400">{applyResult.doors_added}</span></div>
                    )}
                    {applyResult.doors_updated > 0 && (
                      <div className="text-slate-300">Doors updated: <span className="text-yellow-400">{applyResult.doors_updated}</span></div>
                    )}
                    {applyResult.doors_deleted > 0 && (
                      <div className="text-slate-300">Doors removed: <span className="text-red-400">{applyResult.doors_deleted}</span></div>
                    )}
                    {applyResult.doors_kept > 0 && (
                      <div className="text-slate-300">Doors kept: <span className="text-green-400">{applyResult.doors_kept}</span></div>
                    )}
                    {applyResult.progress_transferred > 0 && (
                      <div className="text-slate-300">Progress kept: <span className="text-green-400">{applyResult.progress_transferred}</span></div>
                    )}
                    {applyResult.progress_reset > 0 && (
                      <div className="text-slate-300">Progress reset: <span className="text-orange-400">{applyResult.progress_reset}</span></div>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <h3 className="text-white font-semibold mb-3">Review Changes</h3>
                  <div className="space-y-2 text-sm">
                    <div className="bg-slate-800 rounded p-3 flex justify-between">
                      <span className="text-slate-300">Unchanged doors</span>
                      <span className="text-green-400 font-mono">{compareResult.summary.matched}</span>
                    </div>
                    {compareResult.changed.length > 0 && (
                      <div className="bg-slate-800 rounded p-3">
                        <div className="flex justify-between mb-1">
                          <span className="text-slate-300">Updated doors</span>
                          <span className="text-yellow-400 font-mono">{compareResult.changed.length}</span>
                        </div>
                        <div className="text-xs text-slate-500">
                          {Object.values(changedTransfer).filter(Boolean).length} with progress transferred,{" "}
                          {Object.values(changedTransfer).filter((v) => !v).length} reset
                        </div>
                      </div>
                    )}
                    {compareResult.added.length > 0 && (
                      <div className="bg-slate-800 rounded p-3 flex justify-between">
                        <span className="text-slate-300">New doors to add</span>
                        <span className="text-cyan-400 font-mono">{compareResult.added.length}</span>
                      </div>
                    )}
                    {compareResult.removed.length > 0 && (
                      <div className="bg-slate-800 rounded p-3">
                        <div className="flex justify-between mb-1">
                          <span className="text-slate-300">Removed doors</span>
                          <span className="text-red-400 font-mono">{compareResult.removed.length}</span>
                        </div>
                        <div className="text-xs text-slate-500">
                          {Object.values(removedActions).filter((v) => v === "keep").length} kept,{" "}
                          {Object.values(removedActions).filter((v) => v === "delete").length} deleted
                        </div>
                      </div>
                    )}
                  </div>

                  {loading && (
                    <div className="flex items-center gap-2 text-cyan-400 text-sm mt-4">
                      <div className="w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
                      {status}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* ─── Footer buttons ─── */}
        <div className="flex justify-between mt-4 pt-4 border-t border-slate-800">
          {applyResult ? (
            <div className="w-full flex justify-end">
              <button
                onClick={() => { onComplete(); onClose(); }}
                className="px-6 py-2 bg-green-600 hover:bg-green-700 text-white rounded transition-colors font-semibold"
              >
                Done
              </button>
            </div>
          ) : (
            <>
              <button
                onClick={step === 0 ? onClose : handleBack}
                disabled={loading}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white rounded transition-colors"
              >
                {step === 0 ? "Cancel" : "Back"}
              </button>
              <button
                onClick={step === 4 ? applyRevision : handleNext}
                disabled={loading || !canGoNext()}
                className={`px-6 py-2 rounded transition-colors font-semibold disabled:opacity-50 ${
                  step === 4
                    ? "bg-green-600 hover:bg-green-700 text-white"
                    : "bg-cyan-600 hover:bg-cyan-700 text-white"
                }`}
              >
                {loading
                  ? "Processing..."
                  : step === 0
                  ? "Compare"
                  : step === 4
                  ? "Apply Changes"
                  : "Next"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
