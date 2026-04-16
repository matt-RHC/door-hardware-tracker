"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter, useParams } from "next/navigation";
import OfflineIndicator from "@/components/OfflineIndicator";
import { QA_FINDING_LABELS, type QAFindingTag } from "@/lib/types/database";

const ALL_TAGS: QAFindingTag[] = [
  "spec_match",
  "operation",
  "finish",
  "fire_rating",
  "ada",
  "life_safety",
];

interface PunchListItem {
  id: string;
  opening_id: string;
  item_id: string;
  leaf_index: number;
  door_number: string;
  location: string | null;
  item_name: string;
  category: string | null;
  manufacturer: string | null;
  model: string | null;
  finish: string | null;
  qa_findings: string[];
  qa_notes: string | null;
  qa_qc: boolean;
}

export default function PunchListPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const router = useRouter();

  const [items, setItems] = useState<PunchListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterTag, setFilterTag] = useState<string | null>(null);

  useEffect(() => {
    fetchPunchList();
  }, [projectId]);

  const fetchPunchList = async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/punch-list`);
      if (!res.ok) throw new Error("Failed to fetch punch list");
      const data = await res.json();
      setItems(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const filteredItems = useMemo(() => {
    if (!filterTag) return items;
    return items.filter((item) => item.qa_findings.includes(filterTag));
  }, [items, filterTag]);

  // Count findings by tag for the filter pills
  const tagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const tag of ALL_TAGS) {
      counts[tag] = items.filter((item) => item.qa_findings.includes(tag)).length;
    }
    return counts;
  }, [items]);

  return (
    <div className="min-h-screen" style={{ background: "var(--background)" }}>
      <OfflineIndicator />

      <main className="max-w-7xl mx-auto px-4 py-6 sm:py-8">
        {/* Header */}
        <div className="mb-6">
          <button
            onClick={() => router.push(`/project/${projectId}`)}
            className="text-accent hover:text-accent/80 mb-3 text-[13px] flex items-center gap-1 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Project
          </button>
          <div className="flex items-center justify-between">
            <h1
              className="text-xl sm:text-2xl font-bold text-primary pb-3 border-b border-th-border flex-1"
              style={{ fontFamily: "var(--font-display)", letterSpacing: "0.02em" }}
            >
              PUNCH LIST
            </h1>
            <span className="text-[13px] text-tertiary tabular-nums ml-4">
              {filteredItems.length} item{filteredItems.length !== 1 ? "s" : ""}
            </span>
          </div>
        </div>

        {/* Filter by QA dimension */}
        <div className="flex flex-wrap gap-2 mb-5">
          <button
            onClick={() => setFilterTag(null)}
            className={`text-[11px] font-semibold px-3 py-1.5 rounded-full transition-colors uppercase tracking-wide ${
              filterTag === null
                ? "bg-accent-dim border border-accent text-accent"
                : "bg-surface border border-th-border text-secondary hover:bg-surface-hover"
            }`}
          >
            All ({items.length})
          </button>
          {ALL_TAGS.map((tag) => (
            <button
              key={tag}
              onClick={() => setFilterTag(filterTag === tag ? null : tag)}
              className={`text-[11px] font-semibold px-3 py-1.5 rounded-full transition-colors uppercase tracking-wide ${
                filterTag === tag
                  ? "bg-red-dim border border-red text-red"
                  : "bg-surface border border-th-border text-secondary hover:bg-surface-hover"
              }`}
              style={filterTag === tag ? {
                background: "var(--red-dim)",
                borderColor: "var(--red)",
                color: "var(--red)",
              } : {}}
            >
              {QA_FINDING_LABELS[tag]} ({tagCounts[tag]})
            </button>
          ))}
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-20 gap-3">
            <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-[13px] text-tertiary">Loading punch list...</span>
          </div>
        ) : error ? (
          <div className="p-4 bg-danger-dim border border-danger rounded-md text-danger text-[14px]">
            {error}
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-[15px] text-secondary mb-1">
              {items.length === 0
                ? "No QA findings"
                : "No items match this filter"}
            </p>
            {items.length === 0 && (
              <p className="text-[13px] text-tertiary">
                QA findings will appear here when items are flagged during QA inspection
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto border border-th-border rounded-md">
            <table className="w-full text-left text-[13px] min-w-[640px]">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-th-border bg-surface text-[11px] text-tertiary uppercase tracking-wider">
                  <th className="px-3 py-2 font-medium">Door #</th>
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Finding Tags</th>
                  <th className="px-3 py-2 font-medium hidden md:table-cell">Notes</th>
                  <th className="px-3 py-2 font-medium text-center">QA Pass</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item, idx) => (
                  <tr
                    key={item.id}
                    onClick={() =>
                      router.push(`/project/${projectId}/door/${item.opening_id}`)
                    }
                    className={`border-b border-th-border transition-colors hover:bg-surface-hover cursor-pointer ${
                      idx % 2 === 1 ? "bg-surface/50" : ""
                    }`}
                  >
                    <td className="px-3 py-2.5">
                      <span className="font-semibold text-primary">
                        {item.door_number}
                      </span>
                      {item.location && (
                        <span className="block text-[11px] text-tertiary mt-0.5">
                          {item.location}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="font-medium text-primary">
                        {item.item_name}
                      </span>
                      {(item.manufacturer || item.model) && (
                        <span className="block text-[11px] text-tertiary mt-0.5">
                          {[item.manufacturer, item.model, item.finish]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {item.qa_findings.map((tag) => (
                          <span
                            key={tag}
                            className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide"
                            style={{
                              background: "var(--red-dim)",
                              color: "var(--red)",
                              border: "1px solid var(--red)",
                            }}
                          >
                            {QA_FINDING_LABELS[tag as QAFindingTag] ?? tag}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 hidden md:table-cell">
                      {item.qa_notes ? (
                        <span className="text-secondary text-[12px] line-clamp-2">
                          {item.qa_notes}
                        </span>
                      ) : (
                        <span className="text-tertiary">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <span
                        className="inline-flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold"
                        style={{
                          background: item.qa_qc
                            ? "var(--green-dim)"
                            : "var(--surface)",
                          color: item.qa_qc
                            ? "var(--green)"
                            : "var(--text-tertiary)",
                          border: item.qa_qc
                            ? "1px solid var(--green)"
                            : "1px solid var(--border)",
                        }}
                      >
                        {item.qa_qc ? "P" : "-"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Export placeholder */}
        {items.length > 0 && (
          <div className="mt-4 flex justify-end">
            <button
              className="glow-btn glow-btn--ghost text-[13px] rounded opacity-50 cursor-not-allowed"
              style={{ padding: "0.5rem 0.875rem" }}
              disabled
              title="CSV export coming soon"
            >
              Export CSV
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
