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
                ? "bg-[#30d158] text-white"
                : i === current
                ? "bg-[#0a84ff] text-white ring-2 ring-[rgba(10,132,255,0.3)]"
                : "bg-white/[0.06] text-[#6e6e73]"
            }`}
          >
            {i < current ? "✓" : i + 1}
          </div>
          <span
            className={`text-xs hidden sm:inline ${
              i === current ? "text-[#0a84ff] font-semibold" : "text-[#6e6e73]"
            }`}
          >
            {label}
          </span>
          {i < total - 1 && (
            <div className={`w-4 h-px ${i < current ? "bg-[#30d158]" : "bg-white/[0.06]"}`} />
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
    <div className="fixed inset-0 bg-black/80 backdrop-blur-lg flex items-center justify-center z-50 p-4">
      <div className="bg-[#1c1c1e] rounded-2xl border border-white/[0.08] p-6 max-w-2xl w-full max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold text-[#f5f5f7]">Revised Submittal</h2>
          <button onClick={onClose} className="text-[#6e6e73] hover:text-[#f5f5f7] text-xl leading-none transition-colors">&times;</button>
        </div>

        <StepBar current={step} total={5} />

        {error && (
          <div className="mb-4 p-3 bg-[rgba(255,69,58,0.1)] border border-[rgba(255,69,58,0.2)] rounded-xl text-[#ff6961] text-sm">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-0">
          {/* ─── Step 0: Summary ─── */}
          {step === 0 && (
            <div>
              <p className="text-[#a1a1a6] mb-4">
                Your new submittal has <strong className="text-[#f5f5f7]">{parsedDoors.length} doors</strong> and{" "}
                <strong className="text-[#f5f5f7]">{parsedSets.length} hardware sets</strong>.
              </p>
              <p className="text-[#6e6e73] text-sm mb-4">
                Click &quot;Compare&quot; to see what changed compared to the current project data.
                You&apos;ll be guided through each category of changes before anything is applied.
              </p>
              {loading && (
                <div className="flex items-center gap-2 text-[#0a84ff] text-sm">
                  <div className="w-4 h-4 border-2 border-[#0a84ff] border-t-transparent rounded-full animate-spin" />
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
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-2 text-center">
                  <div className="text-lg font-bold text-[#30d158]">{compareResult.summary.matched}</div>
                  <div className="text-[9px] text-[#6e6e73] uppercase">Matched</div>
                </div>
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-2 text-center">
                  <div className="text-lg font-bold text-[#ff9500]">{compareResult.summary.changed}</div>
                  <div className="text-[9px] text-[#6e6e73] uppercase">Changed</div>
                </div>
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-2 text-center">
                  <div className="text-lg font-bold text-[#0a84ff]">{compareResult.summary.added}</div>
                  <div className="text-[9px] text-[#6e6e73] uppercase">Added</div>
                </div>
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-2 text-center">
                  <div className="text-lg font-bold text-[#ff453a]">{compareResult.summary.removed}</div>
                  <div className="text-[9px] text-[#6e6e73] uppercase">Removed</div>
                </div>
              </div>

              {compareResult.removed.length === 0 ? (
                <p className="text-[#6e6e73] text-sm">No doors were removed in the revised submittal.</p>
              ) : (
                <>
                  <p className="text-[#a1a1a6] text-sm mb-3">
                    These <strong className="text-[#ff453a]">{compareResult.removed.length} doors</strong> exist in
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
                      className="text-xs px-3 py-1 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[#a1a1a6] hover:bg-white/[0.08] transition-colors"
                    >
                      Keep All
                    </button>
                    <button
                      onClick={() => {
                        const updated: Record<string, "keep" | "delete"> = {};
                        compareResult.removed.forEach((r) => (updated[r.door_number] = "delete"));
                        setRemovedActions(updated);
                      }}
                      className="text-xs px-3 py-1 rounded-lg bg-[rgba(255,69,58,0.1)] border border-[rgba(255,69,58,0.2)] text-[#ff453a] hover:bg-[rgba(255,69,58,0.15)] transition-colors"
                    >
                      Delete All
                    </button>
                  </div>

                  <div className="space-y-2">
                    {compareResult.removed.map((r) => (
                      <div key={r.door_number} className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-3 flex items-center justify-between">
                        <div>
                          <span className="text-[#f5f5f7] font-mono text-sm">{r.door_number}</span>
                          <span className="text-[#6e6e73] text-xs ml-2">{r.hw_set || "—"}</span>
                          {r.progress_count.checked > 0 && (
                            <span className="ml-2 text-xs text-[#ff9500]">
                              {r.progress_count.checked}/{r.progress_count.total} progress
                            </span>
                          )}
                        </div>
                        <div className="flex gap-1">
                          <button
                            onClick={() => setRemovedActions((p) => ({ ...p, [r.door_number]: "keep" }))}
                            className={`text-xs px-3 py-1 rounded-lg transition-colors ${
                              removedActions[r.door_number] === "keep"
                                ? "bg-[#30d158] text-white"
                                : "bg-white/[0.04] border border-white/[0.08] text-[#a1a1a6] hover:bg-white/[0.08]"
                            }`}
                          >
                            Keep
                          </button>
                          <button
                            onClick={() => setRemovedActions((p) => ({ ...p, [r.door_number]: "delete" }))}
                            className={`text-xs px-3 py-1 rounded-lg transition-colors ${
                              removedActions[r.door_number] === "delete"
                                ? "bg-[#ff453a] text-white"
                                : "bg-white/[0.04] border border-white/[0.08] text-[#a1a1a6] hover:bg-white/[0.08]"
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
                <p className="text-[#6e6e73] text-sm">No doors had field changes.</p>
              ) : (
                <>
                  <p className="text-[#a1a1a6] text-sm mb-3">
                    These <strong className="text-[#ff9500]">{compareResult.changed.length} doors</strong> have
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
                      className="text-xs px-3 py-1 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[#a1a1a6] hover:bg-white/[0.08] transition-colors"
                    >
                      Transfer All Progress
                    </button>
                    <button
                      onClick={() => {
                        const updated: Record<string, boolean> = {};
                        compareResult.changed.forEach((c) => (updated[c.door_number] = false));
                        setChangedTransfer(updated);
                      }}
                      className="text-xs px-3 py-1 rounded-lg bg-white/[0.04] border border-white/[0.08] text-[#a1a1a6] hover:bg-white/[0.08] transition-colors"
                    >
                      Reset All Progress
                    </button>
                  </div>

                  <div className="space-y-3">
                    {compareResult.changed.map((c) => (
                      <div key={c.door_number} className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-3">
                        <div className="flex items-center justify-between mb-2">
                          <div>
                            <span className="text-[#f5f5f7] font-mono text-sm">{c.door_number}</span>
                            {c.hw_set_changed && (
                              <span className="ml-2 text-xs bg-[rgba(255,149,0,0.1)] text-[#ff9500] px-1.5 py-0.5 rounded-lg">
                                HW Set Changed
                              </span>
                            )}
                            {c.progress_count.checked > 0 && (
                              <span className="ml-2 text-xs text-[#6e6e73]">
                                {c.progress_count.checked}/{c.progress_count.total} progress
                              </span>
                            )}
                          </div>
                          <div className="flex gap-1">
                            <button
                              onClick={() => setChangedTransfer((p) => ({ ...p, [c.door_number]: true }))}
                              className={`text-xs px-3 py-1 rounded-lg transition-colors ${
                                changedTransfer[c.door_number]
                                  ? "bg-[#30d158] text-white"
                                  : "bg-white/[0.04] border border-white/[0.08] text-[#a1a1a6] hover:bg-white/[0.08]"
                              }`}
                            >
                              Transfer
                            </button>
                            <button
                              onClick={() => setChangedTransfer((p) => ({ ...p, [c.door_number]: false }))}
                              className={`text-xs px-3 py-1 rounded-lg transition-colors ${
                                !changedTransfer[c.door_number]
                                  ? "bg-[#ff9500] text-white"
                                  : "bg-white/[0.04] border border-white/[0.08] text-[#a1a1a6] hover:bg-white/[0.08]"
                              }`}
                            >
                              Reset
                            </button>
                          </div>
                        </div>

                        {/* Side-by-side field changes */}
                        <div className="grid grid-cols-3 gap-1 text-xs">
                          <div className="text-[#6e6e73] font-semibold">Field</div>
                          <div className="text-[#ff453a] font-semibold">Old</div>
                          <div className="text-[#30d158] font-semibold">New</div>
                          {c.changes.map((ch) => (
                            <div key={ch.field} className="contents">
                              <div className="text-[#6e6e73]">{FIELD_LABELS[ch.field] || ch.field}</div>
                              <div className="text-[#ff453a] line-through font-mono">{ch.old_value || "—"}</div>
                              <div className="text-[#30d158] font-mono">{ch.new_value || "—"}</div>
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
                <p className="text-[#6e6e73] text-sm">No new doors in the revised submittal.</p>
              ) : (
                <>
                  <p className="text-[#a1a1a6] text-sm mb-3">
                    These <strong className="text-[#0a84ff]">{compareResult.added.length} new doors</strong> will be
                    added to your project.
                  </p>
                  <div className="space-y-2">
                    {compareResult.added.map((a) => (
                      <div key={a.door_number} className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-3 flex items-center gap-3">
                        <span className="text-[#f5f5f7] font-mono text-sm">{a.door_number}</span>
                        <span className="text-[#0a84ff] text-xs">{a.hw_set}</span>
                        <span className="text-[#6e6e73] text-xs">{a.door_type || "—"}</span>
                        <span className="text-[#6e6e73] text-xs">{a.fire_rating || "—"}</span>
                        <span className="text-[#6e6e73] text-xs">{a.hand || "—"}</span>
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
                  <h3 className="text-xl font-bold text-[#30d158] mb-4">Revision Applied</h3>
                  <div className="grid grid-cols-2 gap-3 max-w-sm mx-auto text-sm">
                    {applyResult.doors_added > 0 && (
                      <div className="text-[#a1a1a6]">Doors added: <span className="text-[#0a84ff]">{applyResult.doors_added}</span></div>
                    )}
                    {applyResult.doors_updated > 0 && (
                      <div className="text-[#a1a1a6]">Doors updated: <span className="text-[#ff9500]">{applyResult.doors_updated}</span></div>
                    )}
                    {applyResult.doors_deleted > 0 && (
                      <div className="text-[#a1a1a6]">Doors removed: <span className="text-[#ff453a]">{applyResult.doors_deleted}</span></div>
                    )}
                    {applyResult.doors_kept > 0 && (
                      <div className="text-[#a1a1a6]">Doors kept: <span className="text-[#30d158]">{applyResult.doors_kept}</span></div>
                    )}
                    {applyResult.progress_transferred > 0 && (
                      <div className="text-[#a1a1a6]">Progress kept: <span className="text-[#30d158]">{applyResult.progress_transferred}</span></div>
                    )}
                    {applyResult.progress_reset > 0 && (
                      <div className="text-[#a1a1a6]">Progress reset: <span className="text-[#ff9500]">{applyResult.progress_reset}</span></div>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <h3 className="text-[#f5f5f7] font-semibold mb-3">Review Changes</h3>
                  <div className="space-y-2 text-sm">
                    <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 flex justify-between">
                      <span className="text-[#a1a1a6]">Unchanged doors</span>
                      <span className="text-[#30d158] font-mono">{compareResult.summary.matched}</span>
                    </div>
                    {compareResult.changed.length > 0 && (
                      <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3">
                        <div className="flex justify-between mb-1">
                          <span className="text-[#a1a1a6]">Updated doors</span>
                          <span className="text-[#ff9500] font-mono">{compareResult.changed.length}</span>
                        </div>
                        <div className="text-xs text-[#6e6e73]">
                          {Object.values(changedTransfer).filter(Boolean).length} with progress transferred,{" "}
                          {Object.values(changedTransfer).filter((v) => !v).length} reset
                        </div>
                      </div>
                    )}
                    {compareResult.added.length > 0 && (
                      <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3 flex justify-between">
                        <span className="text-[#a1a1a6]">New doors to add</span>
                        <span className="text-[#0a84ff] font-mono">{compareResult.added.length}</span>
                      </div>
                    )}
                    {compareResult.removed.length > 0 && (
                      <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-3">
                        <div className="flex justify-between mb-1">
                          <span className="text-[#a1a1a6]">Removed doors</span>
                          <span className="text-[#ff453a] font-mono">{compareResult.removed.length}</span>
                        </div>
                        <div className="text-xs text-[#6e6e73]">
                          {Object.values(removedActions).filter((v) => v === "keep").length} kept,{" "}
                          {Object.values(removedActions).filter((v) => v === "delete").length} deleted
                        </div>
                      </div>
                    )}
                  </div>

                  {loading && (
                    <div className="flex items-center gap-2 text-[#0a84ff] text-sm mt-4">
                      <div className="w-4 h-4 border-2 border-[#0a84ff] border-t-transparent rounded-full animate-spin" />
                      {status}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* ─── Footer buttons ─── */}
        <div className="flex justify-between mt-4 pt-4 border-t border-white/[0.08]">
          {applyResult ? (
            <div className="w-full flex justify-end">
              <button
                onClick={() => { onComplete(); onClose(); }}
                className="px-6 py-2 bg-[#30d158] hover:bg-[#26c14a] text-white rounded-lg transition-colors font-semibold"
              >
                Done
              </button>
            </div>
          ) : (
            <>
              <button
                onClick={step === 0 ? onClose : handleBack}
                disabled={loading}
                className="px-4 py-2 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.08] disabled:opacity-50 text-[#a1a1a6] rounded-lg transition-colors"
              >
                {step === 0 ? "Cancel" : "Back"}
              </button>
              <button
                onClick={step === 4 ? applyRevision : handleNext}
                disabled={loading || !canGoNext()}
                className={`px-6 py-2 rounded-lg transition-colors font-semibold disabled:opacity-50 ${
                  step === 4
                    ? "bg-[#30d158] hover:bg-[#26c14a] text-white"
                    : "bg-[#0a84ff] hover:bg-[#0975de] text-white"
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
