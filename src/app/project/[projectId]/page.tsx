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

  // Build unique filter options from data
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

  // Apply all filters
  const filteredOpenings = useMemo(() => {
    let filtered = openings;

    // Search
    if (filters.search) {
      const q = filters.search.toLowerCase();
      filtered = filtered.filter(
        (o) =>
          o.door_number.toLowerCase().includes(q) ||
          o.location?.toLowerCase().includes(q) ||
          o.hw_set?.toLowerCase().includes(q)
      );
    }

    // Status
    if (filters.status !== "all") {
      filtered = filtered.filter((o) => {
        const pct = o.total_items > 0 ? (o.checked_items / o.total_items) * 100 : 0;
        return filters.status === "complete" ? pct === 100 : pct < 100;
      });
    }

    // HW Set
    if (filters.hwSet) {
      filtered = filtered.filter((o) => o.hw_set === filters.hwSet);
    }

    // Door Type
    if (filters.doorType) {
      filtered = filtered.filter((o) => o.door_type === filters.doorType);
    }

    // Fire Rating
    if (filters.fireRating) {
      filtered = filtered.filter((o) => o.fire_rating === filters.fireRating);
    }

    // Hand
    if (filters.hand) {
      filtered = filtered.filter((o) => o.hand === filters.hand);
    }

    return filtered;
  }, [openings, filters]);

  const activeFilterCount = [
    filters.hwSet,
    filters.doorType,
    filters.fireRating,
    filters.hand,
  ].filter(Boolean).length + (filters.status !== "all" ? 1 : 0);

  const clearFilters = () => {
    setFilters({ ...defaultFilters, search: filters.search });
  };

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

  return (
    <div className="min-h-screen bg-black">
      <OfflineIndicator />

      <main className="max-w-7xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <button
            onClick={() => router.push("/dashboard")}
            className="text-[#0a84ff] hover:text-[#0a84ff] opacity-80 hover:opacity-100 mb-4 text-sm flex items-center gap-1 transition-opacity"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back to Projects
          </button>
          <h1 className="text-4xl font-bold text-[#f5f5f7] mb-4">
            Project Details
          </h1>

          {/* Overall Progress */}
          <div className="mb-6">
            <div className="flex justify-between items-center mb-2">
              <span className="text-[#f5f5f7] text-sm font-medium">
                Overall Progress
              </span>
              <span className="text-[#a1a1a6] text-sm">
                {totalChecked} / {totalItems} items
              </span>
            </div>
            <ProgressBar value={overallProgress} size="lg" showLabel={true} />
          </div>
        </div>

        {/* Search + Action Buttons */}
        <div className="flex flex-col md:flex-row gap-4 mb-6">
          <input
            type="text"
            placeholder="Search by door number, location, or HW set..."
            value={filters.search}
            onChange={(e) => updateFilter("search", e.target.value)}
            className="flex-1 px-4 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl text-[#f5f5f7] placeholder-[#6e6e73] focus:outline-none focus:ring-2 focus:ring-[#0a84ff]"
          />

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`px-4 py-2 rounded-lg transition-all text-sm flex items-center gap-2 ${
                showFilters || activeFilterCount > 0
                  ? "bg-[rgba(10,132,255,0.15)] border border-[rgba(10,132,255,0.3)] text-[#0a84ff]"
                  : "bg-white/[0.04] border border-white/[0.08] text-[#a1a1a6] hover:bg-white/[0.06]"
              }`}
            >
              Filters
              {activeFilterCount > 0 && (
                <span className="bg-white/10 text-xs px-1.5 py-0.5 rounded-full text-[#f5f5f7]">
                  {activeFilterCount}
                </span>
              )}
            </button>
            <button
              onClick={() => router.push(`/project/${projectId}/qr-codes`)}
              className="px-4 py-2 bg-white/[0.04] border border-white/[0.08] text-[#a1a1a6] rounded-lg hover:bg-white/[0.06] transition-colors text-sm"
            >
              Print QR Codes
            </button>
            <button
              onClick={() => {
                window.location.href = `/api/projects/${projectId}/export-csv`;
              }}
              className="px-4 py-2 bg-white/[0.04] border border-white/[0.08] text-[#a1a1a6] rounded-lg hover:bg-white/[0.06] transition-colors text-sm"
            >
              Export CSV
            </button>
            <button
              onClick={syncToSmartsheet}
              disabled={syncing}
              className={`px-4 py-2 rounded-lg transition-all text-sm flex items-center gap-2 ${
                syncing
                  ? "bg-[rgba(48,209,88,0.15)] text-[#30d158] cursor-wait border border-[rgba(48,209,88,0.2)]"
                  : "bg-[rgba(48,209,88,0.15)] border border-[rgba(48,209,88,0.3)] text-[#30d158] hover:bg-[rgba(48,209,88,0.25)]"
              }`}
            >
              {syncing ? (
                <>
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Syncing...
                </>
              ) : (
                "Sync to Smartsheet"
              )}
            </button>
            <button
              onClick={() => setShowUploadModal(true)}
              className="px-4 py-2 bg-[#0a84ff] text-white rounded-lg hover:bg-[#0a84ff] opacity-90 hover:opacity-100 transition-opacity text-sm"
            >
              Upload PDF
            </button>
          </div>
        </div>

        {/* Sync Result Banner */}
        {syncResult && (
          <div
            className={`mb-6 p-4 rounded-xl flex items-center justify-between text-sm border ${
              syncResult.success
                ? "bg-[rgba(48,209,88,0.1)] border-[rgba(48,209,88,0.2)] text-[#30d158]"
                : "bg-[rgba(255,69,58,0.1)] border-[rgba(255,69,58,0.2)] text-[#ff6961]"
            }`}
          >
            <span>{syncResult.message}</span>
            <div className="flex items-center gap-3">
              {syncResult.permalink && (
                <a
                  href={syncResult.permalink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#0a84ff] hover:opacity-80 underline transition-opacity"
                >
                  Open in Smartsheet
                </a>
              )}
              <button
                onClick={() => setSyncResult(null)}
                className="text-[#a1a1a6] hover:text-[#f5f5f7] transition-colors"
              >
                &times;
              </button>
            </div>
          </div>
        )}

        {/* Filter Panel */}
        {showFilters && (
          <div className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-6 mb-6">
            <div className="flex justify-between items-center mb-4">
              <span className="text-sm font-medium text-[#f5f5f7]">
                Filter Openings
              </span>
              {activeFilterCount > 0 && (
                <button
                  onClick={clearFilters}
                  className="text-xs text-[#0a84ff] hover:opacity-80 transition-opacity"
                >
                  Clear all filters
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div>
                <label className="block text-xs text-[#6e6e73] mb-2">
                  Status
                </label>
                <select
                  value={filters.status}
                  onChange={(e) => updateFilter("status", e.target.value)}
                  className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-sm text-[#f5f5f7] focus:outline-none focus:ring-2 focus:ring-[#0a84ff]"
                >
                  <option value="all">All</option>
                  <option value="complete">Complete</option>
                  <option value="incomplete">Incomplete</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#6e6e73] mb-2">
                  HW Set
                </label>
                <select
                  value={filters.hwSet}
                  onChange={(e) => updateFilter("hwSet", e.target.value)}
                  className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-sm text-[#f5f5f7] focus:outline-none focus:ring-2 focus:ring-[#0a84ff]"
                >
                  <option value="">All Sets</option>
                  {filterOptions.hwSets.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#6e6e73] mb-2">
                  Door Type
                </label>
                <select
                  value={filters.doorType}
                  onChange={(e) => updateFilter("doorType", e.target.value)}
                  className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-sm text-[#f5f5f7] focus:outline-none focus:ring-2 focus:ring-[#0a84ff]"
                >
                  <option value="">All Types</option>
                  {filterOptions.doorTypes.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#6e6e73] mb-2">
                  Fire Rating
                </label>
                <select
                  value={filters.fireRating}
                  onChange={(e) => updateFilter("fireRating", e.target.value)}
                  className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-sm text-[#f5f5f7] focus:outline-none focus:ring-2 focus:ring-[#0a84ff]"
                >
                  <option value="">All Ratings</option>
                  {filterOptions.fireRatings.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#6e6e73] mb-2">
                  Hand
                </label>
                <select
                  value={filters.hand}
                  onChange={(e) => updateFilter("hand", e.target.value)}
                  className="w-full px-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-lg text-sm text-[#f5f5f7] focus:outline-none focus:ring-2 focus:ring-[#0a84ff]"
                >
                  <option value="">All</option>
                  {filterOptions.hands.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mt-4 text-xs text-[#6e6e73]">
              Showing {filteredOpenings.length} of {openings.length} openings
            </div>
          </div>
        )}

        {/* Openings Grid */}
        {loading ? (
          <div className="text-center py-12 text-[#6e6e73]">Loading...</div>
        ) : error ? (
          <div className="p-4 bg-[rgba(255,69,58,0.1)] border border-[rgba(255,69,58,0.2)] rounded-xl text-[#ff6961]">
            {error}
          </div>
        ) : filteredOpenings.length === 0 ? (
          <div className="text-center py-12 text-[#6e6e73]">
            {openings.length === 0
              ? "No openings found"
              : "No openings match your filters"}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
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
                  className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-6 hover:bg-white/[0.07] hover:border-white/[0.12] cursor-pointer transition-all"
                >
                  <h2 className="text-2xl font-bold text-[#f5f5f7] mb-3">
                    Door {opening.door_number}
                  </h2>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {opening.hw_set && (
                      <span className="text-xs bg-[rgba(48,209,88,0.15)] text-[#30d158] border border-[rgba(48,209,88,0.2)] px-2 py-1 rounded-lg">
                        {opening.hw_set}
                      </span>
                    )}
                    {opening.door_type && (
                      <span className="text-xs bg-white/[0.04] text-[#a1a1a6] border border-white/[0.08] px-2 py-1 rounded-lg">
                        {opening.door_type}
                      </span>
                    )}
                    {opening.fire_rating && (
                      <span className="text-xs bg-[rgba(255,69,58,0.1)] text-[#ff6961] border border-[rgba(255,69,58,0.2)] px-2 py-1 rounded-lg">
                        {opening.fire_rating}
                      </span>
                    )}
                    {opening.hand && (
                      <span className="text-xs bg-white/[0.04] text-[#a1a1a6] border border-white/[0.08] px-2 py-1 rounded-lg">
                        {opening.hand}
                      </span>
                    )}
                  </div>
                  {opening.location && (
                    <p className="text-[#a1a1a6] text-sm mb-4">
                      {opening.location}
                    </p>
                  )}

                  <div className="mb-4">
                    <div className="flex justify-between items-center mb-2 text-sm">
                      <span className="text-[#f5f5f7]">Progress</span>
                      <span className="text-[#a1a1a6]">
                        {opening.checked_items} / {opening.total_items}
                      </span>
                    </div>
                    <ProgressBar
                      value={progressPercent}
                      size="sm"
                      showLabel={false}
                    />
                  </div>

                  <div className="text-xs text-[#6e6e73]">
                    {progressPercent.toFixed(0)}% complete
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
