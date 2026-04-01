"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import OfflineIndicator from "@/components/OfflineIndicator";
import ProgressBar from "@/components/ProgressBar";
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

function DrawingTab({
  category,
  label,
  attachments,
  onUpload,
  uploading,
}: {
  category: string;
  label: string;
  attachments: any[];
  onUpload: (file: File) => void;
  uploading: boolean;
}) {
  const latest = attachments.length > 0 ? attachments[attachments.length - 1] : null;
  const isPdf = latest?.file_type === 'application/pdf' || latest?.file_name?.match(/\.pdf$/i);
  const isImage = latest?.file_type?.startsWith('image/') || latest?.file_name?.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i);

  return (
    <div className="bg-slate-900 rounded-lg border border-slate-800 p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-white">{label}</h2>
        <div className="flex items-center gap-3">
          {attachments.length > 1 && (
            <span className="text-xs text-slate-500">
              {attachments.length} version{attachments.length !== 1 ? 's' : ''} uploaded
            </span>
          )}
          {latest && (
            <a
              href={latest.file_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              Open in new tab
            </a>
          )}
        </div>
      </div>

      {latest ? (
        <div className="mb-4">
          {isPdf ? (
            <div className="relative rounded-lg border border-slate-700 overflow-hidden bg-white">
              <iframe
                src={`${latest.file_url}#toolbar=1&navpanes=0&view=FitH`}
                className="w-full border-0"
                style={{ height: '75vh', minHeight: '500px' }}
                title={label}
              />
            </div>
          ) : isImage ? (
            <div className="relative group rounded-lg border border-slate-700 overflow-hidden">
              <img
                src={latest.file_url}
                alt={label}
                className="w-full bg-slate-800"
              />
            </div>
          ) : (
            <div className="flex items-center gap-3 p-4 bg-slate-800 rounded-lg border border-slate-700">
              <svg className="w-8 h-8 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
              <div>
                <p className="text-white text-sm font-medium">{latest.file_name}</p>
                <p className="text-slate-500 text-xs">Uploaded {new Date(latest.uploaded_at).toLocaleDateString()}</p>
              </div>
            </div>
          )}
          <p className="text-xs text-slate-500 mt-2">
            {latest.file_name} — uploaded {new Date(latest.uploaded_at).toLocaleDateString()}
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-slate-500 border border-dashed border-slate-700 rounded-lg mb-4">
          <svg className="w-12 h-12 mb-3 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <p className="text-sm">No {label.toLowerCase()} uploaded yet</p>
          <p className="text-xs text-slate-600 mt-1">Supports PDF and image files</p>
        </div>
      )}

      <label className="block w-full px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded cursor-pointer transition-colors text-center text-sm">
        <input
          type="file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onUpload(file);
          }}
          disabled={uploading}
          className="hidden"
          accept="image/*,application/pdf"
        />
        {uploading ? "Uploading..." : latest ? `Replace ${label}` : `Upload ${label}`}
      </label>
    </div>
  );
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
  const [activeTab, setActiveTab] = useState<'hardware' | 'floor_plan' | 'door_drawing' | 'frame_drawing'>('hardware');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<EditingItemState | null>(null);
  const [savingItem, setSavingItem] = useState(false);
  const [editingOpening, setEditingOpening] = useState(false);
  const [editingOpeningData, setEditingOpeningData] = useState<EditingOpeningState | null>(null);
  const [savingOpening, setSavingOpening] = useState(false);
  const [classifyConfirm, setClassifyConfirm] = useState<{
    itemId: string;
    itemName: string;
    installType: 'bench' | 'field';
    totalAcrossProject: number;
    unclassifiedAcrossProject: number;
  } | null>(null);

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

  const handleInstallTypeClick = async (itemId: string, installType: 'bench' | 'field') => {
    if (!opening) return;
    const item = opening.hardware_items.find(i => i.id === itemId);
    if (!item) return;

    // Check how many items with this name exist across the whole project
    try {
      const res = await fetch(
        `/api/projects/${projectId}/classify-items?item_name=${encodeURIComponent(item.name)}`
      );
      const counts = await res.json();

      if (counts.total > 1) {
        setClassifyConfirm({
          itemId,
          itemName: item.name,
          installType,
          totalAcrossProject: counts.total,
          unclassifiedAcrossProject: counts.unclassified,
        });
      } else {
        // Only one in the whole project, just apply
        applyInstallType(item.name, installType, false);
      }
    } catch (err) {
      // Fallback: just apply to this one
      applyInstallType(item.name, installType, false, [itemId]);
    }
  };

  const applyInstallType = async (
    itemName: string,
    installType: 'bench' | 'field',
    applyToAll: boolean,
    specificIds?: string[]
  ) => {
    try {
      const body: any = { item_name: itemName, install_type: installType };
      if (!applyToAll && specificIds) {
        body.item_ids = specificIds;
      } else if (!applyToAll) {
        // "Just this one" — find the item id from classifyConfirm or opening
        const item = opening?.hardware_items.find(i => i.name === itemName);
        if (item) body.item_ids = [classifyConfirm?.itemId || item.id];
      }
      // If applyToAll is true, don't pass item_ids — API updates all matching by name

      await fetch(`/api/projects/${projectId}/classify-items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await fetchOpeningData();
    } catch (err) {
      console.error("Error updating install type:", err);
    }
    setClassifyConfirm(null);
  };

  const handleInstallTypeChange = async (itemId: string, installType: 'bench' | 'field' | null) => {
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

  const handleFileUpload = async (file: File, category: string = 'general') => {
    setAttachmentLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("category", category);

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

  const getAttachmentsByCategory = (category: string) => {
    if (!opening?.attachments) return [];
    return opening.attachments.filter((a: any) => (a.category || 'general') === category);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-slate-400">Loading...</div>
      </div>
    );
  }

  if (error && !opening) {
    return (
      <div className="min-h-screen bg-slate-950 p-4">
        <div className="p-4 bg-red-900/20 border border-red-900 rounded text-red-200">
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
    <div className="min-h-screen bg-slate-950">
      <OfflineIndicator />

      <main className="max-w-4xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <button
            onClick={() => router.push(`/project/${projectId}`)}
            className="text-blue-400 hover:text-blue-300 mb-4 text-sm"
          >
            &larr; Back to Project
          </button>

          <div className="flex justify-between items-start mb-6">
            <div className="flex-1">
              {!editingOpening ? (
                <>
                  <div className="flex items-start gap-2 mb-2">
                    <h1 className="text-3xl font-bold text-white">
                      Door {opening.door_number}
                    </h1>
                    <button
                      onClick={startEditOpening}
                      className="text-slate-400 hover:text-slate-300 p-1 mt-1"
                      title="Edit door details"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                  </div>
                  {opening.hw_set && (
                    <p className="text-slate-300 text-sm mb-1">
                      HW Set: {opening.hw_set}
                      {opening.hw_heading ? ` — ${opening.hw_heading}` : ""}
                    </p>
                  )}
                  {opening.location && (
                    <p className="text-slate-400">{opening.location}</p>
                  )}
                  <div className="flex flex-wrap gap-2 mt-2">
                    {opening.door_type && (
                      <span className="text-xs bg-slate-800 text-slate-300 px-2 py-1 rounded">
                        {opening.door_type}
                      </span>
                    )}
                    {opening.fire_rating && (
                      <span className="text-xs bg-red-900/40 text-red-300 px-2 py-1 rounded">
                        {opening.fire_rating}
                      </span>
                    )}
                    {opening.hand && (
                      <span className="text-xs bg-slate-800 text-slate-300 px-2 py-1 rounded">
                        {opening.hand}
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <div className="space-y-4 bg-slate-800 p-4 rounded border border-slate-700">
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Door Number</label>
                    <input
                      type="text"
                      value={editingOpeningData?.door_number || ""}
                      onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, door_number: e.target.value } : null)}
                      className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">HW Set</label>
                      <input
                        type="text"
                        value={editingOpeningData?.hw_set || ""}
                        onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, hw_set: e.target.value || null } : null)}
                        placeholder="Optional"
                        className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">Location</label>
                      <input
                        type="text"
                        value={editingOpeningData?.location || ""}
                        onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, location: e.target.value || null } : null)}
                        placeholder="Optional"
                        className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">Door Type</label>
                      <input
                        type="text"
                        value={editingOpeningData?.door_type || ""}
                        onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, door_type: e.target.value || null } : null)}
                        placeholder="Optional"
                        className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">Frame Type</label>
                      <input
                        type="text"
                        value={editingOpeningData?.frame_type || ""}
                        onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, frame_type: e.target.value || null } : null)}
                        placeholder="Optional"
                        className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">Fire Rating</label>
                      <input
                        type="text"
                        value={editingOpeningData?.fire_rating || ""}
                        onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, fire_rating: e.target.value || null } : null)}
                        placeholder="Optional"
                        className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">Hand</label>
                      <input
                        type="text"
                        value={editingOpeningData?.hand || ""}
                        onChange={(e) => setEditingOpeningData(prev => prev ? { ...prev, hand: e.target.value || null } : null)}
                        placeholder="Optional"
                        className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={saveEditOpening}
                      disabled={savingOpening}
                      className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 text-white rounded transition-colors"
                    >
                      {savingOpening ? "Saving..." : "Save"}
                    </button>
                    <button
                      onClick={cancelEditOpening}
                      disabled={savingOpening}
                      className="flex-1 px-4 py-2 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 text-white rounded transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* QR Code */}
            <div className="bg-slate-900 p-4 rounded border border-slate-800 ml-4">
              <QRCodeSVG
                value={qrUrl}
                size={120}
                level="H"
                includeMargin={true}
              />
              <p className="text-xs text-slate-400 text-center mt-2 max-w-24">
                Scan to open
              </p>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="mb-6">
            <div className="flex justify-between items-center mb-2">
              <span className="text-slate-300 font-medium">Progress</span>
              <span className="text-slate-400 text-sm">
                {checkedItems} / {totalItems}
              </span>
            </div>
            <ProgressBar
              value={progress}
              size="lg"
              showLabel={true}
            />
          </div>
        </div>

        {/* Tab Bar */}
        <div className="flex gap-2 mb-6 overflow-x-auto">
          {([
            { key: 'hardware', label: 'Hardware' },
            { key: 'floor_plan', label: 'Floor Plan' },
            { key: 'door_drawing', label: 'Door Drawing' },
            { key: 'frame_drawing', label: 'Frame Drawing' },
          ] as const).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 text-sm font-medium whitespace-nowrap rounded-lg border transition-colors ${
                activeTab === tab.key
                  ? 'bg-blue-600/20 border-blue-500 text-blue-400'
                  : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-white hover:border-slate-500'
              }`}
            >
              {tab.label}
              {tab.key !== 'hardware' && getAttachmentsByCategory(tab.key).length > 0 && (
                <span className="ml-2 text-xs bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded">
                  {getAttachmentsByCategory(tab.key).length}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Hardware Tab */}
        {activeTab === 'hardware' && (<>
        <div className="bg-slate-900 rounded-lg border border-slate-800 p-6 mb-8">
          <h2 className="text-xl font-bold text-white mb-4">Hardware Items</h2>

          {opening.hardware_items.length === 0 ? (
            <p className="text-slate-400">No hardware items yet</p>
          ) : (
            <div className="space-y-4">
              {opening.hardware_items.map((item) => (
                <div
                  key={item.id}
                  className="p-4 bg-slate-800 rounded border border-slate-700 hover:border-slate-600 transition-colors"
                >
                  {editingItemId === item.id && editingItem ? (
                    // Edit mode
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-sm text-slate-400 mb-1">Name</label>
                          <input
                            type="text"
                            value={editingItem.name}
                            onChange={(e) => setEditingItem({ ...editingItem, name: e.target.value })}
                            className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-sm text-slate-400 mb-1">Qty</label>
                          <input
                            type="number"
                            value={editingItem.qty}
                            onChange={(e) => setEditingItem({ ...editingItem, qty: parseInt(e.target.value) || 0 })}
                            className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className="block text-sm text-slate-400 mb-1">Manufacturer</label>
                          <input
                            type="text"
                            value={editingItem.manufacturer || ""}
                            onChange={(e) => setEditingItem({ ...editingItem, manufacturer: e.target.value || null })}
                            placeholder="Optional"
                            className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-sm text-slate-400 mb-1">Model</label>
                          <input
                            type="text"
                            value={editingItem.model || ""}
                            onChange={(e) => setEditingItem({ ...editingItem, model: e.target.value || null })}
                            placeholder="Optional"
                            className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-sm text-slate-400 mb-1">Finish</label>
                          <input
                            type="text"
                            value={editingItem.finish || ""}
                            onChange={(e) => setEditingItem({ ...editingItem, finish: e.target.value || null })}
                            placeholder="Optional"
                            className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-sm text-slate-400 mb-1">Options</label>
                          <input
                            type="text"
                            value={editingItem.options || ""}
                            onChange={(e) => setEditingItem({ ...editingItem, options: e.target.value || null })}
                            placeholder="Optional"
                            className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-sm text-slate-400 mb-1">Install Type</label>
                          <select
                            value={editingItem.install_type || ""}
                            onChange={(e) => setEditingItem({ ...editingItem, install_type: (e.target.value as 'bench' | 'field') || null })}
                            className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            <option value="">Not set</option>
                            <option value="bench">Bench</option>
                            <option value="field">Field</option>
                          </select>
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <button
                          onClick={saveEditItem}
                          disabled={savingItem}
                          className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 text-white text-sm rounded transition-colors"
                        >
                          {savingItem ? "Saving..." : "Save"}
                        </button>
                        <button
                          onClick={cancelEditItem}
                          disabled={savingItem}
                          className="flex-1 px-3 py-2 bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 text-white text-sm rounded transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    // View mode
                    <>
                      <div className="flex items-start gap-4">
                        <div className="flex-1">
                          <div className="flex justify-between items-start mb-1">
                            <div className="flex items-center gap-2">
                              <h3 className="font-medium text-white">{item.name}</h3>
                              {/* Install type badge */}
                              {item.install_type && (
                                <span className={`text-xs px-2 py-0.5 rounded ${
                                  item.install_type === 'bench'
                                    ? 'bg-purple-900/40 text-purple-300'
                                    : 'bg-green-900/40 text-green-300'
                                }`}>
                                  {item.install_type === 'bench' ? 'Bench' : 'Field'}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-3">
                              {item.qty > 0 && (
                                <span className="text-sm text-slate-400">
                                  Qty: {item.qty}
                                </span>
                              )}
                              <button
                                onClick={() => startEditItem(item)}
                                className="text-slate-500 hover:text-slate-300 p-1"
                                title="Edit item"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                              </button>
                            </div>
                          </div>

                          {formatSpec(item) && (
                            <p className="text-sm text-slate-400 mb-2">
                              {formatSpec(item)}
                            </p>
                          )}

                          {item.options && (
                            <p className="text-xs text-slate-500 mb-2">
                              {item.options}
                            </p>
                          )}

                          {/* Install type selector (if not set) */}
                          {!item.install_type && (
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-xs text-slate-500">Classify:</span>
                              <button
                                onClick={() => handleInstallTypeClick(item.id, 'bench')}
                                className="text-xs px-2 py-1 bg-slate-700 hover:bg-purple-900/40 text-slate-400 hover:text-purple-300 rounded transition-colors"
                              >
                                Bench
                              </button>
                              <button
                                onClick={() => handleInstallTypeClick(item.id, 'field')}
                                className="text-xs px-2 py-1 bg-slate-700 hover:bg-green-900/40 text-slate-400 hover:text-green-300 rounded transition-colors"
                              >
                                Field
                              </button>
                            </div>
                          )}

                          {/* Workflow steps */}
                          <div className="flex items-center gap-1 mt-2">
                            {getWorkflowSteps(item).map((step, idx) => {
                              const isActive = getStepValue(item, step);
                              const label = getStepLabel(item, step);
                              return (
                                <div key={step} className="flex items-center">
                                  {idx > 0 && (
                                    <div className={`w-4 h-0.5 ${isActive ? 'bg-blue-500' : 'bg-slate-600'}`} />
                                  )}
                                  <button
                                    onClick={() => handleStepToggle(item.id, step, isActive)}
                                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                                      isActive
                                        ? 'bg-blue-600/30 text-blue-300 border border-blue-500/50'
                                        : 'bg-slate-700/50 text-slate-400 border border-slate-600 hover:bg-slate-700 hover:text-slate-300'
                                    }`}
                                  >
                                    {isActive ? (
                                      <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                      </svg>
                                    ) : (
                                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <circle cx="12" cy="12" r="9" strokeWidth={2} />
                                      </svg>
                                    )}
                                    {label}
                                  </button>
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
                                className="ml-2 text-xs text-slate-500 hover:text-slate-400 underline"
                                title={`Switch to ${item.install_type === 'bench' ? 'field' : 'bench'}`}
                              >
                                Switch to {item.install_type === 'bench' ? 'Field' : 'Bench'}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Notes Section */}
        <div className="bg-slate-900 rounded-lg border border-slate-800 p-6 mb-8">
          <h2 className="text-xl font-bold text-white mb-4">Notes</h2>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Add notes about this opening..."
            className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-24 resize-none"
          />
          <button
            onClick={handleSaveNotes}
            disabled={savingNotes}
            className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 text-white rounded transition-colors"
          >
            {savingNotes ? "Saving..." : "Save Notes"}
          </button>
        </div>

        {/* General Attachments */}
        <div className="bg-slate-900 rounded-lg border border-slate-800 p-6">
          <h2 className="text-xl font-bold text-white mb-4">Attachments</h2>

          {getAttachmentsByCategory('general').length > 0 && (
            <div className="mb-6 space-y-2">
              {getAttachmentsByCategory('general').map((attachment: any) => (
                <a
                  key={attachment.id}
                  href={attachment.file_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-blue-400 hover:text-blue-300 text-sm break-all"
                >
                  {attachment.file_name}
                </a>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <label className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded cursor-pointer transition-colors text-center">
              <input
                type="file"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileUpload(file, 'general');
                }}
                disabled={attachmentLoading}
                className="hidden"
                accept="image/*,application/pdf"
              />
              {attachmentLoading ? "Uploading..." : "Upload File"}
            </label>
          </div>
        </div>
        </>)}

        {/* Drawing Tabs (Floor Plan, Door Drawing, Frame Drawing) */}
        {activeTab !== 'hardware' && (
          <DrawingTab
            category={activeTab}
            label={activeTab === 'floor_plan' ? 'Floor Plan' : activeTab === 'door_drawing' ? 'Door Drawing' : 'Frame Drawing'}
            attachments={getAttachmentsByCategory(activeTab)}
            onUpload={(file: File) => handleFileUpload(file, activeTab)}
            uploading={attachmentLoading}
          />
        )}
      </main>

      {/* Bulk Classification Confirmation Modal */}
      {classifyConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-lg w-full max-w-md p-6">
            <h2 className="text-lg font-bold text-white mb-3">
              Classify &quot;{classifyConfirm.itemName}&quot; as{' '}
              <span className={classifyConfirm.installType === 'bench' ? 'text-purple-300' : 'text-green-300'}>
                {classifyConfirm.installType === 'bench' ? 'Bench' : 'Field'}
              </span>?
            </h2>
            <p className="text-slate-400 text-sm mb-4">
              There {classifyConfirm.totalAcrossProject === 1 ? 'is' : 'are'}{' '}
              <span className="text-white font-medium">{classifyConfirm.totalAcrossProject}</span>{' '}
              &quot;{classifyConfirm.itemName}&quot; item{classifyConfirm.totalAcrossProject !== 1 ? 's' : ''}{' '}
              across all openings in this project.
              Apply{' '}
              <span className={classifyConfirm.installType === 'bench' ? 'text-purple-300' : 'text-green-300'}>
                {classifyConfirm.installType === 'bench' ? 'Bench' : 'Field'}
              </span>{' '}
              to all of them?
            </p>
            <p className="text-slate-500 text-xs mb-4">
              You can always change individual items later on each opening.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => applyInstallType(
                  classifyConfirm.itemName,
                  classifyConfirm.installType,
                  true
                )}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors text-sm"
              >
                Yes, apply to all ({classifyConfirm.totalAcrossProject})
              </button>
              <button
                onClick={() => applyInstallType(
                  classifyConfirm.itemName,
                  classifyConfirm.installType,
                  false,
                  [classifyConfirm.itemId]
                )}
                className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded transition-colors text-sm"
              >
                Just this one
              </button>
              <button
                onClick={() => setClassifyConfirm(null)}
                className="px-4 py-2 text-slate-500 hover:text-slate-400 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
