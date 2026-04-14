"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
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
import PDFRegionSelector from "@/components/ImportWizard/PDFRegionSelector";

interface RescanResult {
  itemId: string;
  itemName: string;
  fields: Record<string, string | number>;
  applied?: boolean;
}

const RESCAN_HINTS: Record<string, string> = {
  per_frame: "Frame items (seals, weatherstripping, silencers) are often in a separate frame schedule section",
  per_leaf: "Per-leaf items like hinges and closers are usually in the main hardware group table",
  per_opening: "Per-opening items like locksets and exit devices are in the main hardware group",
  per_pair: "Pair-only items (coordinators, flush bolts) may be in a separate pairs section",
};

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
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [batchActionLoading, setBatchActionLoading] = useState(false);

  // Rescan state
  const [rescanItem, setRescanItem] = useState<HardwareItemWithProgress | null>(null);
  const [pdfBuffer, setPdfBuffer] = useState<ArrayBuffer | null>(null);
  const [rescanLoading, setRescanLoading] = useState(false);
  const [rescanResults, setRescanResults] = useState<RescanResult[] | null>(null);

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

  // --- Batch selection helpers ---
  const toggleItemSelection = (itemId: string) => {
    setSelectedItems(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const toggleSelectAll = (items: HardwareItemWithProgress[]) => {
    const allIds = items.map(i => i.id);
    const allSelected = allIds.every(id => selectedItems.has(id));
    if (allSelected) {
      setSelectedItems(prev => {
        const next = new Set(prev);
        allIds.forEach(id => next.delete(id));
        return next;
      });
    } else {
      setSelectedItems(prev => {
        const next = new Set(prev);
        allIds.forEach(id => next.add(id));
        return next;
      });
    }
  };

  const handleBatchStepToggle = async (step: WorkflowStep, leafIndex: number = 1) => {
    if (selectedItems.size === 0) return;
    setBatchActionLoading(true);
    try {
      const promises = Array.from(selectedItems).map(itemId =>
        fetch(`/api/openings/${doorId}/check`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            item_id: itemId,
            leaf_index: leafIndex,
            step,
            value: true,
          }),
        })
      );
      await Promise.all(promises);
      playSuccess();
      setSelectedItems(new Set());
      await fetchOpeningData();
    } catch (err) {
      console.error("Error in batch update:", err);
      showToast("error", "Some items failed to update. Check your connection and try again.");
    } finally {
      setBatchActionLoading(false);
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

  const handleRescanClick = useCallback(async (item: HardwareItemWithProgress) => {
    if (opening?.pdf_page == null) {
      showToast("error", "No PDF page linked to this door");
      return;
    }
    setRescanItem(item);
    setRescanResults(null);

    if (!pdfBuffer) {
      try {
        const resp = await fetch(`/api/projects/${projectId}/pdf-url`);
        const { url } = await resp.json();
        const pdfResp = await fetch(url);
        const buffer = await pdfResp.arrayBuffer();
        setPdfBuffer(buffer);
      } catch {
        showToast("error", "Failed to load PDF");
        setRescanItem(null);
      }
    }
  }, [opening, pdfBuffer, projectId, showToast]);

  const handleRescanSelect = useCallback(async (bbox: { x0: number; y0: number; x1: number; y1: number }) => {
    if (!rescanItem || !opening) return;
    setRescanLoading(true);

    try {
      const resp = await fetch('/api/parse-pdf/region-extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          page: opening.pdf_page,
          bbox,
          setId: rescanItem.id,
        }),
      });
      const { items: extractedItems } = await resp.json();

      if (!extractedItems || extractedItems.length === 0) {
        showToast("error", "No items found in selected region");
        setRescanLoading(false);
        return;
      }

      const area = (bbox.x1 - bbox.x0) * (bbox.y1 - bbox.y0);
      const isPointScan = area < 0.15;
      const confidence = getItemConfidence(rescanItem);
      const missingFields = confidence.missingFields;

      if (isPointScan) {
        // Point mode: find best match for the triggering item
        const targetName = rescanItem.name.toLowerCase();
        let bestMatch = extractedItems[0];
        let bestScore = 0;
        for (const ext of extractedItems) {
          const extName = (ext.name || '').toLowerCase();
          if (extName === targetName) { bestMatch = ext; bestScore = 3; break; }
          if (extName.includes(targetName) || targetName.includes(extName)) {
            const score = 2;
            if (score > bestScore) { bestMatch = ext; bestScore = score; }
          }
        }

        const fields: Record<string, string | number> = {};
        for (const f of missingFields) {
          if (f in bestMatch && bestMatch[f] != null && bestMatch[f] !== '') {
            fields[f] = bestMatch[f];
          }
        }
        if (Object.keys(fields).length > 0) {
          setRescanResults([{ itemId: rescanItem.id, itemName: rescanItem.name, fields }]);
        } else {
          showToast("error", "Extracted data didn\u2019t contain the missing fields");
        }
      } else {
        // Table mode: match all extracted items to existing hardware items
        const allItems = opening.hardware_items;
        const results: RescanResult[] = [];

        for (const ext of extractedItems) {
          const extName = (ext.name || '').toLowerCase();
          let matchedItem: HardwareItemWithProgress | null = null;
          let bestScore = 0;

          for (const hw of allItems) {
            const hwName = hw.name.toLowerCase();
            if (hwName === extName) { matchedItem = hw; bestScore = 3; break; }
            if (hwName.includes(extName) || extName.includes(hwName)) {
              const score = 2;
              if (score > bestScore) { matchedItem = hw; bestScore = score; }
            }
          }

          if (matchedItem && bestScore > 0) {
            const itemConf = getItemConfidence(matchedItem);
            const fields: Record<string, string | number> = {};
            for (const f of itemConf.missingFields) {
              if (f in ext && ext[f] != null && ext[f] !== '') {
                fields[f] = ext[f];
              }
            }
            if (Object.keys(fields).length > 0) {
              // Avoid duplicates
              if (!results.find(r => r.itemId === matchedItem!.id)) {
                results.push({ itemId: matchedItem.id, itemName: matchedItem.name, fields });
              }
            }
          }
        }

        if (results.length > 0) {
          setRescanResults(results);
        } else {
          showToast("error", "Could not match any extracted items to existing hardware");
        }
      }
    } catch {
      showToast("error", "Failed to extract data from region");
    } finally {
      setRescanLoading(false);
    }
  }, [rescanItem, opening, projectId, showToast]);

  const handleRescanApply = useCallback(async (result: RescanResult) => {
    if (!opening) return;
    try {
      const resp = await fetch(`/api/openings/${doorId}/items/${result.itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result.fields),
      });
      if (!resp.ok) throw new Error("Failed to update item");
      setRescanResults(prev => prev ? prev.map(r => r.itemId === result.itemId ? { ...r, applied: true } : r) : prev);
      showToast("success", `Updated ${result.itemName}`);
    } catch {
      showToast("error", `Failed to update ${result.itemName}`);
    }
  }, [opening, doorId, showToast]);

  const handleRescanApplyAll = useCallback(async () => {
    if (!rescanResults) return;
    const unapplied = rescanResults.filter(r => !r.applied);
    for (const result of unapplied) {
      await handleRescanApply(result);
    }
  }, [rescanResults, handleRescanApply]);

  const handleRescanClose = useCallback(() => {
    const anyApplied = rescanResults?.some(r => r.applied);
    setRescanItem(null);
    setRescanResults(null);
    setRescanLoading(false);
    if (anyApplied) fetchOpeningData();
  }, [rescanResults, fetchOpeningData]);

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
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-secondary">Loading...</div>
      </div>
    );
  }

  if (error && !opening) {
    return (
      <div className="min-h-screen bg-background p-4">
        <div className="p-4 bg-danger-dim border border-danger rounded-md text-danger">
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

  const getStepShortLabel = (step: WorkflowStep): string => {
    if (step === 'received') return 'R';
    if (step === 'pre_install') return 'P';
    if (step === 'installed') return 'I';
    if (step === 'qa_qc') return 'Q';
    return (step as string)[0].toUpperCase();
  };

  const getStepColor = (step: WorkflowStep): string => {
    if (step === 'received') return 'var(--blue)';
    if (step === 'pre_install') return 'var(--purple)';
    if (step === 'installed') return 'var(--field)';
    if (step === 'qa_qc') return 'var(--green)';
    return 'var(--green)';
  };

  const getStepDimColor = (step: WorkflowStep): string => {
    if (step === 'received') return 'var(--blue-dim)';
    if (step === 'pre_install') return 'var(--purple-dim)';
    if (step === 'installed') return 'var(--field-dim)';
    if (step === 'qa_qc') return 'var(--green-dim)';
    return 'var(--green-dim)';
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

  // --- Edit form for inline editing (shown below table row) ---
  const renderEditForm = (item: HardwareItemWithProgress) => (
    <tr key={`edit-${item.id}`}>
      <td colSpan={9} className="p-3 bg-surface-hover border-b border-th-border">
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-tertiary mb-1 uppercase tracking-wider">Name</label>
              <input type="text" value={editingItem!.name} onChange={(e) => setEditingItem({ ...editingItem!, name: e.target.value })} className="w-full px-3 py-2 bg-surface border border-th-border rounded text-primary placeholder-tertiary focus:border-accent focus:outline-none text-[13px]" />
            </div>
            <div>
              <label className="block text-[11px] text-tertiary mb-1 uppercase tracking-wider">Qty</label>
              <input type="number" value={editingItem!.qty} onChange={(e) => setEditingItem({ ...editingItem!, qty: parseInt(e.target.value) || 0 })} className="w-full px-3 py-2 bg-surface border border-th-border rounded text-primary placeholder-tertiary focus:border-accent focus:outline-none text-[13px]" />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] text-tertiary mb-1 uppercase tracking-wider">Manufacturer</label>
              <input type="text" value={editingItem!.manufacturer || ""} onChange={(e) => setEditingItem({ ...editingItem!, manufacturer: e.target.value || null })} placeholder="Optional" className="w-full px-3 py-2 bg-surface border border-th-border rounded text-primary placeholder-tertiary focus:border-accent focus:outline-none text-[13px]" />
            </div>
            <div>
              <label className="block text-[11px] text-tertiary mb-1 uppercase tracking-wider">Model</label>
              <input type="text" value={editingItem!.model || ""} onChange={(e) => setEditingItem({ ...editingItem!, model: e.target.value || null })} placeholder="Optional" className="w-full px-3 py-2 bg-surface border border-th-border rounded text-primary placeholder-tertiary focus:border-accent focus:outline-none text-[13px]" />
            </div>
            <div>
              <label className="block text-[11px] text-tertiary mb-1 uppercase tracking-wider">Finish</label>
              <input type="text" value={editingItem!.finish || ""} onChange={(e) => setEditingItem({ ...editingItem!, finish: e.target.value || null })} placeholder="Optional" className="w-full px-3 py-2 bg-surface border border-th-border rounded text-primary placeholder-tertiary focus:border-accent focus:outline-none text-[13px]" />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-tertiary mb-1 uppercase tracking-wider">Options</label>
              <input type="text" value={editingItem!.options || ""} onChange={(e) => setEditingItem({ ...editingItem!, options: e.target.value || null })} placeholder="Optional" className="w-full px-3 py-2 bg-surface border border-th-border rounded text-primary placeholder-tertiary focus:border-accent focus:outline-none text-[13px]" />
            </div>
            <div>
              <label className="block text-[11px] text-tertiary mb-1 uppercase tracking-wider">Install Type</label>
              <select value={editingItem!.install_type || ""} onChange={(e) => setEditingItem({ ...editingItem!, install_type: (e.target.value as 'bench' | 'field') || null })} className="w-full px-3 py-2 min-h-[44px] bg-surface border border-th-border rounded text-primary focus:border-accent focus:outline-none text-[13px]">
                <option value="">Not set</option>
                <option value="bench">Bench</option>
                <option value="field">Field</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <button onClick={saveEditItem} disabled={savingItem} className="flex-1 px-3 py-2 min-h-[44px] bg-accent hover:bg-accent/80 disabled:bg-surface text-white disabled:text-tertiary rounded transition-colors text-[13px] font-medium">
              {savingItem ? "Saving..." : "Save"}
            </button>
            <button onClick={cancelEditItem} disabled={savingItem} className="flex-1 px-3 py-2 min-h-[44px] bg-surface border border-th-border hover:bg-surface-hover disabled:opacity-50 text-secondary rounded transition-colors text-[13px] font-medium">
              Cancel
            </button>
          </div>
        </div>
      </td>
    </tr>
  );

  // --- Confidence score based on data completeness ---
  const getItemConfidence = (item: HardwareItemWithProgress): { level: 'high' | 'medium' | 'low'; score: number; missingFields: string[] } => {
    const fieldMap: Record<string, unknown> = { manufacturer: item.manufacturer, model: item.model, finish: item.finish, install_type: item.install_type, qty: item.qty };
    const missingFields: string[] = [];
    let filled = 0;
    for (const [key, val] of Object.entries(fieldMap)) {
      if (val != null && val !== '') filled++;
      else missingFields.push(key);
    }
    const score = Math.round((filled / Object.keys(fieldMap).length) * 100);
    if (score > 80) return { level: 'high', score, missingFields };
    if (score >= 50) return { level: 'medium', score, missingFields };
    return { level: 'low', score, missingFields };
  };

  // --- Table renderer for hardware items ---
  const renderItemsTable = (items: HardwareItemWithProgress[], leafIndex: number) => {
    if (items.length === 0) {
      return <p className="text-tertiary text-center py-6 text-[13px]">No items in this section</p>;
    }

    const allItemIds = items.map(i => i.id);
    const allSelected = allItemIds.length > 0 && allItemIds.every(id => selectedItems.has(id));
    const someSelected = allItemIds.some(id => selectedItems.has(id));
    const selectedInThisSection = items.filter(i => selectedItems.has(i.id));

    return (
      <>
        {/* Floating batch action bar */}
        {selectedInThisSection.length > 0 && (
          <div
            className="mb-3 flex items-center gap-2 flex-wrap px-3 py-2.5 rounded-md border text-[12px] animate-fade-in-up"
            style={{
              background: 'var(--blue-dim)',
              borderColor: 'var(--blue)',
            }}
          >
            <span className="font-semibold tabular-nums" style={{ color: 'var(--blue)' }}>
              {selectedInThisSection.length} selected
            </span>
            <span className="text-tertiary">—</span>
            {(['received', 'pre_install', 'installed', 'qa_qc'] as WorkflowStep[]).map(step => (
              <button
                key={step}
                onClick={() => handleBatchStepToggle(step, leafIndex)}
                disabled={batchActionLoading}
                className="px-2.5 py-1 rounded font-medium transition-colors disabled:opacity-40"
                style={{
                  background: 'var(--surface)',
                  color: step === 'received' ? 'var(--blue)' : step === 'pre_install' ? 'var(--purple)' : step === 'installed' ? 'var(--field)' : 'var(--green)',
                  border: `1px solid var(--border)`,
                }}
              >
                {batchActionLoading ? '...' : step === 'received' ? 'Mark Received' : step === 'pre_install' ? 'Mark Pre-Install' : step === 'installed' ? 'Mark Installed' : 'Mark QA/QC'}
              </button>
            ))}
            <button
              onClick={() => setSelectedItems(new Set())}
              className="ml-auto text-tertiary hover:text-secondary transition-colors px-2 py-1"
            >
              Clear
            </button>
          </div>
        )}

        <div className="overflow-x-auto border border-th-border rounded-md">
          <table className="w-full text-left text-[13px]">
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-th-border bg-surface text-[11px] text-tertiary uppercase tracking-wider">
                <th className="px-2 py-2 w-10 text-center">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                    onChange={() => toggleSelectAll(items)}
                    className="w-4 h-4 rounded border-th-border bg-transparent accent-accent cursor-pointer"
                    title={allSelected ? 'Deselect all' : 'Select all'}
                  />
                </th>
                <th className="px-3 py-2 font-medium">Item Name</th>
                <th className="px-3 py-2 font-medium w-14 text-center">Qty</th>
                <th className="px-3 py-2 font-medium hidden md:table-cell">Manufacturer</th>
                <th className="px-3 py-2 font-medium hidden md:table-cell">Model</th>
                <th className="px-3 py-2 font-medium hidden md:table-cell">Finish</th>
                <th className="px-3 py-2 font-medium hidden md:table-cell text-center w-16" title="Data completeness — how many fields are filled in">Data</th>
                <th className="px-3 py-2 font-medium text-center">Status</th>
                <th className="px-3 py-2 font-medium w-20 text-right">Actions</th>
              </tr>
            </thead>
          <tbody>
            {items.map((item, idx) => {
              const scope = classifyItemScope(item.name);
              const displayQty = getLeafDisplayQty(item, leafCount, scope);
              const steps = getWorkflowSteps(item);
              const completedSteps = steps.filter(s => getStepValue(item, s, leafIndex)).length;
              const isEditing = editingItemId === item.id && editingItem;
              const confidence = getItemConfidence(item);

              return (
                <React.Fragment key={`${item.id}-leaf${leafIndex}`}>
                  <tr
                    className={`border-b border-th-border transition-colors hover:bg-surface-hover ${
                      idx % 2 === 1 ? 'bg-surface/50' : ''
                    } ${
                      item.install_type === 'bench'
                        ? 'border-l-2 border-l-purple'
                        : item.install_type === 'field'
                        ? 'border-l-2 border-l-warning'
                        : ''
                    } ${
                      selectedItems.has(item.id) ? 'bg-accent-dim/30' : ''
                    }`}
                  >
                    <td className="px-2 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={selectedItems.has(item.id)}
                        onChange={() => toggleItemSelection(item.id)}
                        className="w-4 h-4 rounded border-th-border bg-transparent accent-accent cursor-pointer"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-semibold text-primary">{item.name}</span>
                        {item.install_type && (
                          <span
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide"
                            style={{
                              background: item.install_type === 'bench' ? 'var(--bench-dim)' : 'var(--field-dim)',
                              color: item.install_type === 'bench' ? 'var(--bench)' : 'var(--field)',
                            }}
                          >
                            {item.install_type === 'bench' ? 'BCH' : 'FLD'}
                          </span>
                        )}
                      </div>
                      {/* Mobile: show spec line since Manufacturer/Model/Finish columns are hidden */}
                      {formatSpec(item) && (
                        <span className="block text-[11px] text-tertiary mt-0.5 md:hidden">{formatSpec(item)}</span>
                      )}
                      {item.options && (
                        <span className="block text-[11px] text-tertiary mt-0.5">{item.options}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center font-semibold text-primary tabular-nums">
                      {displayQty > 0 ? displayQty : '—'}
                    </td>
                    <td className="px-3 py-2 hidden md:table-cell text-secondary">
                      {item.manufacturer || <span className="text-tertiary">—</span>}
                    </td>
                    <td className="px-3 py-2 hidden md:table-cell text-secondary">
                      {item.model || <span className="text-tertiary">—</span>}
                    </td>
                    <td className="px-3 py-2 hidden md:table-cell text-secondary">
                      {item.finish || <span className="text-tertiary">—</span>}
                    </td>
                    <td className="px-3 py-2 hidden md:table-cell text-center">
                      {confidence.score <= 80 ? (
                        <button
                          onClick={() => handleRescanClick(item)}
                          className="inline-flex items-center justify-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold tabular-nums transition-all hover:scale-110 hover:shadow-sm cursor-pointer"
                          style={{
                            background: confidence.level === 'medium' ? 'var(--yellow-dim)' : 'var(--red-dim)',
                            color: confidence.level === 'medium' ? 'var(--yellow)' : 'var(--red)',
                            border: '1px solid transparent',
                          }}
                          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = confidence.level === 'medium' ? 'var(--yellow)' : 'var(--red)'; }}
                          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'transparent'; }}
                          title={`Click to re-scan from PDF — missing: ${confidence.missingFields.join(', ')}${scope ? `\n${RESCAN_HINTS[scope] || ''}` : ''}`}
                        >
                          {confidence.score}%
                        </button>
                      ) : (
                        <span
                          className="inline-flex items-center justify-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold tabular-nums"
                          style={{
                            background: 'var(--green-dim)',
                            color: 'var(--green)',
                          }}
                          title={`${confidence.score}% of fields filled in`}
                        >
                          {confidence.score}%
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-1.5">
                        {steps.map((step) => {
                          const isActive = getStepValue(item, step, leafIndex);
                          const stepColor = getStepColor(step);
                          const stepDimColor = getStepDimColor(step);
                          return (
                            <div key={step} className="flex flex-col items-center gap-0.5">
                              <button
                                onClick={() => {
                                  playToggle();
                                  handleStepToggle(item.id, step, isActive, leafIndex);
                                }}
                                className="flex items-center justify-center w-8 h-8 rounded-full transition-colors"
                                style={{
                                  background: isActive ? stepColor : stepDimColor,
                                  border: isActive ? `2px solid ${stepColor}` : `2px solid var(--border-hover)`,
                                }}
                                title={getStepLabel(item, step)}
                              >
                                {isActive ? (
                                  <svg className="w-3.5 h-3.5 text-white" fill="currentColor" viewBox="0 0 20 20">
                                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                  </svg>
                                ) : (
                                  <span className="text-[10px] font-bold" style={{ color: 'var(--text-tertiary)' }}>
                                    {getStepShortLabel(step)}
                                  </span>
                                )}
                              </button>
                              <span className="text-[8px] font-medium uppercase tracking-wider" style={{ color: isActive ? stepColor : 'var(--text-tertiary)' }}>
                                {getStepShortLabel(step)}
                              </span>
                            </div>
                          );
                        })}
                        <span className="text-[10px] text-tertiary ml-0.5 tabular-nums self-center">{completedSteps}/{steps.length}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => startEditItem(item)}
                          className="text-tertiary hover:text-secondary w-8 h-8 flex items-center justify-center transition-colors"
                          title="Edit item"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        <button
                          onClick={() => setIssueModal({
                            doorNumber: opening.door_number,
                            hardwareItemName: item.name,
                          })}
                          className="text-tertiary hover:text-danger w-8 h-8 flex items-center justify-center transition-colors"
                          title="Report issue"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                  {isEditing && leafIndex === 1 && renderEditForm(item)}
                  {isEditing && leafIndex !== 1 && (
                    <tr key={`edit-msg-${item.id}`}>
                      <td colSpan={9} className="px-3 py-3 text-tertiary text-[13px] italic text-center bg-surface-hover border-b border-th-border">
                        Editing on Leaf 1...
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
          </table>
        </div>
      </>
    );
  };

  return (
    <div className="min-h-screen bg-background pb-28">
      <OfflineIndicator />

      {/* Sticky Header */}
      <header className="sticky top-0 z-50 bg-background/85 backdrop-blur-xl border-b border-th-border">
        <div className="max-w-[430px] md:max-w-[900px] mx-auto px-4 py-4 flex items-center justify-between">
          <button
            onClick={() => router.push(`/project/${projectId}`)}
            className="text-accent hover:text-accent/80 flex items-center gap-1 text-[15px] min-h-[44px] min-w-[44px] justify-center"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-[17px] font-semibold text-primary">
            Door {opening.door_number}
          </h1>
          {!editingOpening && (
            <button
              onClick={startEditOpening}
              className="text-tertiary hover:text-primary min-h-[44px] min-w-[44px] flex items-center justify-center"
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
          <div className="mb-6 bg-surface border border-th-border rounded-md p-4 space-y-4">
            <div>
              <label className="block text-[13px] text-secondary mb-2">Door Number</label>
              <input
                type="text"
                value={editingOpeningData.door_number}
                onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, door_number: e.target.value } : null)}
                className="w-full px-3 py-2.5 bg-surface border border-th-border rounded text-primary placeholder-tertiary focus:border-accent focus:outline-none text-[15px]"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] text-secondary mb-2">HW Set</label>
                <input
                  type="text"
                  value={editingOpeningData.hw_set || ""}
                  onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, hw_set: e.target.value || null } : null)}
                  placeholder="Optional"
                  className="w-full px-3 py-2.5 bg-surface border border-th-border rounded text-primary placeholder-tertiary focus:border-accent focus:outline-none text-[15px]"
                />
              </div>
              <div>
                <label className="block text-[13px] text-secondary mb-2">Location</label>
                <input
                  type="text"
                  value={editingOpeningData.location || ""}
                  onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, location: e.target.value || null } : null)}
                  placeholder="Optional"
                  className="w-full px-3 py-2.5 bg-surface border border-th-border rounded text-primary placeholder-tertiary focus:border-accent focus:outline-none text-[15px]"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] text-secondary mb-2">Door Type</label>
                <input
                  type="text"
                  value={editingOpeningData.door_type || ""}
                  onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, door_type: e.target.value || null } : null)}
                  placeholder="Optional"
                  className="w-full px-3 py-2.5 bg-surface border border-th-border rounded text-primary placeholder-tertiary focus:border-accent focus:outline-none text-[15px]"
                />
              </div>
              <div>
                <label className="block text-[13px] text-secondary mb-2">Frame Type</label>
                <input
                  type="text"
                  value={editingOpeningData.frame_type || ""}
                  onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, frame_type: e.target.value || null } : null)}
                  placeholder="Optional"
                  className="w-full px-3 py-2.5 bg-surface border border-th-border rounded text-primary placeholder-tertiary focus:border-accent focus:outline-none text-[15px]"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] text-secondary mb-2">Fire Rating</label>
                <input
                  type="text"
                  value={editingOpeningData.fire_rating || ""}
                  onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, fire_rating: e.target.value || null } : null)}
                  placeholder="Optional"
                  className="w-full px-3 py-2.5 bg-surface border border-th-border rounded text-primary placeholder-tertiary focus:border-accent focus:outline-none text-[15px]"
                />
              </div>
              <div>
                <label className="block text-[13px] text-secondary mb-2">Hand</label>
                <input
                  type="text"
                  value={editingOpeningData.hand || ""}
                  onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, hand: e.target.value || null } : null)}
                  placeholder="Optional"
                  className="w-full px-3 py-2.5 bg-surface border border-th-border rounded text-primary placeholder-tertiary focus:border-accent focus:outline-none text-[15px]"
                />
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={saveEditOpening}
                disabled={savingOpening}
                className="flex-1 px-4 py-2.5 min-h-[44px] bg-accent hover:bg-accent/80 disabled:bg-surface text-white disabled:text-tertiary rounded transition-colors text-[15px] font-medium"
              >
                {savingOpening ? "Saving..." : "Save"}
              </button>
              <button
                onClick={cancelEditOpening}
                disabled={savingOpening}
                className="flex-1 px-4 py-2.5 min-h-[44px] bg-surface border border-th-border hover:bg-surface-hover disabled:opacity-50 text-secondary rounded transition-colors text-[15px] font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Hero Card */}
        {!editingOpening && (
          <div className="mb-5 bg-surface border border-th-border rounded-md px-4 py-3">
            <h1 className="text-[28px] md:text-[34px] font-bold tracking-tight text-primary mb-1">
              {opening.door_number}
            </h1>

            {opening.hw_set && (
              <div className="mb-2 flex items-center gap-2">
                <span className="inline-flex items-center px-2 py-0.5 rounded bg-success-dim border border-success text-[12px] font-medium text-success">
                  {opening.hw_set}
                  {opening.hw_heading && ` — ${opening.hw_heading}`}
                </span>
              </div>
            )}

            {opening.location && (
              <p className="text-[14px] text-secondary mb-2">
                {opening.location}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              {opening.door_type && (
                <span className="text-[11px] font-medium uppercase text-tertiary bg-surface border border-th-border px-2 py-1 rounded-full">
                  {opening.door_type}
                </span>
              )}
              {opening.fire_rating && (
                <span className="text-[11px] font-medium uppercase text-danger bg-danger-dim border border-danger px-2 py-1 rounded-full">
                  {opening.fire_rating}
                </span>
              )}
              {opening.hand && (
                <span className="text-[11px] font-medium uppercase text-tertiary bg-surface border border-th-border px-2 py-1 rounded-full">
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
              <span className="text-[11px] uppercase font-medium text-tertiary">Progress</span>
              <span className="text-[13px] text-secondary">
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

        {/* Tab Navigation — desktop only (mobile uses bottom nav) */}
        {!editingOpening && (
          <div className="hidden md:flex gap-0.5 mb-6 bg-surface rounded-md p-1">
            {(['hardware', 'files', 'notes', 'qr'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 px-3 py-3 min-h-[44px] rounded-md text-[13px] font-medium uppercase transition-colors ${
                  activeTab === tab
                    ? 'bg-surface-hover text-primary border border-th-border-hover'
                    : 'text-tertiary hover:text-secondary'
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
              <p className="text-secondary text-center py-8">No hardware items yet</p>
            ) : isPair ? (
              <>
                {/* Leaf sub-tabs for pair doors */}
                <div className="flex gap-0.5 mb-5 bg-surface rounded-md p-1">
                  {([
                    { key: 'shared' as const, label: 'Shared', count: shared.length, color: 'var(--text-tertiary)' },
                    { key: 'leaf1' as const, label: 'Leaf 1', count: leaf1.length, color: 'var(--blue)' },
                    { key: 'leaf2' as const, label: 'Leaf 2', count: leaf2.length, color: 'var(--purple)' },
                  ]).map((tab) => (
                    <button
                      key={tab.key}
                      onClick={() => setActiveLeafTab(tab.key)}
                      className={`flex-1 px-2 py-3 min-h-[44px] rounded-md text-[11px] font-semibold uppercase transition-colors flex flex-col items-center gap-0.5 ${
                        activeLeafTab === tab.key
                          ? 'bg-surface-hover border border-th-border-hover'
                          : 'text-tertiary hover:text-secondary'
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
                <div>
                  {activeLeafTab === 'shared' && renderItemsTable(shared, 1)}
                  {activeLeafTab === 'leaf1' && renderItemsTable(leaf1, 1)}
                  {activeLeafTab === 'leaf2' && renderItemsTable(leaf2, 2)}
                </div>
              </>
            ) : (
              /* Single door — flat list, no sub-tabs */
              <div>
                {renderItemsTable(opening.hardware_items, 1)}
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
                      ? 'bg-accent-dim border border-accent text-accent'
                      : 'bg-surface border border-th-border text-secondary hover:bg-surface-hover'
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
                        className="w-full text-left bg-surface border border-th-border rounded-md overflow-hidden hover:bg-surface-hover hover:border-th-border-hover transition-colors group"
                      >
                        {/* Preview area */}
                        <div className="relative w-full h-40 bg-surface overflow-hidden">
                          {isImage ? (
                            <img
                              src={attachment.file_url}
                              alt={attachment.file_name || ""}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            />
                          ) : isPdf ? (
                            <div className="w-full h-full flex flex-col items-center justify-center gap-2">
                              <svg className="w-10 h-10 text-danger" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM6 20V4h7v5h5v11H6z" />
                                <path d="M8 14h2v2H8v-2zm3 0h2v2h-2v-2zm3 0h2v2h-2v-2z" />
                              </svg>
                              <span className="text-[11px] font-medium text-danger uppercase tracking-wider">PDF</span>
                            </div>
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <svg className="w-10 h-10 text-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                            <p className="text-[13px] font-medium text-primary truncate">
                              {attachment.file_name}
                            </p>
                            <p className="text-[11px] text-tertiary mt-0.5 capitalize">
                              {(attachment.category || 'general').replace('_', ' ')}
                              {attachment.uploaded_at && ` · ${new Date(attachment.uploaded_at).toLocaleDateString()}`}
                            </p>
                          </div>
                          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-surface border border-th-border flex items-center justify-center">
                            <svg className="w-4 h-4 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                <svg className="w-12 h-12 text-tertiary mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
                <p className="text-secondary text-[15px]">No files yet</p>
                <p className="text-tertiary text-[12px] mt-1">Upload drawings, plans, or photos</p>
              </div>
            )}

            {/* Upload button */}
            <label className="block p-4 min-h-[44px] bg-surface border border-dashed border-th-border rounded-md text-center cursor-pointer hover:bg-surface-hover active:bg-surface-hover transition-colors">
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
                <svg className="w-5 h-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                <p className="text-[15px] font-medium text-primary">
                  {attachmentLoading ? "Uploading..." : "Upload File"}
                </p>
              </div>
              <p className="text-[12px] text-tertiary mt-1">
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
              className="w-full px-4 py-3 bg-surface border border-th-border rounded-md text-primary placeholder-tertiary focus:border-accent focus:outline-none min-h-32 resize-none text-[15px]"
            />
            <button
              onClick={handleSaveNotes}
              disabled={savingNotes}
              className="mt-4 px-4 py-2.5 min-h-[44px] bg-accent hover:bg-accent/80 disabled:bg-surface text-white disabled:text-tertiary rounded transition-colors text-[15px] font-medium"
            >
              {savingNotes ? "Saving..." : notesSaved ? "Saved!" : "Save Notes"}
            </button>
          </div>
        )}

        {/* QR Tab */}
        {activeTab === 'qr' && !editingOpening && (
          <div className="flex flex-col items-center justify-center py-8 mb-8">
            <div className="bg-surface border border-th-border rounded-md p-4 mb-4">
              <QRCodeSVG
                value={qrUrl}
                size={200}
                level="H"
                includeMargin={true}
              />
            </div>
            <p className="text-[15px] text-secondary text-center mb-4">
              Scan to open this door on mobile
            </p>
            <button className="px-4 py-2.5 min-h-[44px] bg-accent hover:bg-accent/80 text-white rounded-lg transition-colors text-[15px] font-medium">
              Share
            </button>
          </div>
        )}
      </main>

      {/* Bottom Navigation Bar — mobile only (desktop uses inline tabs) */}
      <nav className="md:hidden fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] bg-background/90 backdrop-blur-xl border-t border-th-border pb-[env(safe-area-inset-bottom)] h-16 flex items-center justify-around z-50">
        {(['hardware', 'files', 'notes', 'qr'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex flex-col items-center gap-1 px-3 py-2 min-h-[44px] min-w-[44px] transition-colors ${
              activeTab === tab
                ? 'text-accent'
                : 'text-tertiary hover:text-secondary'
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
              className="text-[15px] font-bold text-primary mb-3"
              style={{ fontFamily: "var(--font-display)", letterSpacing: "0.03em" }}
            >
              APPLY TO ALL?
            </h3>
            <p className="text-[13px] text-secondary mb-1">
              <span className="text-primary font-medium">{classifyPrompt.itemName}</span> appears in{" "}
              <span className="text-accent font-medium">{classifyPrompt.totalCount}</span> openings.
            </p>
            <p className="text-[13px] text-secondary mb-4">
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
                className="w-4 h-4 rounded border-th-border bg-transparent accent-accent"
              />
              <span className="text-[11px] text-tertiary">Don&apos;t ask again (apply to all automatically)</span>
            </label>
          </div>
        </div>
      )}

      {/* Rescan Modal */}
      {rescanItem && pdfBuffer && opening && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="panel corner-brackets w-full max-w-2xl p-5 animate-fade-in-up max-h-[90vh] overflow-y-auto" style={{ background: 'var(--surface)' }}>
            {!rescanResults ? (
              <>
                {/* Header */}
                <div className="mb-3">
                  <h3
                    className="text-[15px] font-bold text-primary mb-1"
                    style={{ fontFamily: "var(--font-display)", letterSpacing: "0.03em" }}
                  >
                    RE-SCAN: {rescanItem.name}
                  </h3>
                  <p className="text-[12px] text-secondary">
                    Missing: <span style={{ color: 'var(--yellow)' }}>{getItemConfidence(rescanItem).missingFields.join(', ')}</span>
                  </p>
                  {(() => {
                    const itemScope = classifyItemScope(rescanItem.name);
                    return itemScope && RESCAN_HINTS[itemScope] ? (
                      <p className="text-[11px] mt-1" style={{ color: 'var(--blue)' }}>
                        {RESCAN_HINTS[itemScope]}
                      </p>
                    ) : null;
                  })()}
                </div>

                {/* PDF Region Selector */}
                <PDFRegionSelector
                  pdfBuffer={pdfBuffer}
                  pageIndex={opening.pdf_page!}
                  onSelect={handleRescanSelect}
                  onCancel={handleRescanClose}
                  loading={rescanLoading}
                />
              </>
            ) : (
              <>
                {/* Review Panel */}
                <div className="mb-4">
                  <h3
                    className="text-[15px] font-bold text-primary mb-1"
                    style={{ fontFamily: "var(--font-display)", letterSpacing: "0.03em" }}
                  >
                    REVIEW RESULTS
                  </h3>
                  <p className="text-[12px] text-secondary mb-3">
                    {rescanResults.length} match{rescanResults.length !== 1 ? 'es' : ''} found — review before applying
                  </p>
                </div>

                <div className="space-y-2 mb-4">
                  {rescanResults.map((result) => (
                    <div
                      key={result.itemId}
                      className="flex items-start justify-between gap-3 p-3 rounded-md border animate-fade-in-up"
                      style={{
                        background: result.applied ? 'var(--green-dim)' : 'var(--tint)',
                        borderColor: result.applied ? 'var(--green)' : 'var(--border)',
                      }}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold text-primary">{result.itemName}</p>
                        <div className="mt-1 space-y-0.5">
                          {Object.entries(result.fields).map(([field, value]) => (
                            <p key={field} className="text-[11px]" style={{ color: 'var(--secondary)' }}>
                              <span className="text-tertiary">{field}:</span>{' '}
                              <span className="font-medium" style={{ color: 'var(--blue)' }}>{String(value)}</span>
                            </p>
                          ))}
                        </div>
                      </div>
                      {result.applied ? (
                        <span className="text-[11px] font-semibold flex-shrink-0 px-2 py-1 rounded" style={{ color: 'var(--green)' }}>
                          Applied
                        </span>
                      ) : (
                        <button
                          onClick={() => handleRescanApply(result)}
                          className="flex-shrink-0 px-3 py-1.5 rounded text-[11px] font-semibold transition-colors"
                          style={{
                            background: 'var(--blue-dim)',
                            color: 'var(--blue)',
                            border: '1px solid var(--blue)',
                          }}
                        >
                          Apply
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  {rescanResults.some(r => !r.applied) && (
                    <button
                      onClick={handleRescanApplyAll}
                      className="px-4 py-2 rounded-lg text-[13px] font-medium transition-colors"
                      style={{
                        background: 'var(--blue)',
                        color: 'white',
                      }}
                    >
                      Apply All
                    </button>
                  )}
                  <button
                    onClick={() => { setRescanResults(null); }}
                    className="px-3 py-2 rounded-lg text-[13px] font-medium transition-colors"
                    style={{
                      background: 'var(--tint)',
                      color: 'var(--secondary)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    Re-scan
                  </button>
                  <button
                    onClick={handleRescanClose}
                    className="px-3 py-2 rounded-lg text-[13px] text-tertiary hover:text-secondary transition-colors ml-auto"
                    style={{
                      border: '1px solid var(--border)',
                    }}
                  >
                    {rescanResults.every(r => r.applied) ? 'Done' : 'Cancel'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Edit apply-to-all prompt */}
      {editApplyAllPrompt && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="panel corner-brackets w-full max-w-sm p-5 animate-fade-in-up">
            <h3
              className="text-[15px] font-bold text-primary mb-3"
              style={{ fontFamily: "var(--font-display)", letterSpacing: "0.03em" }}
            >
              APPLY EDIT TO ALL?
            </h3>
            <p className="text-[13px] text-secondary mb-1">
              <span className="text-primary font-medium">{editApplyAllPrompt.originalName}</span> appears in{" "}
              <span className="text-accent font-medium">{editApplyAllPrompt.totalCount}</span> openings.
            </p>
            <p className="text-[13px] text-secondary mb-1">
              Changed fields:{" "}
              <span className="text-primary">
                {Object.keys(editApplyAllPrompt.updates).join(", ")}
              </span>
            </p>
            <p className="text-[13px] text-secondary mb-4">
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
                className="w-4 h-4 rounded border-th-border bg-transparent accent-accent"
              />
              <span className="text-[11px] text-tertiary">Don&apos;t ask again (apply to all automatically)</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
