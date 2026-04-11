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
  pending: "bg-yellow-900/30 text-yellow-300 border-yellow-800",
  in_transit: "bg-blue-900/30 text-blue-300 border-blue-800",
  delivered: "bg-green-900/30 text-green-300 border-green-800",
  partial: "bg-orange-900/30 text-orange-300 border-orange-800",
  delayed: "bg-red-900/30 text-red-300 border-red-800",
  cancelled: "bg-slate-800/30 text-slate-400 border-slate-700",
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
      <div className="bg-slate-900 rounded-lg border border-slate-800 p-6">
        <h2 className="text-xl font-bold text-white mb-4">Deliveries</h2>
        <p className="text-slate-400 text-sm">Loading...</p>
      </div>
    );
  }

  return (
    <div className="bg-slate-900 rounded-lg border border-slate-800 p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-white">Deliveries</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm transition-colors"
        >
          {showForm ? "Cancel" : "+ Add Delivery"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleAdd} className="mb-6 p-4 bg-slate-800/50 rounded-lg space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              placeholder="PO Number"
              value={formData.po_number}
              onChange={(e) => setFormData({ ...formData, po_number: e.target.value })}
              className="px-3 py-2 bg-slate-800 border border-slate-700 rounded text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="text"
              placeholder="Vendor"
              value={formData.vendor}
              onChange={(e) => setFormData({ ...formData, vendor: e.target.value })}
              className="px-3 py-2 bg-slate-800 border border-slate-700 rounded text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <input
            type="text"
            placeholder="Description"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <div className="grid grid-cols-3 gap-3">
            <input
              type="text"
              placeholder="Items"
              value={formData.items_summary}
              onChange={(e) => setFormData({ ...formData, items_summary: e.target.value })}
              className="px-3 py-2 bg-slate-800 border border-slate-700 rounded text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="number"
              placeholder="Qty"
              value={formData.quantity}
              onChange={(e) => setFormData({ ...formData, quantity: e.target.value })}
              className="px-3 py-2 bg-slate-800 border border-slate-700 rounded text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="date"
              placeholder="Expected Date"
              value={formData.expected_date}
              onChange={(e) => setFormData({ ...formData, expected_date: e.target.value })}
              className="px-3 py-2 bg-slate-800 border border-slate-700 rounded text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 text-white rounded text-sm transition-colors"
          >
            {submitting ? "Adding..." : "Add Delivery"}
          </button>
        </form>
      )}

      {deliveries.length === 0 ? (
        <p className="text-slate-400 text-sm">No deliveries tracked yet</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-800">
                <th className="pb-2 pr-4">PO#</th>
                <th className="pb-2 pr-4">Vendor</th>
                <th className="pb-2 pr-4">Items</th>
                <th className="pb-2 pr-4">Expected</th>
                <th className="pb-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id} className="border-b border-slate-800/50">
                  <td className="py-2 pr-4 text-white font-medium">
                    {d.po_number || "-"}
                  </td>
                  <td className="py-2 pr-4 text-slate-300">{d.vendor || "-"}</td>
                  <td className="py-2 pr-4 text-slate-300 max-w-32 truncate">
                    {d.items_summary || d.description || "-"}
                  </td>
                  <td className="py-2 pr-4 text-slate-300">
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
