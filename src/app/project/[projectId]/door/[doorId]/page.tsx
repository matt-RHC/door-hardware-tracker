"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import OfflineIndicator from "@/components/OfflineIndicator";
import ProgressBar from "@/components/ProgressBar";
import FileViewer from "@/components/FileViewer";
import IssueReportModal from "@/components/IssueReportModal";
import { createClient } from "@/lib/supabase/client";
import { initDB, cacheOpening, getCachedOpening } from "@/lib/offline/db";
import { Opening, HardwareItem, ChecklistProgress, Attachment } from "@/lib/types/database";

interface HardwareItemWithProgress extends HardwareItem {
  progress?: ChecklistProgress;
}

interface OpeningDetail extends Opening {
  hardware_items: HardwareItemWithProgress[];
  attachments: Attachment[];
}

interface EditingItemState {
  itemId: string;
  name: string;
  qty: number;
  manufacturer: string | null;
  model: string | null;
  finish: string | null;
  options: string | null;
  install_type: 'bench' | 'field' | null;
}

interface EditingOpeningState {
  door_number: string;
  hw_set: string | null;
  location: string | null;
  door_type: string | null;
  frame_type: string | null;
  fire_rating: string | null;
  hand: string | null;
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
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<EditingItemState | null>(null);
  const [savingItem, setSavingItem] = useState(false);
  const [editingOpening, setEditingOpening] = useState(false);
  const [editingOpeningData, setEditingOpeningData] = useState<EditingOpeningState | null>(null);
  const [savingOpening, setSavingOpening] = useState(false);
  const [activeTab, setActiveTab] = useState<'hardware' | 'files' | 'notes' | 'qr'>('hardware');
  const [viewingAttachment, setViewingAttachment] = useState<Attachment | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [issueModal, setIssueModal] = useState<{ doorNumber: string; hardwareItem: string } | null>(null);
  const [classifyPrompt, setClassifyPrompt] = useState<{
    itemId: string;
    itemName: string;
    installType: 'bench' | 'field';
    totalCount: number;
  } | null>(null);
  const [classifyLoading, setClassifyLoading] = useState(false);
  const [dontAskClassify, setDontAskClassify] = useState(false);

  const supabase = createClient();

