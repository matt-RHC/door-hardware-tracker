"use client";

import { useState } from "react";

interface IssueReportModalProps {
  projectId: string;
  openingId?: string;
  doorNumber?: string;
  hardwareItemId?: string;
  hardwareItemName?: string;
  onClose: () => void;
  onCreated: () => void;
}

export default function IssueReportModal({
  projectId,
  openingId,
  doorNumber,
  hardwareItemId,
  hardwareItemName,
  onClose,
  onCreated,
}: IssueReportModalProps) {
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<"low" | "medium" | "high" | "critical">("medium");
  const [assignedTo, setAssignedTo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          opening_id: openingId,
          hardware_item_id: hardwareItemId,
          door_number: doorNumber,
          hardware_item_name: hardwareItemName,
          description: description.trim(),
          severity,
          assigned_to: assignedTo.trim() || null,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to create issue");
      }

      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create issue");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-full max-w-md mx-4 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-white">Report Issue</h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white text-2xl leading-none"
          >
            &times;
          </button>
        </div>

        {(doorNumber || hardwareItemName) && (
          <div className="mb-4 p-3 bg-slate-800/50 rounded-lg text-sm">
            {doorNumber && (
              <p className="text-slate-300">
                Door: <span className="text-white font-medium">{doorNumber}</span>
              </p>
            )}
            {hardwareItemName && (
              <p className="text-slate-300">
                Item: <span className="text-white font-medium">{hardwareItemName}</span>
              </p>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-slate-400 mb-1">
              Description *
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the issue..."
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-24 resize-none"
              required
            />
          </div>

          <div>
            <label className="block text-sm text-slate-400 mb-1">
              Severity
            </label>
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as any)}
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>

          <div>
            <label className="block text-sm text-slate-400 mb-1">
              Assigned To
            </label>
            <input
              type="text"
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
              placeholder="Name or email..."
              className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {error && (
            <p className="text-red-400 text-sm">{error}</p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !description.trim()}
              className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-500 disabled:bg-slate-700 text-white rounded transition-colors"
            >
              {submitting ? "Submitting..." : "Report Issue"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
