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
      // Still update locally
      setOpening((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          hardware_items: prev.hardware_items.map((item) => {
            if (item.id === itemId) {
              return {
                ...item,
                progress: {
                  ...item.progress,
                  checked: !currentChecked,
                } as any,
              };
            }
            return item;
          }),
        };
      });
    }
  };

  const handleSaveNotes = async () => {
    setSavingNotes(true);
    try {
      // TODO: Implement notes save to Supabase
      // For now just set success state
      setSavingNotes(false);
    } catch (err) {
      console.error("Error saving notes:", err);
      setSavingNotes(false);
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
  const checkedItems = opening.hardware_items.filter(
    (item) => item.progress?.checked
  ).length;
  const progress = totalItems > 0 ? (checkedItems / totalItems) * 100 : 0;
  const qrUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/project/${projectId}/door/${doorId}`;

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
            ← Back to Project
          </button>

          <div className="flex justify-between items-start mb-6">
            <div>
              <h1 className="text-3xl font-bold text-white mb-2">
                {opening.name}
              </h1>
              {opening.location && (
                <p className="text-slate-400">{opening.location}</p>
              )}
            </div>

            {/* QR Code */}
            <div className="bg-slate-900 p-4 rounded border border-slate-800">
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

        {/* Hardware Checklist */}
        <div className="bg-slate-900 rounded-lg border border-slate-800 p-6 mb-8">
          <h2 className="text-xl font-bold text-white mb-4">Hardware Items</h2>

          {opening.hardware_items.length === 0 ? (
            <p className="text-slate-400">No hardware items yet</p>
          ) : (
            <div className="space-y-4">
              {opening.hardware_items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start gap-4 p-4 bg-slate-800 rounded border border-slate-700 hover:border-slate-600 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={item.progress?.checked || false}
                    onChange={() =>
                      handleItemToggle(item.id, item.progress?.checked || false)
                    }
                    className="mt-1 w-5 h-5 rounded accent-blue-600 cursor-pointer"
                  />

                  <div className="flex-1">
                    <div className="flex justify-between items-start mb-1">
                      <h3 className="font-medium text-white">{item.name}</h3>
                      {item.quantity && (
                        <span className="text-sm text-slate-400">
                          Qty: {item.quantity}
                        </span>
                      )}
                    </div>

                    {item.specification && (
                      <p className="text-sm text-slate-400 mb-2">
                        {item.specification}
                      </p>
                    )}

                    {item.progress?.checked && item.progress?.checked_at && (
                      <p className="text-xs text-slate-500">
                        Checked by {item.progress.checked_by} on{" "}
                        {new Date(item.progress.checked_at).toLocaleDateString()}
                      </p>
                    )}
                  </div>
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

        {/* Attachments Section */}
        <div className="bg-slate-900 rounded-lg border border-slate-800 p-6">
          <h2 className="text-xl font-bold text-white mb-4">Attachments</h2>

          {opening.attachments && opening.attachments.length > 0 && (
            <div className="mb-6 space-y-2">
              {opening.attachments.map((attachment) => (
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
                  if (file) handleFileUpload(file);
                }}
                disabled={attachmentLoading}
                className="hidden"
                accept="image/*,application/pdf"
              />
              {attachmentLoading ? "Uploading..." : "Upload File"}
            </label>
          </div>
        </div>
      </main>
    </div>
  );
}
