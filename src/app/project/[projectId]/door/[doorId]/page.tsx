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

interface RescanFieldDiff {
  field: string;
  currentValue: string | number | null;
  extractedValue: string | number;
  /** "new" = was empty, now has data. "changed" = had value, new differs. */
  kind: "new" | "changed";
  enabled: boolean;
}

interface RescanResult {
  itemId: string;
  itemName: string;
  fields: Record<string, string | number>;
  /** Field-by-field diff for the preview UI */
  diffs: RescanFieldDiff[];
  applied?: boolean;
}

const KNOWN_MANUFACTURERS = ['IV', 'SC', 'ZE', 'LC', 'BE', 'AB', 'NA', 'AC', 'BO', 'RHR'];

/** Parse raw extracted text into likely field values using heuristics. */
function parseRawTextHeuristic(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const tokens = text.split(/\s+/).filter(Boolean);
  const remaining: string[] = [];

  for (const token of tokens) {
    const upper = token.toUpperCase();
    // 3-digit finish codes or US-prefixed codes (e.g., US26D, US32D)
    if (!result.finish && (/^\d{3}$/.test(token) || /^US\d{1,2}[A-Z]?$/i.test(token))) {
      result.finish = token;
    // Known 2-3 letter manufacturer abbreviations
    } else if (!result.manufacturer && /^[A-Z]{2,3}$/i.test(token) && KNOWN_MANUFACTURERS.includes(upper)) {
      result.manufacturer = upper;
    // Pure number that could be qty (1-4 digits, small value)
    } else if (!result.qty && /^\d{1,2}$/.test(token) && parseInt(token, 10) <= 99 && parseInt(token, 10) > 0) {
      result.qty = token;
    } else {
      remaining.push(token);
    }
  }

  // Remaining tokens that look like a model number
  if (!result.model && remaining.length > 0) {
    result.model = remaining.join(' ');
  }

  return result;
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
  const [activePhase, setActivePhase] = useState<'all' | 'receive' | 'install' | 'qa'>('all');
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);

  // Rescan state
  const [rescanItem, setRescanItem] = useState<HardwareItemWithProgress | null>(null);
  const [pdfBuffer, setPdfBuffer] = useState<ArrayBuffer | null>(null);
  const [rescanLoading, setRescanLoading] = useState(false);
  const [rescanResults, setRescanResults] = useState<RescanResult[] | null>(null);
  const [rescanPage, setRescanPage] = useState<number>(0);
  const [rescanRawText, setRescanRawText] = useState<string | null>(null);
  const [rescanRawFields, setRescanRawFields] = useState<Record<string, string>>({});
  const [rescanRawApplied, setRescanRawApplied] = useState(false);

  const supabase = createClient();
  const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { showToast } = useToast();

  // Lock body scroll while rescan modal is open (iPad scroll containment)
  useEffect(() => {
    if (rescanItem) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [rescanItem]);

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
  type WorkflowPhase = 'all' | 'receive' | 'install' | 'qa';

  // --- Phase filtering helpers ---
  const getPhaseStep = (phase: WorkflowPhase, item: HardwareItemWithProgress): WorkflowStep | null => {
    if (phase === 'receive') return 'received';
    if (phase === 'install') {
      if (item.install_type === 'bench') return 'pre_install';
      if (item.install_type === 'field') return 'installed';
      return null; // needs classification
    }
    if (phase === 'qa') return 'qa_qc';
    return null;
  };

  const isItemRelevantToPhase = (item: HardwareItemWithProgress, phase: WorkflowPhase, leafIndex: number): boolean => {
    if (phase === 'all') return true;
    const p = getLeafProgress(item, leafIndex);
    if (phase === 'receive') return true; // all items need receiving
    if (phase === 'install') return true; // all items need install (even if unclassified — we'll prompt)
    if (phase === 'qa') return true; // all items need QA
    return true;
  };

  const getPhaseStepDone = (item: HardwareItemWithProgress, phase: WorkflowPhase, leafIndex: number): boolean => {
    const p = getLeafProgress(item, leafIndex);
    if (!p) return false;
    if (phase === 'receive') return !!p.received;
    if (phase === 'install') {
      if (item.install_type === 'bench') return !!p.pre_install;
      if (item.install_type === 'field') return !!p.installed;
      return false;
    }
    if (phase === 'qa') return !!p.qa_qc;
    return false;
  };

  const getPhaseCounts = (items: HardwareItemWithProgress[], leafIndex: number, phase: WorkflowPhase) => {
    let done = 0;
    let remaining = 0;
    let needsClassification = 0;
    for (const item of items) {
      if (phase === 'install' && !item.install_type) {
        needsClassification++;
        remaining++;
      } else if (getPhaseStepDone(item, phase, leafIndex)) {
        done++;
      } else {
        remaining++;
      }
    }
    return { done, remaining, needsClassification, total: items.length };
  };

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
    setRescanPage(opening.pdf_page);

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

    /** Token-based name matching: split into words, count shared tokens, divide by max token count. */
    function tokenMatchScore(a: string, b: string): number {
      const tokensA = a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
      const tokensB = b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
      if (tokensA.length === 0 || tokensB.length === 0) return 0;
      const setB = new Set(tokensB);
      const shared = tokensA.filter(t => setB.has(t)).length;
      return shared / Math.max(tokensA.length, tokensB.length);
    }

    try {
      const resp = await fetch('/api/parse-pdf/region-extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          page: rescanPage,
          bbox,
          setId: rescanItem.id,
        }),
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        console.error("[region-extract] API error:", resp.status, errBody.slice(0, 300));
        showToast("error", "Region scan failed — try selecting a larger area");
        setRescanLoading(false);
        return;
      }

      const { items: extractedItems, raw_text } = await resp.json();

      if (!extractedItems || extractedItems.length === 0) {
        // Raw text fallback: if table extraction failed but we got raw text, let the user assign fields
        const trimmed = (raw_text || '').trim();
        if (trimmed) {
          setRescanRawText(trimmed);
          setRescanRawFields(parseRawTextHeuristic(trimmed));
          setRescanRawApplied(false);
          setRescanLoading(false);
          return;
        }
        showToast("error", "No items found in selected region — try a different area");
        setRescanLoading(false);
        return;
      }

      // Item-first: we know the target item. Pick the best match from extracted items.
      // If only 1 item returned, use it directly (user boxed exactly one row).
      let match: (typeof extractedItems)[0] | null = null;
      if (extractedItems.length === 1) {
        match = extractedItems[0];
      } else {
        let bestScore = 0;
        for (const ext of extractedItems) {
          const extName = ext?.name || '';
          const score = tokenMatchScore(rescanItem.name, extName);
          if (score > bestScore || (score === bestScore && match && extName.length < (match?.name || '').length)) {
            match = ext;
            bestScore = score;
          }
        }
        // Require minimum match score
        if (bestScore === 0) match = null;
      }

      if (!match) {
        showToast("error", "No matching item found in selected region");
        setRescanLoading(false);
        return;
      }

      // Build field-by-field diff for ALL non-empty extracted fields (not just missing)
      const diffableFields = ['manufacturer', 'model', 'finish', 'qty', 'options', 'install_type'] as const;
      const fields: Record<string, string | number> = {};
      const diffs: RescanFieldDiff[] = [];

      for (const f of diffableFields) {
        const extractedVal = match?.[f];
        if (extractedVal == null || extractedVal === '') continue;

        const currentVal = (rescanItem as unknown as Record<string, unknown>)[f] as string | number | null | undefined;
        const currentEmpty = currentVal == null || currentVal === '';
        const isDifferent = currentEmpty || String(currentVal) !== String(extractedVal);

        if (isDifferent) {
          fields[f] = extractedVal;
          diffs.push({
            field: f,
            currentValue: currentEmpty ? null : currentVal!,
            extractedValue: extractedVal,
            kind: currentEmpty ? "new" : "changed",
            enabled: true,
          });
        }
      }

      if (diffs.length > 0) {
        setRescanResults([{
          itemId: rescanItem.id,
          itemName: rescanItem.name,
          fields,
          diffs,
        }]);
      } else {
        showToast("error", "Extracted data matches current values — nothing to update");
      }
    } catch {
      showToast("error", "Failed to extract data from region");
    } finally {
      setRescanLoading(false);
    }
  }, [rescanItem, opening, projectId, rescanPage, showToast]);

  /** Toggle a single field on/off in the rescan preview. */
  const handleRescanToggleField = useCallback((resultItemId: string, fieldName: string) => {
    setRescanResults(prev => prev?.map(r => {
      if (r.itemId !== resultItemId) return r;
      return {
        ...r,
        diffs: r.diffs.map(d => d.field === fieldName ? { ...d, enabled: !d.enabled } : d),
      };
    }) ?? null);
  }, []);

  const handleRescanApplySelected = useCallback(async () => {
    if (!opening || !rescanResults) return;
    for (const result of rescanResults) {
      if (result.applied) continue;
      const enabledFields: Record<string, string | number> = {};
      for (const d of result.diffs) {
        if (d.enabled) enabledFields[d.field] = d.extractedValue;
      }
      if (Object.keys(enabledFields).length === 0) continue;
      try {
        const resp = await fetch(`/api/openings/${doorId}/items/${result.itemId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(enabledFields),
        });
        if (!resp.ok) throw new Error("Failed to update item");
        setRescanResults(prev => prev?.map(r => r.itemId === result.itemId ? { ...r, applied: true } : r) ?? null);
        const count = Object.keys(enabledFields).length;
        showToast("success", `Updated ${count} field${count !== 1 ? 's' : ''} on ${result.itemName}`);
      } catch {
        showToast("error", `Failed to update ${result.itemName}`);
      }
    }
  }, [opening, rescanResults, doorId, showToast]);

  const handleRescanApplyRawText = useCallback(async () => {
    if (!rescanItem || !rescanRawFields) return;
    const payload: Record<string, string> = {};
    for (const [field, value] of Object.entries(rescanRawFields)) {
      const trimmed = value.trim();
      if (trimmed) payload[field] = trimmed;
    }
    if (Object.keys(payload).length === 0) return;
    try {
      const resp = await fetch(`/api/openings/${doorId}/items/${rescanItem.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error("Failed to update item");
      setRescanRawApplied(true);
      const count = Object.keys(payload).length;
      showToast("success", `Updated ${count} field${count !== 1 ? 's' : ''} on ${rescanItem.name}`);
    } catch {
      showToast("error", `Failed to update ${rescanItem.name}`);
    }
  }, [rescanItem, rescanRawFields, doorId, showToast]);

  const handleRescanClose = useCallback(() => {
    const anyApplied = rescanResults?.some(r => r.applied) || rescanRawApplied;
    setRescanItem(null);
    setRescanResults(null);
    setRescanLoading(false);
    setRescanPage(0);
    setRescanRawText(null);
    setRescanRawFields({});
    setRescanRawApplied(false);
    if (anyApplied) fetchOpeningData();
  }, [rescanResults, rescanRawApplied, fetchOpeningData]);

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

    // Phase-aware: compute counts for the summary bar
    const phaseCounts = activePhase !== 'all' ? getPhaseCounts(items, leafIndex, activePhase) : null;

    // Bulk classify helper for install phase
    const unclassifiedItems = activePhase === 'install' ? items.filter(i => !i.install_type) : [];

    return (
      <>
        {/* Phase summary bar */}
        {phaseCounts && activePhase !== 'all' && (
          <div
            className="mb-3 flex items-center gap-3 px-3 py-2 rounded-md border text-[12px]"
            style={{
              background: 'var(--surface)',
              borderColor: 'var(--border)',
            }}
          >
            <span className="font-semibold tabular-nums" style={{ color: 'var(--green)' }}>
              {phaseCounts.done} done
            </span>
            <span className="text-tertiary">&middot;</span>
            <span className="font-semibold tabular-nums" style={{ color: phaseCounts.remaining > 0 ? 'var(--yellow)' : 'var(--text-tertiary)' }}>
              {phaseCounts.remaining} remaining
            </span>
            {phaseCounts.needsClassification > 0 && (
              <>
                <span className="text-tertiary">&middot;</span>
                <span className="font-semibold tabular-nums" style={{ color: 'var(--red)' }}>
                  {phaseCounts.needsClassification} need classification
                </span>
              </>
            )}
          </div>
        )}

        {/* Bulk classify banner for Install phase */}
        {activePhase === 'install' && unclassifiedItems.length > 0 && (
          <div
            className="mb-3 flex items-center gap-2 flex-wrap px-3 py-2.5 rounded-md border text-[12px] animate-fade-in-up"
            style={{
              background: 'var(--yellow-dim)',
              borderColor: 'var(--yellow)',
            }}
          >
            <span className="font-semibold" style={{ color: 'var(--yellow)' }}>
              {unclassifiedItems.length} item{unclassifiedItems.length > 1 ? 's' : ''} need bench/field classification
            </span>
            <div className="flex gap-1.5 ml-auto">
              <button
                onClick={async () => {
                  for (const item of unclassifiedItems) {
                    await handleInstallTypeChange(item.id, 'field');
                  }
                }}
                className="px-2.5 py-1 rounded font-medium transition-colors"
                style={{ background: 'var(--field-dim)', color: 'var(--field)', border: '1px solid var(--field)' }}
              >
                All Field
              </button>
              <button
                onClick={async () => {
                  for (const item of unclassifiedItems) {
                    await handleInstallTypeChange(item.id, 'bench');
                  }
                }}
                className="px-2.5 py-1 rounded font-medium transition-colors"
                style={{ background: 'var(--bench-dim)', color: 'var(--bench)', border: '1px solid var(--bench)' }}
              >
                All Bench
              </button>
            </div>
          </div>
        )}

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
                {batchActionLoading ? '...' : step === 'received' ? 'Received' : step === 'pre_install' ? 'Pre-Install' : step === 'installed' ? 'Installed' : 'QA/QC'}
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
          <table className={`w-full text-left text-[13px] ${activePhase === 'all' ? 'min-w-[640px]' : 'min-w-0 md:min-w-[640px]'}`}>
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
                {/* Desktop: always show full status column. Mobile: show status only in 'all' phase */}
                <th className={`px-3 py-2 font-medium text-center ${activePhase !== 'all' ? 'hidden md:table-cell' : ''}`}>Status</th>
                {/* Mobile in phase view: single action column */}
                {activePhase !== 'all' && (
                  <th className="px-3 py-2 font-medium text-center md:hidden">
                    {activePhase === 'receive' ? 'Received' : activePhase === 'install' ? 'Install' : 'QA/QC'}
                  </th>
                )}
                <th className={`px-3 py-2 font-medium w-20 text-right ${activePhase !== 'all' ? 'hidden md:table-cell' : ''}`}>Actions</th>
              </tr>
            </thead>
          <tbody>
            {items.map((item, idx) => {
              const scope = classifyItemScope(item.name);
              const displayQty = getLeafDisplayQty(item);
              const steps = getWorkflowSteps(item);
              const completedSteps = steps.filter(s => getStepValue(item, s, leafIndex)).length;
              const isEditing = editingItemId === item.id && editingItem;
              const confidence = getItemConfidence(item);
              const isExpanded = expandedItemId === item.id;

              // Phase-specific: determine the single action step for mobile
              const phaseStep = activePhase !== 'all' ? getPhaseStep(activePhase, item) : null;
              const phaseStepDone = activePhase !== 'all' ? getPhaseStepDone(item, activePhase, leafIndex) : false;
              const needsInstallClassification = activePhase === 'install' && !item.install_type;

              return (
                <React.Fragment key={`${item.id}-leaf${leafIndex}`}>
                  <tr
                    onClick={() => {
                      if (activePhase !== 'all') {
                        setExpandedItemId(isExpanded ? null : item.id);
                      }
                    }}
                    className={`border-b border-th-border transition-colors hover:bg-surface-hover ${
                      activePhase !== 'all' ? 'cursor-pointer md:cursor-default' : ''
                    } ${
                      idx % 2 === 1 ? 'bg-surface/50' : ''
                    } ${
                      item.install_type === 'bench'
                        ? 'border-l-2 border-l-purple'
                        : item.install_type === 'field'
                        ? 'border-l-2 border-l-warning'
                        : ''
                    } ${
                      selectedItems.has(item.id) ? 'bg-accent-dim/30' : ''
                    } ${
                      phaseStepDone ? 'opacity-50' : ''
                    }`}
                  >
                    <td className="px-2 py-2 text-center" onClick={e => e.stopPropagation()}>
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
                          onClick={(e) => { e.stopPropagation(); handleRescanClick(item); }}
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
                    {/* Desktop: full status circles (always visible) */}
                    <td className={`px-3 py-2 ${activePhase !== 'all' ? 'hidden md:table-cell' : ''}`}>
                      <div className="flex items-center justify-center gap-1.5">
                        {steps.map((step) => {
                          const isActive = getStepValue(item, step, leafIndex);
                          const stepColor = getStepColor(step);
                          const stepDimColor = getStepDimColor(step);
                          return (
                            <div key={step} className="flex flex-col items-center gap-0.5">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
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
                    {/* Mobile phase view: single action button for the active phase */}
                    {activePhase !== 'all' && (
                      <td className="px-3 py-2 text-center md:hidden" onClick={e => e.stopPropagation()}>
                        {needsInstallClassification ? (
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => handleInstallTypeChange(item.id, 'field')}
                              className="px-2 py-1.5 rounded text-[10px] font-semibold uppercase min-h-[36px] transition-colors"
                              style={{ background: 'var(--field-dim)', color: 'var(--field)', border: '1px solid var(--field)' }}
                            >
                              Field
                            </button>
                            <button
                              onClick={() => handleInstallTypeChange(item.id, 'bench')}
                              className="px-2 py-1.5 rounded text-[10px] font-semibold uppercase min-h-[36px] transition-colors"
                              style={{ background: 'var(--bench-dim)', color: 'var(--bench)', border: '1px solid var(--bench)' }}
                            >
                              Bench
                            </button>
                          </div>
                        ) : phaseStep ? (
                          <button
                            onClick={() => {
                              playToggle();
                              handleStepToggle(item.id, phaseStep, phaseStepDone, leafIndex);
                            }}
                            className="flex items-center justify-center w-10 h-10 rounded-full transition-colors mx-auto"
                            style={{
                              background: phaseStepDone ? getStepColor(phaseStep) : getStepDimColor(phaseStep),
                              border: phaseStepDone ? `2px solid ${getStepColor(phaseStep)}` : `2px solid var(--border-hover)`,
                            }}
                          >
                            {phaseStepDone ? (
                              <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                              </svg>
                            ) : (
                              <span className="text-[11px] font-bold" style={{ color: 'var(--text-tertiary)' }}>
                                {getStepShortLabel(phaseStep)}
                              </span>
                            )}
                          </button>
                        ) : null}
                      </td>
                    )}
                    {/* Desktop actions (hidden on mobile in phase view) */}
                    <td className={`px-3 py-2 text-right ${activePhase !== 'all' ? 'hidden md:table-cell' : ''}`}>
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={(e) => { e.stopPropagation(); startEditItem(item); }}
                          className="text-tertiary hover:text-secondary w-8 h-8 flex items-center justify-center transition-colors"
                          title="Edit item"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setIssueModal({
                              doorNumber: opening.door_number,
                              hardwareItemName: item.name,
                            });
                          }}
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
                  {/* Mobile tap-to-expand: show actions + full status when row is tapped in phase view */}
                  {activePhase !== 'all' && isExpanded && (
                    <tr key={`expand-${item.id}`} className="md:hidden border-b border-th-border bg-surface-hover">
                      <td colSpan={10} className="px-3 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
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
                                    className="flex items-center justify-center w-7 h-7 rounded-full transition-colors"
                                    style={{
                                      background: isActive ? stepColor : stepDimColor,
                                      border: isActive ? `2px solid ${stepColor}` : `2px solid var(--border-hover)`,
                                    }}
                                  >
                                    {isActive ? (
                                      <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                      </svg>
                                    ) : (
                                      <span className="text-[9px] font-bold" style={{ color: 'var(--text-tertiary)' }}>
                                        {getStepShortLabel(step)}
                                      </span>
                                    )}
                                  </button>
                                  <span className="text-[7px] font-medium uppercase" style={{ color: isActive ? stepColor : 'var(--text-tertiary)' }}>
                                    {getStepShortLabel(step)}
                                  </span>
                                </div>
                              );
                            })}
                            <span className="text-[10px] text-tertiary ml-1 tabular-nums">{completedSteps}/{steps.length}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => startEditItem(item)}
                              className="text-tertiary hover:text-secondary w-9 h-9 flex items-center justify-center transition-colors rounded-md border border-th-border"
                              title="Edit item"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                              </svg>
                            </button>
                            <button
                              onClick={() => setIssueModal({ doorNumber: opening.door_number, hardwareItemName: item.name })}
                              className="text-tertiary hover:text-danger w-9 h-9 flex items-center justify-center transition-colors rounded-md border border-th-border"
                              title="Report issue"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  {isEditing && leafIndex === 1 && renderEditForm(item)}
                  {isEditing && leafIndex !== 1 && (
                    <tr key={`edit-msg-${item.id}`}>
                      <td colSpan={10} className="px-3 py-3 text-tertiary text-[13px] italic text-center bg-surface-hover border-b border-th-border">
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
        <div className="max-w-[900px] mx-auto px-4 py-4 flex items-center justify-between">
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

      <main className="max-w-[900px] mx-auto px-4 py-6">
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
                <span className="inline-flex items-center px-2 py-0.5 rounded bg-success-dim border border-success text-[12px] font-medium text-success max-w-full truncate">
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
            ) : (
              <>
                {/* Workflow Phase Tabs */}
                <div className="flex gap-0.5 mb-4 bg-surface rounded-md p-1">
                  {([
                    { key: 'all' as const, label: 'All', color: 'var(--text-primary)' },
                    { key: 'receive' as const, label: 'Receive', color: 'var(--blue)' },
                    { key: 'install' as const, label: 'Install', color: 'var(--field)' },
                    { key: 'qa' as const, label: 'QA', color: 'var(--green)' },
                  ] as const).map((tab) => {
                    // Count items done in this phase for the badge
                    const allItems = isPair
                      ? (activeLeafTab === 'shared' ? shared : activeLeafTab === 'leaf2' ? leaf2 : leaf1)
                      : opening.hardware_items;
                    const phaseLeafIndex = isPair && activeLeafTab === 'leaf2' ? 2 : 1;
                    const counts = tab.key !== 'all' ? getPhaseCounts(allItems, phaseLeafIndex, tab.key) : null;
                    return (
                      <button
                        key={tab.key}
                        onClick={() => { setActivePhase(tab.key); setExpandedItemId(null); }}
                        className={`flex-1 px-2 py-2.5 min-h-[44px] rounded-md text-[11px] font-semibold uppercase transition-colors flex flex-col items-center gap-0.5 ${
                          activePhase === tab.key
                            ? 'bg-surface-hover border border-th-border-hover'
                            : 'text-tertiary hover:text-secondary'
                        }`}
                        style={{
                          fontFamily: "var(--font-display)",
                          letterSpacing: "0.06em",
                          color: activePhase === tab.key ? tab.color : undefined,
                        }}
                      >
                        <span>{tab.label}</span>
                        {counts && (
                          <span className="text-[10px] opacity-60 tabular-nums">
                            {counts.done}/{counts.total}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {isPair ? (
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
              </>
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
                { label: 'Receiving', value: 'receiving_photo' },
                { label: 'Damage', value: 'damage_photo' },
                { label: 'Install', value: 'install_progress' },
                { label: 'QA Punch', value: 'qa_punch' },
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

                          {/* Damage badge */}
                          {attachment.damage_flag && (
                            <div className="absolute top-2 left-2 bg-danger text-white text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded">
                              Damage
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
      <nav className="md:hidden fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[900px] bg-background/90 backdrop-blur-xl border-t border-th-border pb-[env(safe-area-inset-bottom)] h-16 flex items-center justify-around z-50">
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
      {rescanItem && pdfBuffer && opening && opening.pdf_page != null && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="panel corner-brackets w-full max-w-2xl p-5 animate-fade-in-up max-h-[90vh] overflow-y-auto" style={{ background: 'var(--surface)', overscrollBehavior: 'contain' }}>
            {rescanRawText ? (
              <>
                {/* Multi-Value Field Assignment UI */}
                <div className="mb-4">
                  <h3
                    className="text-[15px] font-bold text-primary mb-1"
                    style={{ fontFamily: "var(--font-display)", letterSpacing: "0.03em" }}
                  >
                    ASSIGN VALUES: {rescanItem.name}
                  </h3>
                  <p className="text-[12px] text-secondary mb-3">
                    No structured items found. Review the extracted text and assign values to fields.
                  </p>
                </div>

                <div
                  className="rounded-md border px-4 py-3 mb-4 text-center"
                  style={{ background: 'var(--tint)', borderColor: 'var(--border)' }}
                >
                  <span className="text-[11px] uppercase tracking-wider text-tertiary font-medium block mb-1">Extracted text</span>
                  <span className="text-[20px] font-bold text-primary" style={{ fontFamily: 'var(--font-mono, monospace)' }}>{rescanRawText}</span>
                </div>

                {!rescanRawApplied ? (
                  <>
                    <div className="rounded-md border overflow-hidden mb-4" style={{ borderColor: 'var(--border)' }}>
                      {/* Table header */}
                      <div className="grid grid-cols-[80px_1fr_1fr_auto] sm:grid-cols-[100px_1fr_1fr_auto] gap-2 px-3 py-2" style={{ background: 'var(--tint)', borderBottom: '1px solid var(--border)' }}>
                        <span className="text-[11px] uppercase tracking-wider text-tertiary font-medium">Field</span>
                        <span className="text-[11px] uppercase tracking-wider text-tertiary font-medium">Current</span>
                        <span className="text-[11px] uppercase tracking-wider text-tertiary font-medium">New value</span>
                        <span className="text-[11px] uppercase tracking-wider text-tertiary font-medium w-[52px]">&nbsp;</span>
                      </div>
                      {/* Field rows */}
                      {(['finish', 'manufacturer', 'model', 'qty'] as const).map((field) => {
                        const currentVal = (rescanItem as unknown as Record<string, unknown>)?.[field];
                        const currentStr = currentVal != null && currentVal !== '' ? String(currentVal) : '';
                        const newVal = rescanRawFields[field] || '';
                        const hasNew = newVal.trim() !== '';
                        const currentEmpty = currentStr === '';
                        const isChanged = hasNew && !currentEmpty && newVal.trim() !== currentStr;
                        const isNew = hasNew && currentEmpty;
                        return (
                          <div
                            key={field}
                            className="grid grid-cols-[80px_1fr_1fr_auto] sm:grid-cols-[100px_1fr_1fr_auto] gap-2 px-3 py-2 items-center"
                            style={{ borderBottom: '1px solid var(--border-dim)' }}
                          >
                            <span className="text-[13px] font-medium text-primary">{field}</span>
                            <span className="text-[13px] text-secondary truncate" title={currentStr || 'empty'}>
                              {currentStr || <span className="text-tertiary italic">empty</span>}
                            </span>
                            <input
                              type="text"
                              value={newVal}
                              onChange={(e) => setRescanRawFields(prev => ({ ...prev, [field]: e.target.value }))}
                              placeholder="—"
                              className="text-[13px] px-2 py-1 rounded border bg-transparent text-primary w-full"
                              style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
                            />
                            <span className="w-[52px] flex justify-end">
                              {isNew && (
                                <span
                                  className="text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded"
                                  style={{ background: 'var(--green-dim)', color: 'var(--green)' }}
                                >
                                  new
                                </span>
                              )}
                              {isChanged && (
                                <span
                                  className="text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded"
                                  style={{ background: 'var(--yellow-dim)', color: 'var(--yellow)' }}
                                >
                                  update
                                </span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleRescanApplyRawText}
                        disabled={!Object.values(rescanRawFields).some(v => v.trim())}
                        className="px-4 py-2 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{ background: 'var(--blue)', color: 'white' }}
                      >
                        Apply
                      </button>
                      <button
                        onClick={() => { setRescanRawText(null); }}
                        className="px-3 py-2 rounded-lg text-[13px] font-medium transition-colors"
                        style={{ background: 'var(--tint)', color: 'var(--secondary)', border: '1px solid var(--border)' }}
                      >
                        Re-scan
                      </button>
                      <button
                        onClick={handleRescanClose}
                        className="px-3 py-2 rounded-lg text-[13px] text-tertiary hover:text-secondary transition-colors ml-auto"
                        style={{ border: '1px solid var(--border)' }}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-2 px-3 py-2">
                      <svg className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--green)' }} fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                      <span className="text-[13px] font-semibold" style={{ color: 'var(--green)' }}>Applied</span>
                    </div>
                    <button
                      onClick={handleRescanClose}
                      className="px-3 py-2 rounded-lg text-[13px] text-tertiary hover:text-secondary transition-colors ml-auto"
                      style={{ border: '1px solid var(--border)' }}
                    >
                      Done
                    </button>
                  </div>
                )}
              </>
            ) : !rescanResults ? (
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
                  pageIndex={rescanPage}
                  onSelect={handleRescanSelect}
                  onCancel={handleRescanClose}
                  loading={rescanLoading}
                  onPageChange={setRescanPage}
                  onError={(msg) => showToast("error", msg)}
                />
              </>
            ) : (
              <>
                {/* Review Panel — field-by-field comparison */}
                <div className="mb-4">
                  <h3
                    className="text-[15px] font-bold text-primary mb-1"
                    style={{ fontFamily: "var(--font-display)", letterSpacing: "0.03em" }}
                  >
                    REVIEW: {rescanResults[0]?.itemName}
                  </h3>
                  <p className="text-[12px] text-secondary mb-3">
                    Toggle fields on/off, then apply selected changes.
                  </p>
                </div>

                <div className="space-y-2 mb-4">
                  {rescanResults.map((result) => (
                    <div
                      key={result.itemId}
                      className="rounded-md border animate-fade-in-up overflow-hidden"
                      style={{
                        background: result.applied ? 'var(--green-dim)' : 'var(--tint)',
                        borderColor: result.applied ? 'var(--green)' : 'var(--border)',
                      }}
                    >
                      {result.applied ? (
                        <div className="px-3 py-3 flex items-center gap-2">
                          <svg className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--green)' }} fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                          <span className="text-[13px] font-semibold" style={{ color: 'var(--green)' }}>Changes applied</span>
                        </div>
                      ) : (
                        <div className="divide-y" style={{ borderColor: 'var(--border-dim)' }}>
                          {result.diffs.map((diff) => (
                            <label
                              key={diff.field}
                              className="flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors hover:bg-surface-hover"
                            >
                              <input
                                type="checkbox"
                                checked={diff.enabled}
                                onChange={() => handleRescanToggleField(result.itemId, diff.field)}
                                className="w-4 h-4 rounded border-th-border bg-transparent accent-accent cursor-pointer flex-shrink-0"
                              />
                              <div className="flex-1 min-w-0">
                                <span className="text-[11px] uppercase tracking-wider text-tertiary font-medium">{diff.field}</span>
                                <div className="flex items-center gap-1.5 mt-0.5 text-[13px]">
                                  {diff.kind === "changed" ? (
                                    <>
                                      <span className="text-secondary line-through">{String(diff.currentValue)}</span>
                                      <span className="text-tertiary">&rarr;</span>
                                      <span className="font-medium" style={{ color: 'var(--yellow)' }}>{String(diff.extractedValue)}</span>
                                    </>
                                  ) : (
                                    <>
                                      <span className="text-tertiary italic">empty</span>
                                      <span className="text-tertiary">&rarr;</span>
                                      <span className="font-medium" style={{ color: 'var(--green)' }}>{String(diff.extractedValue)}</span>
                                    </>
                                  )}
                                </div>
                              </div>
                              <span
                                className="text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded flex-shrink-0"
                                style={{
                                  background: diff.kind === "new" ? 'var(--green-dim)' : 'var(--yellow-dim)',
                                  color: diff.kind === "new" ? 'var(--green)' : 'var(--yellow)',
                                }}
                              >
                                {diff.kind === "new" ? "new" : "update"}
                              </span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  {rescanResults.some(r => !r.applied) && (
                    <button
                      onClick={handleRescanApplySelected}
                      disabled={!rescanResults.some(r => !r.applied && r.diffs.some(d => d.enabled))}
                      className="px-4 py-2 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      style={{
                        background: 'var(--blue)',
                        color: 'white',
                      }}
                    >
                      Apply Selected
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
