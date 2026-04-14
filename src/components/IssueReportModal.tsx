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
      <div className="bg-surface border border-th-border rounded-md p-6 w-full max-w-md mx-4 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-primary">Report Issue</h2>
          <button
            onClick={onClose}
            className="text-tertiary hover:text-primary text-2xl leading-none"
          >
            &times;
          </button>
        </div>

        {(doorNumber || hardwareItemName) && (
          <div className="mb-4 p-3 bg-surface-hover rounded-lg text-sm">
            {doorNumber && (
              <p className="text-secondary">
                Door: <span className="text-primary font-medium">{doorNumber}</span>
              </p>
            )}
            {hardwareItemName && (
              <p className="text-secondary">
                Item: <span className="text-primary font-medium">{hardwareItemName}</span>
              </p>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-secondary mb-1">
              Description *
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the issue..."
              className="w-full px-3 py-2 bg-surface border border-th-border rounded text-primary placeholder-tertiary focus:outline-none focus:ring-2 focus:ring-accent min-h-24 resize-none"
              required
            />
          </div>

          <div>
            <label className="block text-sm text-secondary mb-1">
              Severity
            </label>
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as any)}
              className="w-full px-3 py-2 bg-surface border border-th-border rounded text-primary focus:outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>

          <div>
            <label className="block text-sm text-secondary mb-1">
              Assigned To
            </label>
            <input
              type="text"
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
              placeholder="Name or email..."
              className="w-full px-3 py-2 bg-surface border border-th-border rounded text-primary placeholder-tertiary focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>

          {error && (
            <p className="text-danger text-sm">{error}</p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 bg-surface hover:bg-surface-hover text-primary rounded transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !description.trim()}
              className="flex-1 px-4 py-2 bg-danger hover:bg-danger/80 disabled:bg-surface-hover text-white rounded transition-colors"
            >
              {submitting ? "Submitting..." : "Report Issue"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
