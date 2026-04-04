"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter, useParams } from "next/navigation";
import OfflineIndicator from "@/components/OfflineIndicator";
import ProgressBar from "@/components/ProgressBar";
import PDFUploadModal from "@/components/PDFUploadModal";

interface OpeningWithProgress {
  id: string;
  project_id: string;
  door_number: string;
  hw_set: string | null;
  hw_heading: string | null;
  location: string | null;
  door_type: string | null;
  frame_type: string | null;
  fire_rating: string | null;
  hand: string | null;
  created_at: string;
  total_items: number;
  checked_items: number;
}

interface Filters {
  search: string;
  status: "all" | "complete" | "incomplete";
  hwSet: string;
  doorType: string;
  fireRating: string;
  hand: string;
}

const defaultFilters: Filters = {
  search: "",
  status: "all",
  hwSet: "",
  doorType: "",
  fireRating: "",
  hand: "",
};

export default function ProjectDetailPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const router = useRouter();

  const [openings, setOpenings] = useState<OpeningWithProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [showFilters, setShowFilters] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ success: boolean; message: string; permalink?: string } | null>(null);

  useEffect(() => {
    fetchProjectData();
  }, [projectId]);

  const fetchProjectData = async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/openings`);
      if (!response.ok) throw new Error("Failed to fetch openings");
      const data = await response.json();
      setOpenings(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const filterOptions = useMemo(() => {
    const hwSets = new Set<string>();
    const doorTypes = new Set<string>();
    const fireRatings = new Set<string>();
    const hands = new Set<string>();
    for (const o of openings) {
      if (o.hw_set) hwSets.add(o.hw_set);
      if (o.door_type) doorTypes.add(o.door_type);
      if (o.fire_rating) fireRatings.add(o.fire_rating);
      if (o.hand) hands.add(o.hand);
    }
    return {
      hwSets: Array.from(hwSets).sort(),
      doorTypes: Array.from(doorTypes).sort(),
      fireRatings: Array.from(fireRatings).sort(),
      hands: Array.from(hands).sort(),
    };
  }, [openings]);

  const filteredOpenings = useMemo(() => {
    let filtered = openings;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      filtered = filtered.filter(
        (o) =>
          o.door_number.toLowerCase().includes(q) ||
          o.location?.toLowerCase().includes(q) ||
          o.hw_set?.toLowerCase().includes(q)
      );
    }
    if (filters.status !== "all") {
      filtered = filtered.filter((o) => {
        const pct = o.total_items > 0 ? (o.checked_items / o.total_items) * 100 : 0;
        return filters.status === "complete" ? pct === 100 : pct < 100;
      });
    }
    if (filters.hwSet) filtered = filtered.filter((o) => o.hw_set === filters.hwSet);
    if (filters.doorType) filtered = filtered.filter((o) => o.door_type === filters.doorType);
    if (filters.fireRating) filtered = filtered.filter((o) => o.fire_rating === filters.fireRating);
    if (filters.hand) filtered = filtered.filter((o) => o.hand === filters.hand);
    return filtered;
  }, [openings, filters]);

  const activeFilterCount = [
    filters.hwSet, filters.doorType, filters.fireRating, filters.hand,
  ].filter(Boolean).length + (filters.status !== "all" ? 1 : 0);

  const clearFilters = () => setFilters({ ...defaultFilters, search: filters.search });
  const totalItems = openings.reduce((sum, o) => sum + o.total_items, 0);
  const totalChecked = openings.reduce((sum, o) => sum + o.checked_items, 0);
  const overallProgress = totalItems > 0 ? (totalChecked / totalItems) * 100 : 0;
  const updateFilter = (key: keyof Filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const syncToSmartsheet = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/sync-smartsheet`, {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok) {
        setSyncResult({ success: false, message: data.error || "Sync failed" });
      } else {
        const verb = data.created ? "Created" : "Updated";
        setSyncResult({
          success: true,
          message: `${verb} Smartsheet with ${data.rowsSynced} openings`,
          permalink: data.permalink,
        });
      }
    } catch (err) {
      setSyncResult({
        success: false,
        message: err instanceof Error ? err.message : "Sync failed",
      });
    } finally {
      setSyncing(false);
    }
  };

  // Card border color based on progress
  const getCardVariant = (pct: number): string => {
    if (pct === 100) return "glow-card--green";
    if (pct >= 50) return "glow-card--blue";
    if (pct > 0) return "glow-card--orange";
    return "";
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--background)" }}>
      <OfflineIndicator />

      <main className="max-w-7xl mx-auto px-4 py-6 sm:py-8">
        {/* ── Header ── */}
        <div className="mb-6">
          <button
            onClick={() => router.push("/dashboard")}
            className="text-[#5ac8fa] hover:text-[#5ac8fa]/80 mb-3 text-[13px] flex items-center gap-1 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Projects
          </button>
          <h1
            className="text-2xl sm:text-3xl font-bold text-[var(--text-primary)] mb-4"
            style={{ fontFamily: "var(--font-display)", letterSpacing: "0.02em" }}
          >
            PROJECT DETAILS
          </h1>

          {/* Overall Progress */}
          <div className="panel p-4 rounded-lg">
            <div className="flex justify-between items-center mb-2">
              <span className="text-[13px] text-[var(--text-secondary)] uppercase tracking-wider">
                Overall Progress
              </span>
              <span className="text-[13px] text-[var(--text-tertiary)] tabular-nums">
                {totalChecked} / {totalItems} items
              </span>
            </div>
            <ProgressBar value={overallProgress} size="lg" showLabel={true} />
          </div>
        </div>

        {/* ── Search + Actions ── */}
        <div className="flex flex-col gap-3 mb-5">
          <input
            type="text"
            placeholder="Search door number, location, or HW set..."
            value={filters.search}
            onChange={(e) => updateFilter("search", e.target.value)}
            className="input-field"
          />

          {/* Action buttons — scrollable on mobile */}
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`shrink-0 glow-btn text-[13px] rounded-lg ${
                showFilters || activeFilterCount > 0
                  ? "bg-[rgba(90,200,250,0.1)] border-[rgba(90,200,250,0.25)] text-[#5ac8fa]"
                  : "glow-btn--ghost"
              }`}
              style={{ padding: "0.5rem 0.875rem" }}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
              Filters
              {activeFilterCount > 0 && (
                <span className="bg-[rgba(90,200,250,0.2)] text-[10px] px-1.5 py-0.5 rounded-full text-[#5ac8fa] font-semibold">
                  {activeFilterCount}
                </span>
              )}
            </button>
            <button
              onClick={() => router.push(`/project/${projectId}/qr-codes`)}
              className="shrink-0 glow-btn glow-btn--ghost text-[13px] rounded-lg"
              style={{ padding: "0.5rem 0.875rem" }}
            >
              QR Codes
            </button>
            <button
              onClick={() => {
                window.location.href = `/api/projects/${projectId}/export-csv`;
              }}
              className="shrink-0 glow-btn glow-btn--ghost text-[13px] rounded-lg"
              style={{ padding: "0.5rem 0.875rem" }}
            >
              CSV
            </button>
            <button
              onClick={syncToSmartsheet}
              disabled={syncing}
              className="shrink-0 glow-btn glow-btn--success text-[13px] rounded-lg"
              style={{ padding: "0.5rem 0.875rem" }}
            >
              {syncing ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-[#30d158] border-t-transparent rounded-full animate-spin" />
                  Syncing...
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Smartsheet
                </>
              )}
            </button>
            <button
              onClick={() => setShowUploadModal(true)}
              className="shrink-0 glow-btn glow-btn--primary text-[13px] rounded-lg"
              style={{ padding: "0.5rem 0.875rem" }}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              Upload PDF
            </button>
          </div>
        </div>

        {/* Sync Result */}
        {syncResult && (
          <div
            className={`mb-5 p-3 rounded-lg flex items-center justify-between text-[13px] border animate-fade-in-up ${
              syncResult.success
                ? "bg-[rgba(48,209,88,0.08)] border-[rgba(48,209,88,0.15)] text-[#30d158]"
                : "bg-[rgba(255,69,58,0.08)] border-[rgba(255,69,58,0.15)] text-[#ff6961]"
            }`}
          >
            <span>{syncResult.message}</span>
            <div className="flex items-center gap-3">
              {syncResult.permalink && (
                <a
                  href={syncResult.permalink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#5ac8fa] hover:opacity-80 underline transition-opacity text-[12px]"
                >
                  Open in Smartsheet
                </a>
              )}
              <button
                onClick={() => setSyncResult(null)}
                className="text-current opacity-50 hover:opacity-100 transition-opacity"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* ── Filter Panel ── */}
        {showFilters && (
          <div className="panel p-4 rounded-lg mb-5 animate-fade-in-up">
            <div className="flex justify-between items-center mb-3">
              <span className="text-[12px] text-[var(--text-secondary)] font-medium uppercase tracking-wider">
                Filter Openings
              </span>
              {activeFilterCount > 0 && (
                <button
                  onClick={clearFilters}
                  className="text-[12px] text-[#5ac8fa] hover:opacity-80 transition-opacity"
                >
                  Clear all
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5">
              {[
                { label: "Status", key: "status", options: [["all", "All"], ["complete", "Complete"], ["incomplete", "Incomplete"]] },
                { label: "HW Set", key: "hwSet", options: [["", "All Sets"], ...filterOptions.hwSets.map(s => [s, s])] },
                { label: "Door Type", key: "doorType", options: [["", "All Types"], ...filterOptions.doorTypes.map(t => [t, t])] },
                { label: "Fire Rating", key: "fireRating", options: [["", "All Ratings"], ...filterOptions.fireRatings.map(r => [r, r])] },
                { label: "Hand", key: "hand", options: [["", "All"], ...filterOptions.hands.map(h => [h, h])] },
              ].map((f) => (
                <div key={f.key}>
                  <label className="block text-[11px] text-[var(--text-tertiary)] mb-1.5 uppercase tracking-wider">
                    {f.label}
                  </label>
                  <select
                    value={filters[f.key as keyof Filters]}
                    onChange={(e) => updateFilter(f.key as keyof Filters, e.target.value)}
                    className="input-field text-[13px] py-2"
                  >
                    {f.options.map(([val, label]) => (
                      <option key={val} value={val}>{label}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-[var(--text-tertiary)]">
              Showing {filteredOpenings.length} of {openings.length} openings
            </p>
          </div>
        )}

        {/* ── Openings Grid ── */}
        {loading ? (
          <div className="flex items-center justify-center py-20 gap-3">
            <div className="w-5 h-5 border-2 border-[#5ac8fa] border-t-transparent rounded-full animate-spin" />
            <span className="text-[13px] text-[var(--text-tertiary)]">Loading openings...</span>
          </div>
        ) : error ? (
          <div className="p-4 bg-[rgba(255,69,58,0.08)] border border-[rgba(255,69,58,0.15)] rounded-lg text-[#ff453a] text-[14px]">
            {error}
          </div>
        ) : filteredOpenings.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-[15px] text-[var(--text-secondary)] mb-1">
              {openings.length === 0 ? "No openings found" : "No openings match your filters"}
            </p>
            {openings.length === 0 && (
              <p className="text-[13px] text-[var(--text-tertiary)]">Upload a PDF submittal to get started</p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 stagger-children">
            {filteredOpenings.map((opening) => {
              const progressPercent =
                opening.total_items > 0
                  ? (opening.checked_items / opening.total_items) * 100
                  : 0;
              return (
                <div
                  key={opening.id}
                  onClick={() =>
                    router.push(`/project/${projectId}/door/${opening.id}`)
                  }
                  className={`glow-card ${getCardVariant(progressPercent)} p-4 cursor-pointer group`}
                >
                  {/* Door number + badges row */}
                  <div className="flex items-start justify-between mb-2">
                    <h2 className="text-[17px] font-bold text-[var(--text-primary)] leading-tight">
                      {opening.door_number}
                    </h2>
                    <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums shrink-0 ml-2">
                      {progressPercent.toFixed(0)}%
                    </span>
                  </div>

                  {/* Badges */}
                  <div className="flex flex-wrap gap-1.5 mb-2.5">
                    {opening.hw_set && (
                      <span className="status-badge status-badge--active" style={{ fontSize: "10px", padding: "2px 8px" }}>
                        {opening.hw_set}
                      </span>
                    )}
                    {opening.fire_rating && (
                      <span className="status-badge status-badge--error" style={{ fontSize: "10px", padding: "2px 8px" }}>
                        {opening.fire_rating}
                      </span>
                    )}
                    {opening.door_type && (
                      <span className="text-[10px] text-[var(--text-tertiary)] bg-[var(--surface)] border border-[var(--border)] px-2 py-0.5 rounded-full">
                        {opening.door_type}
                      </span>
                    )}
                    {opening.hand && (
                      <span className="text-[10px] text-[var(--text-tertiary)] bg-[var(--surface)] border border-[var(--border)] px-2 py-0.5 rounded-full">
                        {opening.hand}
                      </span>
                    )}
                  </div>

                  {opening.location && (
                    <p className="text-[12px] text-[var(--text-tertiary)] mb-3 truncate">
                      {opening.location}
                    </p>
                  )}

                  {/* Progress bar */}
                  <ProgressBar value={progressPercent} size="sm" showLabel={false} />

                  {/* Item count */}
                  <p className="text-[11px] text-[var(--text-tertiary)] mt-2 tabular-nums">
                    {opening.checked_items} / {opening.total_items} items
                  </p>

                  {/* Hover arrow */}
                  <div className="absolute bottom-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                    <svg className="w-3.5 h-3.5 text-[#5ac8fa]/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                </div>
              );
            })}
          </div>
        )}

      </main>

      {showUploadModal && (
        <PDFUploadModal
          projectId={projectId}
          onClose={() => setShowUploadModal(false)}
          onSuccess={() => fetchProjectData()}
        />
      )}
    </div>
  );
}
