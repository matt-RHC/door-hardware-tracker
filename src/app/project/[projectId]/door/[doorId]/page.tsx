"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import OfflineIndicator from "@/components/OfflineIndicator";
import ProgressBar from "@/components/ProgressBar";
import FileViewer from "@/components/FileViewer";
import IssueReportModal from "@/components/IssueReportModal";
import { createClient } from "@/lib/supabase/client";
import { initDB, cacheOpening, getCachedOpening } from "@/lib/offline/db";
import { Opening, Attachment, HardwareItemWithProgress } from "@/lib/types/database";
import { playSuccess, playToggle } from "@/lib/sounds";
import { useItemEditing } from "@/hooks/useItemEditing";
import { useOpeningEditing } from "@/hooks/useOpeningEditing";
import { useClassification } from "@/hooks/useClassification";
import { useToast } from "@/components/ToastProvider";
import { openProjectPdfAtPage } from "@/lib/pdf-page-link";
import { groupItemsByLeaf, getLeafDisplayQty, getLeafProgress } from "@/lib/classify-leaf-items";
import { classifyItemScope } from "@/lib/parse-pdf-helpers";

interface OpeningDetail extends Opening {
  hardware_items: HardwareItemWithProgress[];
  attachments: Attachment[];
}

export default function DoorDetailPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const doorId = params.doorId as string;
  const router = useRouter();

  const [opening, setOpening] = useState<OpeningDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesSaved, setNotesSaved] = useState(false);
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'hardware' | 'files' | 'notes' | 'qr'>('hardware');
  const [viewingAttachment, setViewingAttachment] = useState<Attachment | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [issueModal, setIssueModal] = useState<{ doorNumber: string; hardwareItemName: string } | null>(null);
  const [activeLeafTab, setActiveLeafTab] = useState<'shared' | 'leaf1' | 'leaf2'>('leaf1');

  const supabase = createClient();
  const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { showToast } = useToast();

  const fetchOpeningData = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/projects/${projectId}/openings/${doorId}`
      );
      if (!response.ok) throw new Error("Failed to fetch opening");
      const data: OpeningDetail = await response.json();
      setOpening(data);
      setNotes(data.notes || "");
      await cacheOpening(data);
      setError(null);
    } catch (err) {
      // Try to get from cache
      const cached = await getCachedOpening(doorId);
      if (cached) {
        setOpening(cached);
      } else {
        setError(err instanceof Error ? err.message : "An error occurred");
      }
    } finally {
      setLoading(false);
    }
  }, [projectId, doorId]);

  const debouncedFetch = useCallback(() => {
    if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
    fetchDebounceRef.current = setTimeout(() => fetchOpeningData(), 300);
  }, [fetchOpeningData]);

  // Extracted hooks
  const itemEditing = useItemEditing({ projectId, doorId, opening, fetchOpeningData });
  const openingEditing = useOpeningEditing({ projectId, doorId, opening, fetchOpeningData });
  const classification = useClassification({ projectId, doorId, opening, fetchOpeningData });

  useEffect(() => {
    initDB().then(() => fetchOpeningData());
  }, [doorId, fetchOpeningData]);

  // Subscribe to realtime updates
  useEffect(() => {
    if (!opening) return;

    const subscription = (supabase as any)
      .channel(`checklist_progress:opening_id=eq.${doorId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "checklist_progress",
          filter: `opening_id=eq.${doorId}`,
        },
        () => {
          debouncedFetch();
        }
      )
      .subscribe();

    return () => {
      (supabase as any).removeChannel(subscription);
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
    };
  }, [opening, doorId, debouncedFetch, supabase]);

  type WorkflowStep = 'received' | 'pre_install' | 'installed' | 'qa_qc';

  const handleStepToggle = async (itemId: string, step: WorkflowStep, currentValue: boolean, leafIndex: number = 1) => {
    try {
      const response = await fetch(
        `/api/openings/${doorId}/check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            item_id: itemId,
            leaf_index: leafIndex,
            step,
            value: !currentValue,
          }),
        }
      );

      if (!response.ok) throw new Error("Failed to update step");

      // Fetch and check if the entire stage is now complete
      const updatedData = await fetch(`/api/openings/${doorId}`).then(r => r.json());
      const item = updatedData?.hardware_items?.find((i: any) => i.id === itemId);

      if (item) {
        // Check if all workflow steps for this item are now complete
        const allStepsComplete = ['bench_staged', 'bench_inspect', 'field_staged', 'field_inspect'].every(
          s => !(item.progress as any)?.[s] === false
        );

        if (allStepsComplete && item.progress?.qa_qc) {
          playSuccess();
        }
      }

      await fetchOpeningData();
    } catch (err) {
      console.error("Error toggling step:", err);
      showToast("error", "Failed to update step. Check your connection and try again.");
    }
  };

  // Legacy toggle for backward compat
  const handleItemToggle = async (itemId: string, currentChecked: boolean) => {
    try {
      const response = await fetch(
        `/api/openings/${doorId}/check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            item_id: itemId,
            checked: !currentChecked,
          }),
        }
      );

      if (!response.ok) throw new Error("Failed to update item");
      await fetchOpeningData();
    } catch (err) {
      console.error("Error toggling item:", err);
      showToast("error", "Failed to update item. Check your connection and try again.");
    }
  };

  const handleSaveNotes = async () => {
    setSavingNotes(true);
    setNotesSaved(false);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/openings/${doorId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes }),
        }
      );

      if (!response.ok) throw new Error("Failed to save notes");
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 2000);
    } catch (err) {
      console.error("Error saving notes:", err);
      showToast("error", "Failed to save notes. Please try again.");
    } finally {
      setSavingNotes(false);
    }
  };

  const handleViewPdfPage = useCallback(async () => {
    if (opening?.pdf_page == null) return;
    const result = await openProjectPdfAtPage(projectId, opening.pdf_page);
    if (!result.ok) {
      showToast("error", `Couldn't open PDF page: ${result.error}`);
    }
  }, [opening, projectId, showToast]);

  const handleFileUpload = async (file: File) => {
    setAttachmentLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(
        `/api/openings/${doorId}/attachments`,
        {
          method: "POST",
          body: formData,
        }
      );

      if (!response.ok) throw new Error("Failed to upload attachment");
      await fetchOpeningData();
    } catch (err) {
      console.error("Error uploading attachment:", err);
      showToast("error", "Failed to upload attachment. Check your connection and try again.");
    } finally {
      setAttachmentLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--background)] flex items-center justify-center">
        <div className="text-[var(--text-secondary)]">Loading...</div>
      </div>
    );
  }

  if (error && !opening) {
    return (
      <div className="min-h-screen bg-[var(--background)] p-4">
        <div className="p-4 bg-danger-dim border border-[var(--red)] rounded-lg text-[var(--red)]">
          {error}
        </div>
      </div>
    );
  }

  if (!opening) return null;

  // --- Per-leaf grouping ---
  const leafCount = (opening as any).leaf_count ?? 1;
  const isPair = leafCount >= 2;
  const { shared, leaf1, leaf2 } = groupItemsByLeaf(opening.hardware_items, leafCount);

  // Progress: count each leaf section's items independently
  const countLeafComplete = (items: HardwareItemWithProgress[], leafIndex: number) =>
    items.filter(item => {
      const p = getLeafProgress(item, leafIndex);
      return p?.qa_qc || p?.checked;
    }).length;

  const totalItems = shared.length + leaf1.length + (isPair ? leaf2.length : 0);
  const checkedItems = countLeafComplete(shared, 1) + countLeafComplete(leaf1, 1) + (isPair ? countLeafComplete(leaf2, 2) : 0);
  const progress = totalItems > 0 ? (checkedItems / totalItems) * 100 : 0;

  // Workflow step helper
  const getStepLabel = (_item: HardwareItemWithProgress, step: WorkflowStep): string => {
    if (step === 'received') return 'Received';
    if (step === 'pre_install') return 'Pre-Install';
    if (step === 'installed') return 'Installed';
    if (step === 'qa_qc') return 'QA/QC';
    return step;
  };

  const getStepValue = (item: HardwareItemWithProgress, step: WorkflowStep, leafIndex: number = 1): boolean => {
    const p = getLeafProgress(item, leafIndex);
    if (!p) return false;
    return !!(p as any)[step];
  };

  const getWorkflowSteps = (item: HardwareItemWithProgress): WorkflowStep[] => {
    if (item.install_type === 'bench') return ['received', 'pre_install', 'qa_qc'];
    if (item.install_type === 'field') return ['received', 'installed', 'qa_qc'];
    // Default: show received and qa_qc until install_type is set
    return ['received', 'qa_qc'];
  };
  const qrUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/project/${projectId}/door/${doorId}`;

  // Build a display label for the item spec line
  const formatSpec = (item: HardwareItemWithProgress) => {
    const parts: string[] = [];
    if (item.manufacturer) parts.push(item.manufacturer);
    if (item.model) parts.push(item.model);
    if (item.finish) parts.push(item.finish);
    return parts.join(" · ");
  };

  // Destructure hooks for cleaner JSX
  const {
    editingItemId, editingItem, setEditingItem, savingItem,
    editApplyAllPrompt, editApplyAllLoading, dontAskEditApplyAll, setDontAskEditApplyAll,
    startEditItem, cancelEditItem, saveEditItem, saveSingleItem, applyBulkItemUpdate,
  } = itemEditing;

  const {
    editingOpening, editingOpeningData, setEditingOpeningData,
    savingOpening, startEditOpening, cancelEditOpening, saveEditOpening,
  } = openingEditing;

  const {
    classifyPrompt, classifyLoading, dontAskClassify, setDontAskClassify,
    setClassifyPrompt, handleInstallTypeChange, applySingleClassification, applyClassification,
  } = classification;

  // --- Item card renderer (shared across all leaf sections) ---
  const renderItemCard = (item: HardwareItemWithProgress, leafIndex: number) => {
    const scope = classifyItemScope(item.name);
    const displayQty = getLeafDisplayQty(item, leafCount, scope);
    // Use composite key for per-leaf items that appear on both leaves
    const cardKey = `${item.id}-leaf${leafIndex}`;

    return (
      <div
        key={cardKey}
        className={`glow-card p-4 shadow-sm ${
          item.install_type === 'bench'
            ? 'glow-card--purple corner-brackets'
            : item.install_type === 'field'
            ? 'glow-card--orange corner-brackets'
            : ''
        }`}
      >
        {editingItemId === item.id && editingItem ? (
          // Edit mode (only shown on one leaf — prevents double-edit confusion)
          leafIndex === 1 ? (
            <div className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] text-[var(--text-secondary)] mb-1">Name</label>
                  <input
                    type="text"
                    value={editingItem.name}
                    onChange={(e) => setEditingItem({ ...editingItem, name: e.target.value })}
                    className="w-full px-3 py-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:border-[var(--blue-dim)] focus:outline-none text-[13px]"
                  />
                </div>
                <div>
                  <label className="block text-[12px] text-[var(--text-secondary)] mb-1">Qty</label>
                  <input
                    type="number"
                    value={editingItem.qty}
                    onChange={(e) => setEditingItem({ ...editingItem, qty: parseInt(e.target.value) || 0 })}
                    className="w-full px-3 py-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:border-[var(--blue-dim)] focus:outline-none text-[13px]"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[12px] text-[var(--text-secondary)] mb-1">Manufacturer</label>
                  <input type="text" value={editingItem.manufacturer || ""} onChange={(e) => setEditingItem({ ...editingItem, manufacturer: e.target.value || null })} placeholder="Optional" className="w-full px-3 py-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:border-[var(--blue-dim)] focus:outline-none text-[13px]" />
                </div>
                <div>
                  <label className="block text-[12px] text-[var(--text-secondary)] mb-1">Model</label>
                  <input type="text" value={editingItem.model || ""} onChange={(e) => setEditingItem({ ...editingItem, model: e.target.value || null })} placeholder="Optional" className="w-full px-3 py-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:border-[var(--blue-dim)] focus:outline-none text-[13px]" />
                </div>
                <div>
                  <label className="block text-[12px] text-[var(--text-secondary)] mb-1">Finish</label>
                  <input type="text" value={editingItem.finish || ""} onChange={(e) => setEditingItem({ ...editingItem, finish: e.target.value || null })} placeholder="Optional" className="w-full px-3 py-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:border-[var(--blue-dim)] focus:outline-none text-[13px]" />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] text-[var(--text-secondary)] mb-1">Options</label>
                  <input type="text" value={editingItem.options || ""} onChange={(e) => setEditingItem({ ...editingItem, options: e.target.value || null })} placeholder="Optional" className="w-full px-3 py-2 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:border-[var(--blue-dim)] focus:outline-none text-[13px]" />
                </div>
                <div>
                  <label className="block text-[12px] text-[var(--text-secondary)] mb-1">Install Type</label>
                  <select
                    value={editingItem.install_type || ""}
                    onChange={(e) => setEditingItem({ ...editingItem, install_type: (e.target.value as 'bench' | 'field') || null })}
                    className="w-full px-3 py-2 min-h-[44px] bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] focus:border-accent focus:outline-none text-[13px]"
                  >
                    <option value="">Not set</option>
                    <option value="bench">Bench</option>
                    <option value="field">Field</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-2 pt-2">
                <button onClick={saveEditItem} disabled={savingItem} className="flex-1 px-3 py-2 min-h-[44px] bg-[var(--blue)] hover:bg-[var(--blue)]/80 disabled:bg-[var(--surface)] text-white disabled:text-[var(--text-tertiary)] rounded-lg transition-colors text-[13px] font-medium">
                  {savingItem ? "Saving..." : "Save"}
                </button>
                <button onClick={cancelEditItem} disabled={savingItem} className="flex-1 px-3 py-2 min-h-[44px] bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--surface-hover)] disabled:opacity-50 text-[var(--text-secondary)] rounded-lg transition-colors text-[13px] font-medium">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="text-[var(--text-tertiary)] text-[13px] italic text-center py-4">Editing on Leaf 1...</p>
          )
        ) : (
          // View mode
          <>
            {/* Header row: item name + compact install-type toggle */}
            <div className="flex justify-between items-start gap-3 mb-2">
              <div className="flex-1 min-w-0">
                <h3
                  className="text-[18px] font-bold uppercase text-[var(--text-primary)] leading-tight break-words"
                  style={{ fontFamily: "var(--font-display)", letterSpacing: "0.02em" }}
                >
                  {item.name}
                </h3>
                {formatSpec(item) && (
                  <p className="text-[13px] text-[var(--text-secondary)] mt-1">
                    {formatSpec(item)}
                  </p>
                )}
                <div className="flex items-center gap-2 mt-1">
                  {displayQty > 0 && (
                    <span
                      className="text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md border"
                      style={{
                        fontFamily: "var(--font-display)",
                        color: "var(--cyan)",
                        background: "var(--cyan-dim)",
                        borderColor: "var(--cyan)",
                        letterSpacing: "0.06em",
                      }}
                    >
                      Qty {displayQty}
                    </span>
                  )}
                  {item.options && (
                    <span className="text-[11px] text-[var(--text-tertiary)] truncate">
                      {item.options}
                    </span>
                  )}
                </div>
              </div>

              {/* Install-type compact toggle pair */}
              <div
                className="flex shrink-0 rounded-md overflow-hidden border"
                style={{ borderColor: "var(--border)", background: "var(--surface-raised)" }}
                role="group"
                aria-label="Install type"
              >
                <button
                  type="button"
                  onClick={() => handleInstallTypeChange(item.id, 'bench')}
                  aria-pressed={item.install_type === 'bench'}
                  title="Classify as bench"
                  className="min-w-[44px] min-h-[44px] px-2 text-[11px] font-semibold uppercase transition-colors"
                  style={{
                    fontFamily: "var(--font-display)",
                    letterSpacing: "0.06em",
                    background: item.install_type === 'bench' ? "var(--purple-dim)" : "transparent",
                    color: item.install_type === 'bench' ? "var(--purple)" : "var(--text-tertiary)",
                    boxShadow: item.install_type === 'bench' ? "inset 0 0 0 1px var(--purple)" : "none",
                  }}
                >
                  Bench
                </button>
                <button
                  type="button"
                  onClick={() => handleInstallTypeChange(item.id, 'field')}
                  aria-pressed={item.install_type === 'field'}
                  title="Classify as field"
                  className="min-w-[44px] min-h-[44px] px-2 text-[11px] font-semibold uppercase transition-colors"
                  style={{
                    fontFamily: "var(--font-display)",
                    letterSpacing: "0.06em",
                    background: item.install_type === 'field' ? "var(--orange-dim)" : "transparent",
                    color: item.install_type === 'field' ? "var(--orange)" : "var(--text-tertiary)",
                    boxShadow: item.install_type === 'field' ? "inset 0 0 0 1px var(--orange)" : "none",
                    borderLeft: "1px solid var(--border)",
                  }}
                >
                  Field
                </button>
              </div>
            </div>

            {/* Workflow steps with green checks (per-leaf aware) */}
            <div className="flex flex-wrap items-center gap-2 mt-3">
              {getWorkflowSteps(item).map((step, idx) => {
                const isActive = getStepValue(item, step, leafIndex);
                const label = getStepLabel(item, step);
                return (
                  <div key={step} className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        playToggle();
                        handleStepToggle(item.id, step, isActive, leafIndex);
                      }}
                      className="flex items-center justify-center w-12 h-12 rounded-full transition-colors"
                      style={{
                        background: isActive ? 'var(--green)' : 'transparent',
                        border: isActive ? '2px solid var(--green)' : `2px solid var(--border-hover)`,
                      }}
                    >
                      {isActive && (
                        <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      )}
                    </button>
                    <span
                      className="text-[10px] uppercase font-semibold"
                      style={{
                        fontFamily: "var(--font-display)",
                        letterSpacing: "0.06em",
                        color: isActive ? 'var(--green)' : 'var(--text-tertiary)',
                      }}
                    >
                      {label}
                    </span>
                    {idx < getWorkflowSteps(item).length - 1 && (
                      <div
                        className="w-6 h-0.5"
                        style={{
                          background: isActive ? 'var(--green)' : 'var(--border)',
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Bottom action row: edit + report issue */}
            <div className="flex items-center justify-end gap-2 mt-3 pt-2 border-t border-[var(--border)]">
              <button
                onClick={() => startEditItem(item)}
                className="text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] min-h-[44px] min-w-[44px] flex items-center justify-center transition-colors"
                title="Edit item"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                onClick={() => setIssueModal({
                  doorNumber: opening.door_number,
                  hardwareItemName: item.name,
                })}
                className="text-[11px] uppercase text-[var(--red)] hover:text-[var(--red)]/80 transition-colors min-h-[44px] px-2 flex items-center"
                style={{ fontFamily: "var(--font-display)", letterSpacing: "0.06em" }}
              >
                Report Issue
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[var(--background)] pb-28">
      <OfflineIndicator />

      {/* Sticky Header */}
      <header className="sticky top-0 z-50 bg-[var(--background)]/85 backdrop-blur-xl border-b border-[var(--border)]">
        <div className="max-w-[430px] md:max-w-[900px] mx-auto px-4 py-4 flex items-center justify-between">
          <button
            onClick={() => router.push(`/project/${projectId}`)}
            className="text-[var(--blue)] hover:text-[var(--blue)]/80 flex items-center gap-1 text-[15px] min-h-[44px] min-w-[44px] justify-center"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-[17px] font-semibold text-[var(--text-primary)]">
            Door {opening.door_number}
          </h1>
          {!editingOpening && (
            <button
              onClick={startEditOpening}
              className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] min-h-[44px] min-w-[44px] flex items-center justify-center"
              title="Edit door details"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          )}
        </div>
      </header>

      <main className="max-w-[430px] md:max-w-[900px] mx-auto px-4 py-6">
        {/* Edit Opening Form (full width, above hero) */}
        {editingOpening && editingOpeningData && (
          <div className="mb-6 bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 space-y-4">
            <div>
              <label className="block text-[13px] text-[var(--text-secondary)] mb-2">Door Number</label>
              <input
                type="text"
                value={editingOpeningData.door_number}
                onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, door_number: e.target.value } : null)}
                className="w-full px-3 py-2.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:border-[var(--blue-dim)] focus:outline-none text-[15px]"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] text-[var(--text-secondary)] mb-2">HW Set</label>
                <input
                  type="text"
                  value={editingOpeningData.hw_set || ""}
                  onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, hw_set: e.target.value || null } : null)}
                  placeholder="Optional"
                  className="w-full px-3 py-2.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:border-[var(--blue-dim)] focus:outline-none text-[15px]"
                />
              </div>
              <div>
                <label className="block text-[13px] text-[var(--text-secondary)] mb-2">Location</label>
                <input
                  type="text"
                  value={editingOpeningData.location || ""}
                  onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, location: e.target.value || null } : null)}
                  placeholder="Optional"
                  className="w-full px-3 py-2.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:border-[var(--blue-dim)] focus:outline-none text-[15px]"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] text-[var(--text-secondary)] mb-2">Door Type</label>
                <input
                  type="text"
                  value={editingOpeningData.door_type || ""}
                  onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, door_type: e.target.value || null } : null)}
                  placeholder="Optional"
                  className="w-full px-3 py-2.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:border-[var(--blue-dim)] focus:outline-none text-[15px]"
                />
              </div>
              <div>
                <label className="block text-[13px] text-[var(--text-secondary)] mb-2">Frame Type</label>
                <input
                  type="text"
                  value={editingOpeningData.frame_type || ""}
                  onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, frame_type: e.target.value || null } : null)}
                  placeholder="Optional"
                  className="w-full px-3 py-2.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:border-[var(--blue-dim)] focus:outline-none text-[15px]"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] text-[var(--text-secondary)] mb-2">Fire Rating</label>
                <input
                  type="text"
                  value={editingOpeningData.fire_rating || ""}
                  onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, fire_rating: e.target.value || null } : null)}
                  placeholder="Optional"
                  className="w-full px-3 py-2.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:border-[var(--blue-dim)] focus:outline-none text-[15px]"
                />
              </div>
              <div>
                <label className="block text-[13px] text-[var(--text-secondary)] mb-2">Hand</label>
                <input
                  type="text"
                  value={editingOpeningData.hand || ""}
                  onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, hand: e.target.value || null } : null)}
                  placeholder="Optional"
                  className="w-full px-3 py-2.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:border-[var(--blue-dim)] focus:outline-none text-[15px]"
                />
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={saveEditOpening}
                disabled={savingOpening}
                className="flex-1 px-4 py-2.5 min-h-[44px] bg-[var(--blue)] hover:bg-[var(--blue)]/80 disabled:bg-[var(--surface)] text-white disabled:text-[var(--text-tertiary)] rounded-lg transition-colors text-[15px] font-medium"
              >
                {savingOpening ? "Saving..." : "Save"}
              </button>
              <button
                onClick={cancelEditOpening}
                disabled={savingOpening}
                className="flex-1 px-4 py-2.5 min-h-[44px] bg-[var(--surface)] border border-[var(--border)] hover:bg-[var(--surface-hover)] disabled:opacity-50 text-[var(--text-secondary)] rounded-lg transition-colors text-[15px] font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Hero Card */}
        {!editingOpening && (
          <div className="mb-6 bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4">
            <h1 className="text-[34px] md:text-[42px] font-bold tracking-tight text-[var(--text-primary)] mb-2">
              {opening.door_number}
            </h1>

            {opening.hw_set && (
              <div className="mb-3 flex items-center gap-2">
                <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-success-dim border border-[var(--green)] text-[12px] font-medium text-[var(--green)]">
                  {opening.hw_set}
                  {opening.hw_heading && ` — ${opening.hw_heading}`}
                </span>
              </div>
            )}

            {opening.location && (
              <p className="text-[15px] text-[var(--text-secondary)] mb-3">
                {opening.location}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              {opening.door_type && (
                <span className="text-[11px] font-medium uppercase text-[var(--text-tertiary)] bg-[var(--surface)] border border-[var(--border)] px-2 py-1 rounded-full">
                  {opening.door_type}
                </span>
              )}
              {opening.fire_rating && (
                <span className="text-[11px] font-medium uppercase text-[var(--red)] bg-danger-dim border border-[var(--red)] px-2 py-1 rounded-full">
                  {opening.fire_rating}
                </span>
              )}
              {opening.hand && (
                <span className="text-[11px] font-medium uppercase text-[var(--text-tertiary)] bg-[var(--surface)] border border-[var(--border)] px-2 py-1 rounded-full">
                  {opening.hand}
                </span>
              )}
              {opening.pdf_page != null && (
                <button
                  type="button"
                  onClick={handleViewPdfPage}
                  className="text-[11px] font-medium uppercase text-accent bg-accent-dim border border-accent px-2 py-1 rounded-full hover:opacity-80 transition-opacity"
                  title={`Open submittal PDF at page ${opening.pdf_page + 1}`}
                >
                  PDF p.{opening.pdf_page + 1}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Progress Bar */}
        {!editingOpening && (
          <div className="mb-6">
            <div className="flex justify-between items-center mb-2">
              <span className="text-[11px] uppercase font-medium text-[var(--text-tertiary)]">Progress</span>
              <span className="text-[13px] text-[var(--text-secondary)]">
                {checkedItems} / {totalItems}
              </span>
            </div>
            <ProgressBar
              value={progress}
              size="lg"
              showLabel={false}
            />
          </div>
        )}

        {/* Tab Navigation */}
        {!editingOpening && (
          <div className="flex gap-0.5 mb-6 bg-[var(--surface)] rounded-lg p-1">
            {(['hardware', 'files', 'notes', 'qr'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 px-3 py-3 min-h-[44px] rounded-lg text-[13px] font-medium uppercase transition-colors ${
                  activeTab === tab
                    ? 'bg-[var(--surface-hover)] text-[var(--text-primary)] border border-[var(--border-hover)]'
                    : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
                }`}
              >
                {tab === 'qr' ? 'QR' : tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
        )}

        {/* Hardware Tab */}
        {activeTab === 'hardware' && !editingOpening && (
          <div className="mb-8">
            {opening.hardware_items.length === 0 ? (
              <p className="text-[var(--text-secondary)] text-center py-8">No hardware items yet</p>
            ) : isPair ? (
              <>
                {/* Leaf sub-tabs for pair doors */}
                <div className="flex gap-0.5 mb-5 bg-[var(--surface)] rounded-lg p-1">
                  {([
                    { key: 'shared' as const, label: 'Shared', count: shared.length, color: 'var(--text-tertiary)' },
                    { key: 'leaf1' as const, label: 'Leaf 1', count: leaf1.length, color: 'var(--cyan)' },
                    { key: 'leaf2' as const, label: 'Leaf 2', count: leaf2.length, color: 'var(--orange)' },
                  ]).map((tab) => (
                    <button
                      key={tab.key}
                      onClick={() => setActiveLeafTab(tab.key)}
                      className={`flex-1 px-2 py-3 min-h-[44px] rounded-lg text-[11px] font-semibold uppercase transition-colors flex flex-col items-center gap-0.5 ${
                        activeLeafTab === tab.key
                          ? 'bg-[var(--surface-hover)] border border-[var(--border-hover)]'
                          : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
                      }`}
                      style={{
                        fontFamily: "var(--font-display)",
                        letterSpacing: "0.06em",
                        color: activeLeafTab === tab.key ? tab.color : undefined,
                      }}
                    >
                      <span>{tab.label}</span>
                      <span className="text-[10px] opacity-60">{tab.count} items</span>
                    </button>
                  ))}
                </div>

                {/* Active leaf section content */}
                <div className="space-y-5">
                  {activeLeafTab === 'shared' && shared.map((item) => renderItemCard(item, 1))}
                  {activeLeafTab === 'shared' && shared.length === 0 && (
                    <p className="text-[var(--text-tertiary)] text-center py-6 text-[13px]">No shared items for this opening</p>
                  )}
                  {activeLeafTab === 'leaf1' && leaf1.map((item) => renderItemCard(item, 1))}
                  {activeLeafTab === 'leaf2' && leaf2.map((item) => renderItemCard(item, 2))}
                </div>
              </>
            ) : (
              /* Single door — flat list, no sub-tabs */
              <div className="space-y-5">
                {opening.hardware_items.map((item) => renderItemCard(item, 1))}
              </div>
            )}
          </div>
        )}

        {/* Files Tab */}
        {activeTab === 'files' && !editingOpening && (
          <div className="space-y-4 mb-8">
            {/* Category filter pills */}
            <div className="flex flex-wrap gap-2">
              {[
                { label: 'All', value: null },
                { label: 'Floor Plan', value: 'floor_plan' },
                { label: 'Door Drawing', value: 'door_drawing' },
                { label: 'Frame Drawing', value: 'frame_drawing' },
                { label: 'General', value: 'general' },
              ].map((cat) => (
                <button
                  key={cat.label}
                  onClick={() => setActiveCategory(cat.value)}
                  className={`text-[12px] font-medium px-3 py-1.5 min-h-[44px] rounded-full transition-colors ${
                    activeCategory === cat.value
                      ? 'bg-accent-dim border border-[var(--blue)] text-[var(--blue)]'
                      : 'bg-[var(--surface)] border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>

            {/* Attachment cards */}
            {(opening.attachments ?? []).length > 0 ? (
              <div className="space-y-3">
                {(opening.attachments ?? [])
                  .filter((att) => !activeCategory || att.category === activeCategory)
                  .map((attachment) => {
                    const isPdf = attachment.file_type?.includes("pdf") || attachment.file_name?.toLowerCase().endsWith(".pdf");
                    const isImage = attachment.file_type?.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(attachment.file_name || "");

                    return (
                      <button
                        key={attachment.id}
                        onClick={() => setViewingAttachment(attachment)}
                        className="w-full text-left bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden hover:bg-[var(--surface-hover)] hover:border-[var(--border-hover)] transition-colors group"
                      >
                        {/* Preview area */}
                        <div className="relative w-full h-40 bg-[var(--surface)] overflow-hidden">
                          {isImage ? (
                            <img
                              src={attachment.file_url}
                              alt={attachment.file_name || ""}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            />
                          ) : isPdf ? (
                            <div className="w-full h-full flex flex-col items-center justify-center gap-2">
                              <svg className="w-10 h-10 text-[var(--red)]" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM6 20V4h7v5h5v11H6z" />
                                <path d="M8 14h2v2H8v-2zm3 0h2v2h-2v-2zm3 0h2v2h-2v-2z" />
                              </svg>
                              <span className="text-[11px] font-medium text-[var(--red)] uppercase tracking-wider">PDF</span>
                            </div>
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <svg className="w-10 h-10 text-[var(--text-tertiary)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                              </svg>
                            </div>
                          )}

                          {/* Tap to view overlay */}
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                            <span className="opacity-0 group-hover:opacity-100 text-[13px] font-medium text-white bg-black/50 backdrop-blur-sm px-4 py-2 rounded-full transition-opacity">
                              Tap to view
                            </span>
                          </div>
                        </div>

                        {/* File info */}
                        <div className="p-3 flex items-center justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-[13px] font-medium text-[var(--text-primary)] truncate">
                              {attachment.file_name}
                            </p>
                            <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5 capitalize">
                              {(attachment.category || 'general').replace('_', ' ')}
                              {attachment.uploaded_at && ` · ${new Date(attachment.uploaded_at).toLocaleDateString()}`}
                            </p>
                          </div>
                          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-[var(--surface)] border border-[var(--border)] flex items-center justify-center">
                            <svg className="w-4 h-4 text-[var(--blue)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                            </svg>
                          </div>
                        </div>
                      </button>
                    );
                  })}
              </div>
            ) : (
              <div className="text-center py-8">
                <svg className="w-12 h-12 text-[var(--text-tertiary)] mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
                <p className="text-[var(--text-secondary)] text-[15px]">No files yet</p>
                <p className="text-[var(--text-tertiary)] text-[12px] mt-1">Upload drawings, plans, or photos</p>
              </div>
            )}

            {/* Upload button */}
            <label className="block p-4 min-h-[44px] bg-[var(--surface)] border border-dashed border-[var(--border)] rounded-xl text-center cursor-pointer hover:bg-[var(--surface-hover)] active:bg-[var(--surface-hover)] transition-colors">
              <input
                type="file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileUpload(file);
                }}
                disabled={attachmentLoading}
                className="hidden"
                accept="image/*,application/pdf"
              />
              <div className="flex items-center justify-center gap-2">
                <svg className="w-5 h-5 text-[var(--blue)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                <p className="text-[15px] font-medium text-[var(--text-primary)]">
                  {attachmentLoading ? "Uploading..." : "Upload File"}
                </p>
              </div>
              <p className="text-[12px] text-[var(--text-tertiary)] mt-1">
                Images or PDF · Tap to browse
              </p>
            </label>
          </div>
        )}

        {/* Notes Tab */}
        {activeTab === 'notes' && !editingOpening && (
          <div className="mb-8">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add notes about this opening..."
              className="w-full px-4 py-3 bg-[var(--surface)] border border-[var(--border)] rounded-xl text-[var(--text-primary)] placeholder-[var(--text-tertiary)] focus:border-[var(--blue-dim)] focus:outline-none min-h-32 resize-none text-[15px]"
            />
            <button
              onClick={handleSaveNotes}
              disabled={savingNotes}
              className="mt-4 px-4 py-2.5 min-h-[44px] bg-[var(--blue)] hover:bg-[var(--blue)]/80 disabled:bg-[var(--surface)] text-white disabled:text-[var(--text-tertiary)] rounded-lg transition-colors text-[15px] font-medium"
            >
              {savingNotes ? "Saving..." : notesSaved ? "Saved!" : "Save Notes"}
            </button>
          </div>
        )}

        {/* QR Tab */}
        {activeTab === 'qr' && !editingOpening && (
          <div className="flex flex-col items-center justify-center py-8 mb-8">
            <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 mb-4">
              <QRCodeSVG
                value={qrUrl}
                size={200}
                level="H"
                includeMargin={true}
              />
            </div>
            <p className="text-[15px] text-[var(--text-secondary)] text-center mb-4">
              Scan to open this door on mobile
            </p>
            <button className="px-4 py-2.5 min-h-[44px] bg-[var(--blue)] hover:bg-[var(--blue)]/80 text-white rounded-lg transition-colors text-[15px] font-medium">
              Share
            </button>
          </div>
        )}
      </main>

      {/* Bottom Navigation Bar */}
      <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] md:max-w-[900px] bg-[var(--background)]/90 backdrop-blur-xl border-t border-[var(--border)] pb-[env(safe-area-inset-bottom)] h-16 flex items-center justify-around z-50">
        {(['hardware', 'files', 'notes', 'qr'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex flex-col items-center gap-1 px-3 py-2 min-h-[44px] min-w-[44px] transition-colors ${
              activeTab === tab
                ? 'text-[var(--blue)]'
                : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'
            }`}
          >
            {tab === 'hardware' && (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            )}
            {tab === 'files' && (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            )}
            {tab === 'notes' && (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            )}
            {tab === 'qr' && (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            )}
            <span className="text-[10px] uppercase font-medium">
              {tab === 'qr' ? 'QR' : tab.charAt(0).toUpperCase() + tab.slice(1)}
            </span>
          </button>
        ))}
      </nav>

      {/* File Viewer Overlay */}
      {viewingAttachment && (
        <FileViewer
          attachment={viewingAttachment}
          onClose={() => setViewingAttachment(null)}
        />
      )}

      {issueModal && (
        <IssueReportModal
          projectId={projectId}
          doorNumber={issueModal.doorNumber}
          hardwareItemName={issueModal.hardwareItemName}
          onClose={() => setIssueModal(null)}
          onCreated={() => setIssueModal(null)}
        />
      )}

      {/* Classify apply-to-all prompt */}
      {classifyPrompt && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="panel corner-brackets w-full max-w-sm p-5 animate-fade-in-up">
            <h3
              className="text-[15px] font-bold text-[var(--text-primary)] mb-3"
              style={{ fontFamily: "var(--font-display)", letterSpacing: "0.03em" }}
            >
              APPLY TO ALL?
            </h3>
            <p className="text-[13px] text-[var(--text-secondary)] mb-1">
              <span className="text-[var(--text-primary)] font-medium">{classifyPrompt.itemName}</span> appears in{" "}
              <span className="text-[var(--blue)] font-medium">{classifyPrompt.totalCount}</span> openings.
            </p>
            <p className="text-[13px] text-[var(--text-secondary)] mb-4">
              Classify all as{" "}
              <span
                className="font-medium"
                style={{
                  color: classifyPrompt.installType === 'bench' ? 'var(--purple)' : 'var(--orange)',
                }}
              >
                {classifyPrompt.installType === 'bench' ? 'Bench' : 'Field'}
              </span>
              ?
            </p>

            <div className="flex flex-col gap-2 mb-4">
              <button
                onClick={() => applyClassification(classifyPrompt.itemName, classifyPrompt.installType)}
                disabled={classifyLoading}
                className="glow-btn--primary w-full rounded-lg py-2 min-h-[44px] text-[13px] disabled:opacity-40"
              >
                {classifyLoading ? "Applying..." : `Yes, apply to all ${classifyPrompt.totalCount}`}
              </button>
              <button
                onClick={() => {
                  applySingleClassification(classifyPrompt.itemId, classifyPrompt.installType);
                  setClassifyPrompt(null);
                }}
                disabled={classifyLoading}
                className="glow-btn--ghost w-full rounded-lg py-2 min-h-[44px] text-[13px] disabled:opacity-40"
              >
                Just this one
              </button>
            </div>

            <label className="flex items-center gap-2 cursor-pointer min-h-[44px]">
              <input
                type="checkbox"
                checked={dontAskClassify}
                onChange={(e) => setDontAskClassify(e.target.checked)}
                className="w-4 h-4 rounded border-[var(--border)] bg-transparent accent-[var(--blue)]"
              />
              <span className="text-[11px] text-[var(--text-tertiary)]">Don&apos;t ask again (apply to all automatically)</span>
            </label>
          </div>
        </div>
      )}

      {/* Edit apply-to-all prompt */}
      {editApplyAllPrompt && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="panel corner-brackets w-full max-w-sm p-5 animate-fade-in-up">
            <h3
              className="text-[15px] font-bold text-[var(--text-primary)] mb-3"
              style={{ fontFamily: "var(--font-display)", letterSpacing: "0.03em" }}
            >
              APPLY EDIT TO ALL?
            </h3>
            <p className="text-[13px] text-[var(--text-secondary)] mb-1">
              <span className="text-[var(--text-primary)] font-medium">{editApplyAllPrompt.originalName}</span> appears in{" "}
              <span className="text-[var(--blue)] font-medium">{editApplyAllPrompt.totalCount}</span> openings.
            </p>
            <p className="text-[13px] text-[var(--text-secondary)] mb-1">
              Changed fields:{" "}
              <span className="text-[var(--text-primary)]">
                {Object.keys(editApplyAllPrompt.updates).join(", ")}
              </span>
            </p>
            <p className="text-[13px] text-[var(--text-secondary)] mb-4">
              Apply these changes to all matching items?
            </p>

            <div className="flex flex-col gap-2 mb-4">
              <button
                onClick={async () => {
                  await applyBulkItemUpdate(editApplyAllPrompt.originalName, editApplyAllPrompt.updates);
                  await saveSingleItem();
                }}
                disabled={editApplyAllLoading}
                className="glow-btn--primary w-full rounded-lg py-2 min-h-[44px] text-[13px] disabled:opacity-40"
              >
                {editApplyAllLoading ? "Applying..." : `Yes, update all ${editApplyAllPrompt.totalCount}`}
              </button>
              <button
                onClick={async () => {
                  await saveSingleItem();
                }}
                disabled={editApplyAllLoading}
                className="glow-btn--ghost w-full rounded-lg py-2 min-h-[44px] text-[13px] disabled:opacity-40"
              >
                Just this one
              </button>
            </div>

            <label className="flex items-center gap-2 cursor-pointer min-h-[44px]">
              <input
                type="checkbox"
                checked={dontAskEditApplyAll}
                onChange={(e) => setDontAskEditApplyAll(e.target.checked)}
                className="w-4 h-4 rounded border-[var(--border)] bg-transparent accent-[var(--blue)]"
              />
              <span className="text-[11px] text-[var(--text-tertiary)]">Don&apos;t ask again (apply to all automatically)</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
