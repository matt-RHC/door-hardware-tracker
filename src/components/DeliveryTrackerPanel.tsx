"use client";

import { useState, useEffect } from "react";
import { useToast } from "@/components/ToastProvider";

interface Delivery {
  id: string;
  po_number: string | null;
  vendor: string | null;
  description: string | null;
  items_summary: string | null;
  quantity: number | null;
  expected_date: string | null;
  actual_date: string | null;
  status: string;
  tracking_number: string | null;
  notes: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-caution-dim text-caution border-caution",
  in_transit: "bg-accent-dim text-accent border-accent",
  delivered: "bg-success-dim text-success border-success",
  partial: "bg-warning-dim text-warning border-warning",
  delayed: "bg-danger-dim text-danger border-danger",
  cancelled: "bg-surface-hover text-secondary border-th-border",
};

export default function DeliveryTrackerPanel({
  projectId,
}: {
  projectId: string;
}) {
  const { showToast } = useToast();
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    po_number: "",
    vendor: "",
    description: "",
    items_summary: "",
    quantity: "",
    expected_date: "",
    tracking_number: "",
    notes: "",
  });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchDeliveries();
  }, [projectId]);

  const fetchDeliveries = async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/deliveries`);
      if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
      const data = await res.json();
      setDeliveries(data);
    } catch (err) {
      console.error("Failed to fetch deliveries:", err);
      showToast("error", "Failed to load deliveries. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/deliveries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...formData,
          quantity: formData.quantity ? parseInt(formData.quantity) : null,
        }),
      });
      if (!res.ok) throw new Error(`Add failed: HTTP ${res.status}`);
      setShowForm(false);
      setFormData({
        po_number: "",
        vendor: "",
        description: "",
        items_summary: "",
        quantity: "",
        expected_date: "",
        tracking_number: "",
        notes: "",
      });
      fetchDeliveries();
    } catch (err) {
      console.error("Failed to add delivery:", err);
      showToast("error", "Failed to add delivery. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-surface rounded-lg border border-th-border p-6">
        <h2 className="text-xl font-bold text-primary mb-4">Deliveries</h2>
        <p className="text-secondary text-sm">Loading...</p>
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-lg border border-th-border p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-primary">Deliveries</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-3 py-1.5 bg-accent hover:bg-accent/80 text-white rounded text-sm transition-colors"
        >
          {showForm ? "Cancel" : "+ Add Delivery"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleAdd} className="mb-6 p-4 bg-surface-hover rounded-lg space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              placeholder="PO Number"
              value={formData.po_number}
              onChange={(e) => setFormData({ ...formData, po_number: e.target.value })}
              className="px-3 py-2 bg-surface border border-th-border rounded text-primary placeholder-tertiary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <input
              type="text"
              placeholder="Vendor"
              value={formData.vendor}
              onChange={(e) => setFormData({ ...formData, vendor: e.target.value })}
              className="px-3 py-2 bg-surface border border-th-border rounded text-primary placeholder-tertiary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <input
            type="text"
            placeholder="Description"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            className="w-full px-3 py-2 bg-surface border border-th-border rounded text-primary placeholder-tertiary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <div className="grid grid-cols-3 gap-3">
            <input
              type="text"
              placeholder="Items"
              value={formData.items_summary}
              onChange={(e) => setFormData({ ...formData, items_summary: e.target.value })}
              className="px-3 py-2 bg-surface border border-th-border rounded text-primary placeholder-tertiary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <input
              type="number"
              placeholder="Qty"
              value={formData.quantity}
              onChange={(e) => setFormData({ ...formData, quantity: e.target.value })}
              className="px-3 py-2 bg-surface border border-th-border rounded text-primary placeholder-tertiary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <input
              type="date"
              placeholder="Expected Date"
              value={formData.expected_date}
              onChange={(e) => setFormData({ ...formData, expected_date: e.target.value })}
              className="px-3 py-2 bg-surface border border-th-border rounded text-primary placeholder-tertiary text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 bg-accent hover:bg-accent/80 disabled:bg-surface-hover text-white rounded text-sm transition-colors"
          >
            {submitting ? "Adding..." : "Add Delivery"}
          </button>
        </form>
      )}

      {deliveries.length === 0 ? (
        <p className="text-secondary text-sm">No deliveries tracked yet</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-secondary border-b border-th-border">
                <th className="pb-2 pr-4">PO#</th>
                <th className="pb-2 pr-4">Vendor</th>
                <th className="pb-2 pr-4">Items</th>
                <th className="pb-2 pr-4">Expected</th>
                <th className="pb-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id} className="border-b border-th-border/50">
                  <td className="py-2 pr-4 text-primary font-medium">
                    {d.po_number || "-"}
                  </td>
                  <td className="py-2 pr-4 text-secondary">{d.vendor || "-"}</td>
                  <td className="py-2 pr-4 text-secondary max-w-32 truncate">
                    {d.items_summary || d.description || "-"}
                  </td>
                  <td className="py-2 pr-4 text-secondary">
                    {d.expected_date
                      ? new Date(d.expected_date).toLocaleDateString()
                      : "-"}
                  </td>
                  <td className="py-2">
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs border ${
                        STATUS_COLORS[d.status] || STATUS_COLORS.pending
                      }`}
                    >
                      {d.status.replace("_", " ")}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
