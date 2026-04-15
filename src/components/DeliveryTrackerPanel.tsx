"use client";

import { useState, useEffect } from "react";
import { useToast } from "@/components/ToastProvider";
import type { DeliveryItem } from "@/lib/types/database";

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

const ITEM_STATUS_COLORS: Record<string, string> = {
  expected: "bg-surface-hover text-secondary border-th-border",
  received: "bg-success-dim text-success border-success",
  partial: "bg-warning-dim text-warning border-warning",
  damaged: "bg-danger-dim text-danger border-danger",
  backordered: "bg-caution-dim text-caution border-caution",
  substituted: "bg-accent-dim text-accent border-accent",
};

type DeliveryItemWithHardware = DeliveryItem & {
  hardware_item?: { id: string; name: string } | null;
  delivery?: { id: string; po_number: string | null; project_id: string } | null;
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
  const [deliveryItems, setDeliveryItems] = useState<DeliveryItemWithHardware[]>([]);
  const [expandedDelivery, setExpandedDelivery] = useState<string | null>(null);

  useEffect(() => {
    fetchDeliveries();
    fetchDeliveryItems();
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

  const fetchDeliveryItems = async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/delivery-items`);
      if (res.ok) {
        const data = await res.json();
        setDeliveryItems(data);
      }
    } catch {
      // delivery_items table may not exist yet — silently ignore
    }
  };

  const itemsByDelivery = deliveryItems.reduce<Record<string, DeliveryItemWithHardware[]>>(
    (acc, item) => {
      (acc[item.delivery_id] ??= []).push(item);
      return acc;
    },
    {}
  );

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
              {deliveries.map((d) => {
                const items = itemsByDelivery[d.id] || [];
                const isExpanded = expandedDelivery === d.id;
                return (
                  <tr key={d.id} className="border-b border-th-border/50">
                    <td colSpan={5} className="p-0">
                      <div
                        className="flex items-center py-2 cursor-pointer hover:bg-surface-hover/50 transition-colors"
                        onClick={() =>
                          setExpandedDelivery(isExpanded ? null : d.id)
                        }
                      >
                        <span className="pr-4 text-primary font-medium pl-2">
                          {d.po_number || "-"}
                        </span>
                        <span className="pr-4 text-secondary flex-1">
                          {d.vendor || "-"}
                        </span>
                        <span className="pr-4 text-secondary max-w-32 truncate">
                          {d.items_summary || d.description || "-"}
                        </span>
                        <span className="pr-4 text-secondary">
                          {d.expected_date
                            ? new Date(d.expected_date).toLocaleDateString()
                            : "-"}
                        </span>
                        <span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-xs border ${
                              STATUS_COLORS[d.status] || STATUS_COLORS.pending
                            }`}
                          >
                            {d.status.replace("_", " ")}
                          </span>
                        </span>
                        {items.length > 0 && (
                          <span className="ml-2 text-[10px] text-tertiary tabular-nums">
                            {items.length} item{items.length !== 1 ? "s" : ""}
                          </span>
                        )}
                        <svg
                          className={`w-3.5 h-3.5 ml-2 mr-2 text-tertiary transition-transform ${
                            isExpanded ? "rotate-90" : ""
                          }`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 5l7 7-7 7"
                          />
                        </svg>
                      </div>

                      {isExpanded && items.length > 0 && (
                        <div className="px-4 pb-3 pt-1 bg-surface-hover/30 rounded-b">
                          <p className="text-[11px] text-tertiary uppercase tracking-wider mb-2">
                            Delivery Items
                          </p>
                          <div className="space-y-1.5">
                            {items.map((item) => (
                              <div
                                key={item.id}
                                className="flex items-center gap-2 text-[12px]"
                              >
                                <span
                                  className={`px-1.5 py-0.5 rounded text-[10px] border font-medium ${
                                    ITEM_STATUS_COLORS[item.status] ||
                                    ITEM_STATUS_COLORS.expected
                                  }`}
                                >
                                  {item.status}
                                </span>
                                <span className="text-primary">
                                  {item.hardware_item?.name || "Unknown item"}
                                </span>
                                <span className="text-tertiary tabular-nums">
                                  {item.qty_received ?? 0}/{item.qty_expected} received
                                </span>
                                {item.eta && (
                                  <span className="text-tertiary">
                                    ETA {new Date(item.eta).toLocaleDateString()}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {isExpanded && items.length === 0 && (
                        <div className="px-4 pb-3 pt-1">
                          <p className="text-[11px] text-tertiary">
                            No line items linked to this delivery yet
                          </p>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