  useEffect(() => {
    initDB().then(() => fetchOpeningData());
  }, [doorId]);

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
        (payload: any) => {
          fetchOpeningData();
        }
      )
      .subscribe();

    return () => {
      (supabase as any).removeChannel(subscription);
    };
  }, [opening, doorId]);

  const fetchOpeningData = async () => {
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
  };

  type WorkflowStep = 'received' | 'pre_install' | 'installed' | 'qa_qc';

  const handleStepToggle = async (itemId: string, step: WorkflowStep, currentValue: boolean) => {
    try {
      const response = await fetch(
        `/api/openings/${doorId}/check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            item_id: itemId,
            step,
            value: !currentValue,
          }),
        }
      );

      if (!response.ok) throw new Error("Failed to update step");
      await fetchOpeningData();
    } catch (err) {
      console.error("Error toggling step:", err);
    }
  };

  const handleInstallTypeChange = async (itemId: string, installType: 'bench' | 'field' | null) => {
    if (!installType || !opening) {
      // Clearing install type — just patch the single item
      try {
        const response = await fetch(
          `/api/openings/${doorId}/items/${itemId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ install_type: installType }),
          }
        );
        if (!response.ok) throw new Error("Failed to update install type");
        await fetchOpeningData();
      } catch (err) {
        console.error("Error updating install type:", err);
      }
      return;
    }

    const item = opening.hardware_items.find(i => i.id === itemId);
    if (!item) return;

    // If user chose "don't ask again", apply to all silently
    if (dontAskClassify) {
      await applyClassification(item.name, installType);
      return;
    }

    // Check how many matching items exist across the project
    try {
      const countRes = await fetch(
        `/api/projects/${projectId}/classify-items?item_name=${encodeURIComponent(item.name)}`
      );
      if (!countRes.ok) {
        // Fallback to single-item update
        await applySingleClassification(itemId, installType);
        return;
      }
      const { total } = await countRes.json();

      if (total > 1) {
        // Show the prompt
        setClassifyPrompt({ itemId, itemName: item.name, installType, totalCount: total });
      } else {
        // Only one instance, just apply directly
        await applySingleClassification(itemId, installType);
      }
    } catch {
      await applySingleClassification(itemId, installType);
    }
  };

  const applySingleClassification = async (itemId: string, installType: 'bench' | 'field') => {
    try {
      const response = await fetch(
        `/api/openings/${doorId}/items/${itemId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ install_type: installType }),
        }
      );
      if (!response.ok) throw new Error("Failed to update install type");
      await fetchOpeningData();
    } catch (err) {
      console.error("Error updating install type:", err);
    }
  };

  const applyClassification = async (itemName: string, installType: 'bench' | 'field', itemIds?: string[]) => {
    setClassifyLoading(true);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/classify-items`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            item_name: itemName,
            install_type: installType,
            ...(itemIds ? { item_ids: itemIds } : {}),
          }),
        }
      );
      if (!response.ok) throw new Error("Failed to classify items");
      await fetchOpeningData();
    } catch (err) {
      console.error("Error classifying items:", err);
    } finally {
      setClassifyLoading(false);
      setClassifyPrompt(null);
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
    }
  };

  const handleSaveNotes = async () => {
    setSavingNotes(true);
    try {
      // TODO: Implement notes save to Supabase
      setSavingNotes(false);
    } catch (err) {
      console.error("Error saving notes:", err);
      setSavingNotes(false);
    }
  };

  const startEditItem = (item: HardwareItemWithProgress) => {
    setEditingItemId(item.id);
    setEditingItem({
      itemId: item.id,
      name: item.name,
      qty: item.qty,
      manufacturer: item.manufacturer,
      model: item.model,
      finish: item.finish,
      options: item.options,
      install_type: item.install_type || null,
    });
  };

  const cancelEditItem = () => {
    setEditingItemId(null);
    setEditingItem(null);
  };

  const saveEditItem = async () => {
    if (!editingItem) return;
    setSavingItem(true);
    try {
      const response = await fetch(
        `/api/openings/${doorId}/items/${editingItem.itemId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: editingItem.name,
            qty: editingItem.qty,
            manufacturer: editingItem.manufacturer,
            model: editingItem.model,
            finish: editingItem.finish,
            options: editingItem.options,
            install_type: editingItem.install_type,
          }),
        }
      );

      if (!response.ok) throw new Error("Failed to save item");
      await fetchOpeningData();
      setEditingItemId(null);
      setEditingItem(null);
    } catch (err) {
      console.error("Error saving item:", err);
    } finally {
      setSavingItem(false);
    }
  };

  const startEditOpening = () => {
    if (!opening) return;
    setEditingOpening(true);
    setEditingOpeningData({
      door_number: opening.door_number,
      hw_set: opening.hw_set,
      location: opening.location,
      door_type: opening.door_type,
      frame_type: opening.frame_type,
      fire_rating: opening.fire_rating,
      hand: opening.hand,
    });
  };

  const cancelEditOpening = () => {
    setEditingOpening(false);
    setEditingOpeningData(null);
  };

  const saveEditOpening = async () => {
    if (!editingOpeningData) return;
    setSavingOpening(true);
    try {
      const response = await fetch(
        `/api/projects/${projectId}/openings/${doorId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(editingOpeningData),
        }
      );

      if (!response.ok) throw new Error("Failed to save opening");
      await fetchOpeningData();
      setEditingOpening(false);
      setEditingOpeningData(null);
    } catch (err) {
      console.error("Error saving opening:", err);
    } finally {
      setSavingOpening(false);
    }
  };

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
    } finally {
      setAttachmentLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="text-[#a1a1a6]">Loading...</div>
      </div>
    );
  }

  if (error && !opening) {
    return (
      <div className="min-h-screen bg-black p-4">
        <div className="p-4 bg-[rgba(255,69,58,0.15)] border border-[#ff453a] rounded-lg text-[#ff453a]">
          {error}
        </div>
      </div>
    );
  }

  if (!opening) return null;

  const totalItems = opening.hardware_items.length;
  // An item is "complete" when its final step (qa_qc) is checked
  const completedItems = opening.hardware_items.filter(
    (item) => item.progress?.qa_qc
  ).length;
  // For backward compat: also count old-style checked items
  const checkedItems = opening.hardware_items.filter(
    (item) => item.progress?.qa_qc || item.progress?.checked
  ).length;
  const progress = totalItems > 0 ? (checkedItems / totalItems) * 100 : 0;

  // Workflow step helper
  const getStepLabel = (item: HardwareItemWithProgress, step: WorkflowStep): string => {
    if (step === 'received') return 'Received';
    if (step === 'pre_install') return 'Pre-Install';
    if (step === 'installed') return 'Installed';
    if (step === 'qa_qc') return 'QA/QC';
    return step;
  };

  const getStepValue = (item: HardwareItemWithProgress, step: WorkflowStep): boolean => {
    if (!item.progress) return false;
    return !!(item.progress as any)[step];
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

  return (
    <div className="min-h-screen bg-black pb-20">
      <OfflineIndicator />

      {/* Sticky Header */}
      <header className="sticky top-0 z-50 bg-black/85 backdrop-blur-xl border-b border-white/[0.08]">
        <div className="max-w-[430px] md:max-w-[900px] mx-auto px-4 py-4 flex items-center justify-between">
          <button
            onClick={() => router.push(`/project/${projectId}`)}
            className="text-[#0a84ff] hover:text-[#0a84ff]/80 flex items-center gap-1 text-[15px]"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-[17px] font-semibold text-[#f5f5f7]">
            Door {opening.door_number}
          </h1>
          {!editingOpening && (
            <button
              onClick={startEditOpening}
              className="text-[#a1a1a6] hover:text-[#f5f5f7] p-1"
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
          <div className="mb-6 bg-white/[0.04] border border-white/[0.08] rounded-xl p-4 space-y-4">
            <div>
              <label className="block text-[13px] text-[#a1a1a6] mb-2">Door Number</label>
              <input
                type="text"
                value={editingOpeningData.door_number}
                onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, door_number: e.target.value } : null)}
                className="w-full px-3 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-lg text-[#f5f5f7] placeholder-[#6e6e73] focus:border-[rgba(10,132,255,0.3)] focus:outline-none text-[15px]"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] text-[#a1a1a6] mb-2">HW Set</label>
                <input
                  type="text"
                  value={editingOpeningData.hw_set || ""}
                  onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, hw_set: e.target.value || null } : null)}
                  placeholder="Optional"
                  className="w-full px-3 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-lg text-[#f5f5f7] placeholder-[#6e6e73] focus:border-[rgba(10,132,255,0.3)] focus:outline-none text-[15px]"
                />
              </div>
              <div>
                <label className="block text-[13px] text-[#a1a1a6] mb-2">Location</label>
                <input
                  type="text"
                  value={editingOpeningData.location || ""}
                  onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, location: e.target.value || null } : null)}
                  placeholder="Optional"
                  className="w-full px-3 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-lg text-[#f5f5f7] placeholder-[#6e6e73] focus:border-[rgba(10,132,255,0.3)] focus:outline-none text-[15px]"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] text-[#a1a1a6] mb-2">Door Type</label>
                <input
                  type="text"
                  value={editingOpeningData.door_type || ""}
                  onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, door_type: e.target.value || null } : null)}
                  placeholder="Optional"
                  className="w-full px-3 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-lg text-[#f5f5f7] placeholder-[#6e6e73] focus:border-[rgba(10,132,255,0.3)] focus:outline-none text-[15px]"
                />
              </div>
              <div>
                <label className="block text-[13px] text-[#a1a1a6] mb-2">Frame Type</label>
                <input
                  type="text"
                  value={editingOpeningData.frame_type || ""}
                  onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, frame_type: e.target.value || null } : null)}
                  placeholder="Optional"
                  className="w-full px-3 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-lg text-[#f5f5f7] placeholder-[#6e6e73] focus:border-[rgba(10,132,255,0.3)] focus:outline-none text-[15px]"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[13px] text-[#a1a1a6] mb-2">Fire Rating</label>
                <input
                  type="text"
                  value={editingOpeningData.fire_rating || ""}
                  onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, fire_rating: e.target.value || null } : null)}
                  placeholder="Optional"
                  className="w-full px-3 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-lg text-[#f5f5f7] placeholder-[#6e6e73] focus:border-[rgba(10,132,255,0.3)] focus:outline-none text-[15px]"
                />
              </div>
              <div>
                <label className="block text-[13px] text-[#a1a1a6] mb-2">Hand</label>
                <input
                  type="text"
                  value={editingOpeningData.hand || ""}
                  onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, hand: e.target.value || null } : null)}
                  placeholder="Optional"
                  className="w-full px-3 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-lg text-[#f5f5f7] placeholder-[#6e6e73] focus:border-[rgba(10,132,255,0.3)] focus:outline-none text-[15px]"
                />
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={saveEditOpening}
                disabled={savingOpening}
                className="flex-1 px-4 py-2.5 bg-[#0a84ff] hover:bg-[#0a84ff]/80 disabled:bg-white/[0.04] text-white disabled:text-[#6e6e73] rounded-lg transition-colors text-[15px] font-medium"
              >
                {savingOpening ? "Saving..." : "Save"}
              </button>
              <button
                onClick={cancelEditOpening}
                disabled={savingOpening}
                className="flex-1 px-4 py-2.5 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.07] disabled:opacity-50 text-[#a1a1a6] rounded-lg transition-colors text-[15px] font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Hero Card */}
        {!editingOpening && (
          <div className="mb-6 bg-white/[0.04] border border-white/[0.08] rounded-xl p-4">
            <h1 className="text-[34px] md:text-[42px] font-bold tracking-tight text-[#f5f5f7] mb-2">
              {opening.door_number}
            </h1>

            {opening.hw_set && (
              <div className="mb-3 flex items-center gap-2">
                <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-[rgba(48,209,88,0.15)] border border-[#30d158] text-[12px] font-medium text-[#30d158]">
                  {opening.hw_set}
                  {opening.hw_heading && ` — ${opening.hw_heading}`}
                </span>
              </div>
            )}

            {opening.location && (
              <p className="text-[15px] text-[#a1a1a6] mb-3">
                {opening.location}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              {opening.door_type && (
                <span className="text-[11px] font-medium uppercase text-[#6e6e73] bg-white/[0.04] border border-white/[0.08] px-2 py-1 rounded-full">
                  {opening.door_type}
                </span>
              )}
              {opening.fire_rating && (
                <span className="text-[11px] font-medium uppercase text-[#ff453a] bg-[rgba(255,69,58,0.15)] border border-[#ff453a] px-2 py-1 rounded-full">
                  {opening.fire_rating}
                </span>
              )}
              {opening.hand && (
                <span className="text-[11px] font-medium uppercase text-[#6e6e73] bg-white/[0.04] border border-white/[0.08] px-2 py-1 rounded-full">
                  {opening.hand}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Progress Bar */}
        {!editingOpening && (
          <div className="mb-6">
            <div className="flex justify-between items-center mb-2">
              <span className="text-[11px] uppercase font-medium text-[#6e6e73]">Progress</span>
              <span className="text-[13px] text-[#a1a1a6]">
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
          <div className="flex gap-0.5 mb-6 bg-white/[0.04] rounded-lg p-1">
            {(['hardware', 'files', 'notes', 'qr'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 px-3 py-2 rounded-lg text-[12px] font-medium uppercase transition-colors ${
                  activeTab === tab
                    ? 'bg-white/[0.07] text-[#f5f5f7]'
                    : 'text-[#6e6e73] hover:text-[#a1a1a6]'
                }`}
              >
                {tab === 'qr' ? 'QR' : tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
        )}

        {/* Hardware Tab */}
        {activeTab === 'hardware' && !editingOpening && (
          <div className="space-y-3 mb-8">
            {opening.hardware_items.length === 0 ? (
              <p className="text-[#a1a1a6] text-center py-8">No hardware items yet</p>
            ) : (
              opening.hardware_items.map((item) => (
                <div
                  key={item.id}
                  className={`bg-white/[0.04] border rounded-xl p-3.5 transition-colors hover:bg-white/[0.07] hover:border-white/[0.14] ${
                    item.install_type === 'bench'
                      ? 'border-l-[3px] border-l-[#bf5af2] border-white/[0.08]'
                      : item.install_type === 'field'
                      ? 'border-l-[3px] border-l-[#ff9f0a] border-white/[0.08]'
                      : 'border-white/[0.08]'
                  }`}
                >
                  {editingItemId === item.id && editingItem ? (
                    // Edit mode
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[12px] text-[#a1a1a6] mb-1">Name</label>
                          <input
                            type="text"
                            value={editingItem.name}
                            onChange={(e) => setEditingItem({ ...editingItem, name: e.target.value })}
                            className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-[#f5f5f7] placeholder-[#6e6e73] focus:border-[rgba(10,132,255,0.3)] focus:outline-none text-[13px]"
                          />
                        </div>
                        <div>
                          <label className="block text-[12px] text-[#a1a1a6] mb-1">Qty</label>
                          <input
                            type="number"
                            value={editingItem.qty}
                            onChange={(e) => setEditingItem({ ...editingItem, qty: parseInt(e.target.value) || 0 })}
                            className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-[#f5f5f7] placeholder-[#6e6e73] focus:border-[rgba(10,132,255,0.3)] focus:outline-none text-[13px]"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className="block text-[12px] text-[#a1a1a6] mb-1">Manufacturer</label>
                          <input
                            type="text"
                            value={editingItem.manufacturer || ""}
                            onChange={(e) => setEditingItem({ ...editingItem, manufacturer: e.target.value || null })}
                            placeholder="Optional"
                            className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-[#f5f5f7] placeholder-[#6e6e73] focus:border-[rgba(10,132,255,0.3)] focus:outline-none text-[13px]"
                          />
                        </div>
                        <div>
                          <label className="block text-[12px] text-[#a1a1a6] mb-1">Model</label>
                          <input
                            type="text"
                            value={editingItem.model || ""}
                            onChange={(e) => setEditingItem({ ...editingItem, model: e.target.value || null })}
                            placeholder="Optional"
                            className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-[#f5f5f7] placeholder-[#6e6e73] focus:border-[rgba(10,132,255,0.3)] focus:outline-none text-[13px]"
                          />
                        </div>
                        <div>
                          <label className="block text-[12px] text-[#a1a1a6] mb-1">Finish</label>
                          <input
                            type="text"
                            value={editingItem.finish || ""}
                            onChange={(e) => setEditingItem({ ...editingItem, finish: e.target.value || null })}
                            placeholder="Optional"
                            className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-[#f5f5f7] placeholder-[#6e6e73] focus:border-[rgba(10,132,255,0.3)] focus:outline-none text-[13px]"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[12px] text-[#a1a1a6] mb-1">Options</label>
                          <input
                            type="text"
                            value={editingItem.options || ""}
                            onChange={(e) => setEditingItem({ ...editingItem, options: e.target.value || null })}
                            placeholder="Optional"
                            className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-[#f5f5f7] placeholder-[#6e6e73] focus:border-[rgba(10,132,255,0.3)] focus:outline-none text-[13px]"
                          />
                        </div>
                        <div>
                          <label className="block text-[12px] text-[#a1a1a6] mb-1">Install Type</label>
                          <select
                            value={editingItem.install_type || ""}
                            onChange={(e) => setEditingItem({ ...editingItem, install_type: (e.target.value as 'bench' | 'field') || null })}
                            className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-[#f5f5f7] focus:border-[rgba(10,132,255,0.3)] focus:outline-none text-[13px]"
                          >
                            <option value="">Not set</option>
                            <option value="bench">Bench</option>
                            <option value="field">Field</option>
                          </select>
                        </div>
                      </div>

                      <div className="flex gap-2 pt-2">
                        <button
                          onClick={saveEditItem}
                          disabled={savingItem}
                          className="flex-1 px-3 py-2 bg-[#0a84ff] hover:bg-[#0a84ff]/80 disabled:bg-white/[0.04] text-white disabled:text-[#6e6e73] rounded-lg transition-colors text-[13px] font-medium"
                        >
                          {savingItem ? "Saving..." : "Save"}
                        </button>
                        <button
                          onClick={cancelEditItem}
                          disabled={savingItem}
                          className="flex-1 px-3 py-2 bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.07] disabled:opacity-50 text-[#a1a1a6] rounded-lg transition-colors text-[13px] font-medium"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    // View mode
                    <>
                      <div className="flex justify-between items-start mb-2">
                        <h3 className="text-[15px] font-medium text-[#f5f5f7]">{item.name}</h3>
                        <div className="flex items-center gap-2">
                          {item.qty > 0 && (
                            <span className="text-[12px] font-medium text-[#a1a1a6] bg-white/[0.04] px-2 py-1 rounded-lg">
                              Qty {item.qty}
                            </span>
                          )}
                          <button
                            onClick={() => startEditItem(item)}
                            className="text-[#6e6e73] hover:text-[#a1a1a6] p-1"
                            title="Edit item"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>
                        </div>
                      </div>

                      {formatSpec(item) && (
                        <p className="text-[13px] text-[#6e6e73] mb-2">
                          {formatSpec(item)}
                        </p>
                      )}

                      {item.options && (
                        <p className="text-[12px] text-[#6e6e73] mb-2">
                          {item.options}
                        </p>
                      )}

                      {/* Install type selector (if not set) */}
                      {!item.install_type && (
                        <div className="flex items-center gap-2 mb-3">
                          <span className="text-[12px] text-[#6e6e73]">Classify:</span>
                          <button
                            onClick={() => handleInstallTypeChange(item.id, 'bench')}
                            className="text-[12px] px-2.5 py-1 bg-[rgba(191,90,242,0.15)] text-[#bf5af2] rounded-lg hover:bg-[rgba(191,90,242,0.25)] transition-colors border border-[#bf5af2]"
                          >
                            Bench
                          </button>
                          <button
                            onClick={() => handleInstallTypeChange(item.id, 'field')}
                            className="text-[12px] px-2.5 py-1 bg-[rgba(255,159,10,0.15)] text-[#ff9f0a] rounded-lg hover:bg-[rgba(255,159,10,0.25)] transition-colors border border-[#ff9f0a]"
                          >
                            Field
                          </button>
                        </div>
                      )}

                      {/* Workflow steps with green checks */}
                      <div className="flex flex-wrap items-center gap-2 mt-3">
                        {getWorkflowSteps(item).map((step, idx) => {
                          const isActive = getStepValue(item, step);
                          const label = getStepLabel(item, step);
                          return (
                            <div key={step} className="flex items-center gap-2">
                              <button
                                onClick={() => handleStepToggle(item.id, step, isActive)}
                                className="flex items-center justify-center w-7 h-7 rounded-full transition-colors"
                                style={{
                                  background: isActive ? '#30d158' : 'transparent',
                                  border: isActive ? '2px solid #30d158' : '2px solid rgba(110,110,115,0.4)',
                                }}
                              >
                                {isActive && (
                                  <svg className="w-3.5 h-3.5 text-white" fill="currentColor" viewBox="0 0 20 20">
                                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                  </svg>
                                )}
                              </button>
                              <span className="text-[10px] uppercase font-medium text-[#6e6e73]" style={{ color: isActive ? '#30d158' : '#6e6e73' }}>
                                {label}
                              </span>
                              {idx < getWorkflowSteps(item).length - 1 && (
                                <div
                                  className="w-6 h-0.5"
                                  style={{
                                    background: isActive ? '#30d158' : 'rgba(110,110,115,0.3)',
                                  }}
                                />
                              )}
                            </div>
                          );
                        })}

                        {/* Change install type */}
                        {item.install_type && (
                          <button
                            onClick={() => handleInstallTypeChange(
                              item.id,
                              item.install_type === 'bench' ? 'field' : 'bench'
                            )}
                            className="ml-2 text-[11px] text-[#6e6e73] hover:text-[#a1a1a6] underline"
                            title={`Switch to ${item.install_type === 'bench' ? 'field' : 'bench'}`}
                          >
                            Switch to {item.install_type === 'bench' ? 'Field' : 'Bench'}
                          </button>
                        )}

                        <button
                          onClick={() => setIssueModal({
                            doorNumber: opening.door_number,
                            hardwareItem: item.name,
                          })}
                          className="ml-auto text-[11px] text-[#ff453a] hover:text-[#ff6961] transition-colors"
                        >
                          Report Issue
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))
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
                  className={`text-[12px] font-medium px-3 py-1.5 rounded-full transition-colors ${
                    activeCategory === cat.value
                      ? 'bg-[rgba(10,132,255,0.15)] border border-[#0a84ff] text-[#0a84ff]'
                      : 'bg-white/[0.04] border border-white/[0.08] text-[#a1a1a6] hover:bg-white/[0.07]'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>

            {/* Attachment cards */}
            {opening.attachments && opening.attachments.length > 0 ? (
              <div className="space-y-3">
                {opening.attachments
                  .filter((att) => !activeCategory || att.category === activeCategory)
                  .map((attachment) => {
                    const isPdf = attachment.file_type?.includes("pdf") || attachment.file_name?.toLowerCase().endsWith(".pdf");
                    const isImage = attachment.file_type?.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(attachment.file_name || "");

                    return (
                      <button
                        key={attachment.id}
                        onClick={() => setViewingAttachment(attachment)}
                        className="w-full text-left bg-white/[0.04] border border-white/[0.08] rounded-xl overflow-hidden hover:bg-white/[0.07] hover:border-white/[0.14] transition-colors group"
                      >
                        {/* Preview area */}
                        <div className="relative w-full h-40 bg-white/[0.02] overflow-hidden">
                          {isImage ? (
                            <img
                              src={attachment.file_url}
                              alt={attachment.file_name || ""}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            />
                          ) : isPdf ? (
                            <div className="w-full h-full flex flex-col items-center justify-center gap-2">
                              <svg className="w-10 h-10 text-[#ff453a]" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM6 20V4h7v5h5v11H6z" />
                                <path d="M8 14h2v2H8v-2zm3 0h2v2h-2v-2zm3 0h2v2h-2v-2z" />
                              </svg>
                              <span className="text-[11px] font-medium text-[#ff453a] uppercase tracking-wider">PDF</span>
                            </div>
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <svg className="w-10 h-10 text-[#6e6e73]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                            <p className="text-[13px] font-medium text-[#f5f5f7] truncate">
                              {attachment.file_name}
                            </p>
                            <p className="text-[11px] text-[#6e6e73] mt-0.5 capitalize">
                              {(attachment.category || 'general').replace('_', ' ')}
                              {attachment.uploaded_at && ` · ${new Date(attachment.uploaded_at).toLocaleDateString()}`}
                            </p>
                          </div>
                          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                            <svg className="w-4 h-4 text-[#0a84ff]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                <svg className="w-12 h-12 text-[#6e6e73] mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
                <p className="text-[#a1a1a6] text-[15px]">No files yet</p>
                <p className="text-[#6e6e73] text-[12px] mt-1">Upload drawings, plans, or photos</p>
              </div>
            )}

            {/* Upload button */}
            <label className="block p-4 bg-white/[0.04] border border-dashed border-white/[0.12] rounded-xl text-center cursor-pointer hover:bg-white/[0.07] active:bg-white/[0.10] transition-colors">
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
                <svg className="w-5 h-5 text-[#0a84ff]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                <p className="text-[15px] font-medium text-[#f5f5f7]">
                  {attachmentLoading ? "Uploading..." : "Upload File"}
                </p>
              </div>
              <p className="text-[12px] text-[#6e6e73] mt-1">
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
              className="w-full px-4 py-3 bg-white/[0.04] border border-white/[0.08] rounded-xl text-[#f5f5f7] placeholder-[#6e6e73] focus:border-[rgba(10,132,255,0.3)] focus:outline-none min-h-32 resize-none text-[15px]"
            />
            <button
              onClick={handleSaveNotes}
              disabled={savingNotes}
              className="mt-4 px-4 py-2.5 bg-[#0a84ff] hover:bg-[#0a84ff]/80 disabled:bg-white/[0.04] text-white disabled:text-[#6e6e73] rounded-lg transition-colors text-[15px] font-medium"
            >
              {savingNotes ? "Saving..." : "Save Notes"}
            </button>
          </div>
        )}

        {/* QR Tab */}
        {activeTab === 'qr' && !editingOpening && (
          <div className="flex flex-col items-center justify-center py-8 mb-8">
            <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-4 mb-4">
              <QRCodeSVG
                value={qrUrl}
                size={200}
                level="H"
                includeMargin={true}
              />
            </div>
            <p className="text-[15px] text-[#a1a1a6] text-center mb-4">
              Scan to open this door on mobile
            </p>
            <button className="px-4 py-2.5 bg-[#0a84ff] hover:bg-[#0a84ff]/80 text-white rounded-lg transition-colors text-[15px] font-medium">
              Share
            </button>
          </div>
        )}
      </main>

      {/* Bottom Navigation Bar */}
      <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] md:max-w-[900px] bg-black/90 backdrop-blur-xl border-t border-white/[0.08] h-16 flex items-center justify-around">
        {(['hardware', 'files', 'notes', 'qr'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex flex-col items-center gap-1 px-3 py-2 transition-colors ${
              activeTab === tab
                ? 'text-[#0a84ff]'
                : 'text-[#6e6e73] hover:text-[#a1a1a6]'
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
          hardwareItem={issueModal.hardwareItem}
          onClose={() => setIssueModal(null)}
          onCreated={() => setIssueModal(null)}
        />
      )}

      {/* Classify apply-to-all prompt */}
      {classifyPrompt && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="panel corner-brackets w-full max-w-sm p-5 animate-fade-in-up">
            <h3
              className="text-[15px] font-bold text-[#e8e8ed] mb-3"
              style={{ fontFamily: "var(--font-display)", letterSpacing: "0.03em" }}
            >
              APPLY TO ALL?
            </h3>
            <p className="text-[13px] text-[#a1a1a6] mb-1">
              <span className="text-[#e8e8ed] font-medium">{classifyPrompt.itemName}</span> appears in{" "}
              <span className="text-[#5ac8fa] font-medium">{classifyPrompt.totalCount}</span> openings.
            </p>
            <p className="text-[13px] text-[#a1a1a6] mb-4">
              Classify all as{" "}
              <span
                className="font-medium"
                style={{
                  color: classifyPrompt.installType === 'bench' ? '#bf5af2' : '#ff9f0a',
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
                className="glow-btn--primary w-full rounded-lg py-2 text-[13px] disabled:opacity-40"
              >
                {classifyLoading ? "Applying..." : `Yes, apply to all ${classifyPrompt.totalCount}`}
              </button>
              <button
                onClick={() => {
                  applySingleClassification(classifyPrompt.itemId, classifyPrompt.installType);
                  setClassifyPrompt(null);
                }}
                disabled={classifyLoading}
                className="glow-btn--ghost w-full rounded-lg py-2 text-[13px] disabled:opacity-40"
              >
                Just this one
              </button>
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={dontAskClassify}
                onChange={(e) => setDontAskClassify(e.target.checked)}
                className="w-4 h-4 rounded border-[#3a3a3c] bg-transparent accent-[#5ac8fa]"
              />
              <span className="text-[11px] text-[#636366]">Don&apos;t ask again (apply to all automatically)</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
