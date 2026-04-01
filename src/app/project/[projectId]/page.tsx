"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter, useParams } from "next/navigation";
import OfflineIndicator from "@/components/OfflineIndicator";
import ProgressBar from "@/components/ProgressBar";
import PDFUploadModal from "@/components/PDFUploadModal";

interface ProjectSummary {
  project: {
    name: string;
    job_number: string | null;
    general_contractor: string | null;
    architect: string | null;
    address: string | null;
    submittal_date: string | null;
  } | null;
  totals: { openings: number; hardware_items: number; checked: number };
  classification: { bench: number; field: number; unclassified: number };
  workflow: { received: number; pre_install: number; installed: number; qa_qc: number };
  attachments: { floor_plan: number; door_drawing: number; frame_drawing: number; total: number };
  openings_complete: number;
  openings_incomplete: number;
}

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
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [showDashboard, setShowDashboard] = useState(true);

  useEffect(() => {
    fetchProjectData();
    fetchSummary();
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

  const fetchSummary = async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/summary`);
      if (response.ok) {
        const data = await response.json();
        setSummary(data);
      }
    } catch {}
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

  return (
    <div className="min-h-screen bg-slate-950">
      <style>{`
        .card-press {
          transition: transform 0.15s cubic-bezier(0.2, 0, 0.2, 1),
                      box-shadow 0.15s cubic-bezier(0.2, 0, 0.2, 1),
                      border-color 0.15s ease;
          will-change: transform;
        }
        .card-press:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 20px rgba(59, 130, 246, 0.15);
        }
        .card-press:active {
          transform: scale(0.97) translateY(0px);
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.4), 0 2px 12px rgba(59, 130, 246, 0.2);
          transition: transform 0.08s cubic-bezier(0.3, 0, 0.5, 1),
                      box-shadow 0.08s cubic-bezier(0.3, 0, 0.5, 1);
        }
        @keyframes card-ripple {
          0% { opacity: 0.5; transform: scale(0); }
          100% { opacity: 0; transform: scale(2.5); }
        }
        .card-press .ripple {
          position: absolute;
          border-radius: 50%;
          background: rgba(59, 130, 246, 0.3);
          animation: card-ripple 0.5s ease-out forwards;
          pointer-events: none;
        }
      `}</style>
      <OfflineIndicator />

      <main className="max-w-7xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <button
            onClick={() => router.push("/dashboard")}
            className="text-blue-400 hover:text-blue-300 mb-4 text-sm"
          >
            &larr; Back to Projects
          </button>
          <h1 className="text-3xl font-bold text-white mb-4">
            Project Details
          </h1>

          {/* Overall Progress */}
          <div className="mb-6">
            <div className="flex justify-between items-center mb-2">
              <span className="text-slate-300 text-sm font-medium">
                Overall Progress
              </span>
              <span className="text-slate-400 text-sm">
                {totalChecked} / {totalItems} items
              </span>
            </div>
            <ProgressBar value={overallProgress} size="lg" showLabel={true} />
          </div>
        </div>

        {/* Dashboard Summary */}
        {summary && (
          <div className="mb-6">
            <button
              onClick={() => setShowDashboard(!showDashboard)}
              className="flex items-center gap-2 text-sm text-slate-400 hover:text-slate-300 mb-3 transition-colors"
            >
              <svg
                className={`w-4 h-4 transition-transform ${showDashboard ? "rotate-90" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              {showDashboard ? "Hide Dashboard" : "Show Dashboard"}
            </button>

            {showDashboard && (
              <>
                {/* Project Info Bar */}
                {summary.project && (
                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-400 mb-4 px-1">
                    {summary.project.name && (
                      <span className="text-white font-medium">{summary.project.name}</span>
                    )}
                    {summary.project.job_number && (
                      <span>Job # {summary.project.job_number}</span>
                    )}
                    {summary.project.general_contractor && (
                      <span>GC: {summary.project.general_contractor}</span>
                    )}
                    {summary.project.architect && (
                      <span>Architect: {summary.project.architect}</span>
                    )}
                    {summary.project.submittal_date && (
                      <span>Submittal: {new Date(summary.project.submittal_date).toLocaleDateString()}</span>
                    )}
                  </div>
                )}

                {/* Stat Cards Row 1: Totals */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                  <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
                    <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Openings</p>
                    <p className="text-2xl font-bold text-white">{summary.totals.openings}</p>
                    <p className="text-xs text-slate-500 mt-1">
                      <span className="text-green-400">{summary.openings_complete}</span> complete
                      {summary.openings_incomplete > 0 && (
                        <> &middot; <span className="text-amber-400">{summary.openings_incomplete}</span> remaining</>
                      )}
                    </p>
                  </div>

                  <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
                    <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Hardware Items</p>
                    <p className="text-2xl font-bold text-white">{summary.totals.hardware_items}</p>
                    <p className="text-xs text-slate-500 mt-1">
                      <span className="text-green-400">{summary.totals.checked}</span> checked off
                    </p>
                  </div>

                  <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
                    <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Classification</p>
                    <div className="flex items-baseline gap-2 mt-1">
                      <span className="text-lg font-bold text-blue-400">{summary.classification.bench}</span>
                      <span className="text-xs text-slate-500">bench</span>
                      <span className="text-lg font-bold text-purple-400">{summary.classification.field}</span>
                      <span className="text-xs text-slate-500">field</span>
                    </div>
                    {summary.classification.unclassified > 0 && (
                      <p className="text-xs text-amber-400 mt-1">
                        {summary.classification.unclassified} unclassified
                      </p>
                    )}
                  </div>

                  <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
                    <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Drawings</p>
                    <p className="text-2xl font-bold text-white">{summary.attachments.total}</p>
                    <p className="text-xs text-slate-500 mt-1">
                      {summary.attachments.floor_plan} floor &middot; {summary.attachments.door_drawing} door &middot; {summary.attachments.frame_drawing} frame
                    </p>
                  </div>
                </div>

                {/* Workflow Pipeline */}
                {summary.totals.hardware_items > 0 && (
                  <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
                    <p className="text-xs text-slate-500 uppercase tracking-wide mb-3">Workflow Pipeline</p>
                    <div className="grid grid-cols-4 gap-2">
                      {[
                        { label: "Received", value: summary.workflow.received, color: "bg-blue-500" },
                        { label: "Pre-Install", value: summary.workflow.pre_install, color: "bg-amber-500" },
                        { label: "Installed", value: summary.workflow.installed, color: "bg-green-500" },
                        { label: "QA/QC", value: summary.workflow.qa_qc, color: "bg-purple-500" },
                      ].map((step) => {
                        const pct = summary.totals.hardware_items > 0
                          ? Math.round((step.value / summary.totals.hardware_items) * 100)
                          : 0;
                        return (
                          <div key={step.label} className="text-center">
                            <p className="text-xs text-slate-500 mb-2">{step.label}</p>
                            <div className="w-full bg-slate-800 rounded-full h-2 mb-1">
                              <div
                                className={`${step.color} h-2 rounded-full transition-all`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <p className="text-sm font-medium text-white">
                              {step.value}
                              <span className="text-xs text-slate-500 ml-1">({pct}%)</span>
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Search + Action Buttons */}
        <div className="flex flex-col md:flex-row gap-4 mb-4">
          <input
            type="text"
            placeholder="Search by door number, location, or HW set..."
            value={filters.search}
            onChange={(e) => updateFilter("search", e.target.value)}
            className="flex-1 px-4 py-2 bg-slate-900 border border-slate-800 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />

          <div className="flex gap-2">
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`px-4 py-2 rounded transition-colors text-sm flex items-center gap-2 ${
                showFilters || activeFilterCount > 0
                  ? "bg-blue-600 hover:bg-blue-700 text-white"
                  : "bg-slate-800 hover:bg-slate-700 text-white"
              }`}
            >
              Filters
              {activeFilterCount > 0 && (
                <span className="bg-white/20 text-xs px-1.5 py-0.5 rounded-full">
                  {activeFilterCount}
                </span>
              )}
            </button>
            <button
              onClick={() => router.push(`/project/${projectId}/qr-codes`)}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded transition-colors text-sm"
            >
              Print QR Codes
            </button>
            <button
              onClick={() => {
                window.location.href = `/api/projects/${projectId}/export-csv`;
              }}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded transition-colors text-sm"
            >
              Export CSV
            </button>
            <button
              onClick={() => setShowUploadModal(true)}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded transition-colors text-sm"
            >
              Upload PDF
            </button>
          </div>
        </div>

        {/* Filter Panel */}
        {showFilters && (
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 mb-6">
            <div className="flex justify-between items-center mb-3">
              <span className="text-sm font-medium text-slate-300">
                Filter Openings
              </span>
              {activeFilterCount > 0 && (
                <button
                  onClick={clearFilters}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  Clear all filters
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">
                  Status
                </label>
                <select
                  value={filters.status}
                  onChange={(e) => updateFilter("status", e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="all">All</option>
                  <option value="complete">Complete</option>
                  <option value="incomplete">Incomplete</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">
                  HW Set
                </label>
                <select
                  value={filters.hwSet}
                  onChange={(e) => updateFilter("hwSet", e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                <label className="block text-xs text-slate-500 mb-1">
                  Door Type
                </label>
                <select
                  value={filters.doorType}
                  onChange={(e) => updateFilter("doorType", e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                <label className="block text-xs text-slate-500 mb-1">
                  Fire Rating
                </label>
                <select
                  value={filters.fireRating}
                  onChange={(e) => updateFilter("fireRating", e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                <label className="block text-xs text-slate-500 mb-1">
                  Hand
                </label>
                <select
                  value={filters.hand}
                  onChange={(e) => updateFilter("hand", e.target.value)}
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
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
            <div className="mt-3 text-xs text-slate-500">
              Showing {filteredOpenings.length} of {openings.length} openings
            </div>
          </div>
        )}

        {/* Openings Grid */}
        {loading ? (
          <div className="text-center py-12 text-slate-400">Loading...</div>
        ) : error ? (
          <div className="p-4 bg-red-900/20 border border-red-900 rounded text-red-200">
            {error}
          </div>
        ) : filteredOpenings.length === 0 ? (
          <div className="text-center py-12 text-slate-400">
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
                  onClick={(e) => {
                    const card = e.currentTarget;
                    const rect = card.getBoundingClientRect();
                    const ripple = document.createElement("span");
                    const size = Math.max(rect.width, rect.height);
                    ripple.className = "ripple";
                    ripple.style.width = ripple.style.height = `${size}px`;
                    ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
                    ripple.style.top = `${e.clientY - rect.top - size / 2}px`;
                    card.appendChild(ripple);
                    setTimeout(() => ripple.remove(), 500);
                    setTimeout(() => router.push(`/project/${projectId}/door/${opening.id}`), 150);
                  }}
                  className="card-press relative overflow-hidden bg-slate-900 rounded-lg border border-slate-800 p-6 hover:border-blue-500 cursor-pointer"
                >
                  <h2 className="text-2xl font-bold text-white mb-2">
                    Door {opening.door_number}
                  </h2>
                  <div className="flex flex-wrap gap-2 mb-2">
                    {opening.hw_set && (
                      <span className="text-xs bg-slate-800 text-slate-300 px-2 py-0.5 rounded">
                        {opening.hw_set}
                      </span>
                    )}
                    {opening.door_type && (
                      <span className="text-xs bg-slate-800 text-slate-400 px-2 py-0.5 rounded">
                        {opening.door_type}
                      </span>
                    )}
                    {opening.fire_rating && (
                      <span className="text-xs bg-orange-900/40 text-orange-300 px-2 py-0.5 rounded">
                        {opening.fire_rating}
                      </span>
                    )}
                    {opening.hand && (
                      <span className="text-xs bg-slate-800 text-slate-500 px-2 py-0.5 rounded">
                        {opening.hand}
                      </span>
                    )}
                  </div>
                  {opening.location && (
                    <p className="text-slate-400 text-sm mb-4">
                      {opening.location}
                    </p>
                  )}

                  <div className="mb-4">
                    <div className="flex justify-between items-center mb-2 text-sm">
                      <span className="text-slate-300">Progress</span>
                      <span className="text-slate-400">
                        {opening.checked_items} / {opening.total_items}
                      </span>
                    </div>
                    <ProgressBar
                      value={progressPercent}
                      size="sm"
                      showLabel={false}
                    />
                  </div>

                  <div className="text-xs text-slate-500">
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
