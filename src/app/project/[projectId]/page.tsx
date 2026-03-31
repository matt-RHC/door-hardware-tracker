"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import OfflineIndicator from "@/components/OfflineIndicator";
import ProgressBar from "@/components/ProgressBar";

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
  status: string | null;
  notes: string | null;
  created_at: string;
  total_items: number;
  checked_items: number;
}

export default function ProjectDetailPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const router = useRouter();

  const [openings, setOpenings] = useState<OpeningWithProgress[]>([]);
  const [filteredOpenings, setFilteredOpenings] = useState<OpeningWithProgress[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "complete" | "incomplete">("all");

  useEffect(() => {
    fetchProjectData();
  }, [projectId]);

  useEffect(() => {
    applyFilters();
  }, [openings, searchQuery, filterStatus]);

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

  const applyFilters = () => {
    let filtered = openings;

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (opening) =>
          opening.door_number.toLowerCase().includes(query) ||
          opening.hw_set?.toLowerCase().includes(query) ||
          opening.location?.toLowerCase().includes(query)
      );
    }

    // Status filter
    if (filterStatus !== "all") {
      filtered = filtered.filter((opening) => {
        const progressPercent =
          opening.total_items > 0
            ? (opening.checked_items / opening.total_items) * 100
            : 0;
        if (filterStatus === "complete") return progressPercent === 100;
        if (filterStatus === "incomplete") return progressPercent < 100;
        return true;
      });
    }

    setFilteredOpenings(filtered);
  };

  const totalItems = openings.reduce((sum, o) => sum + o.total_items, 0);
  const totalChecked = openings.reduce((sum, o) => sum + o.checked_items, 0);
  const overallProgress = totalItems > 0 ? (totalChecked / totalItems) * 100 : 0;

  return (
    <div className="min-h-screen bg-slate-950">
      <OfflineIndicator />

      <main className="max-w-7xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <button
            onClick={() => router.push("/dashboard")}
            className="text-blue-400 hover:text-blue-300 mb-4 text-sm"
          >
            ← Back to Projects
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
            <ProgressBar
              value={overallProgress}
              size="lg"
              showLabel={true}
            />
          </div>
        </div>

        {/* Controls */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <input
            type="text"
            placeholder="Search by door number or location..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="px-4 py-2 bg-slate-900 border border-slate-800 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />

          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as any)}
            className="px-4 py-2 bg-slate-900 border border-slate-800 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Openings</option>
            <option value="complete">Complete</option>
            <option value="incomplete">Incomplete</option>
          </select>

          <div className="flex gap-2">
            <button
              onClick={() => router.push(`/project/${projectId}/qr-codes`)}
              className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded transition-colors text-sm"
            >
              Print QR Codes
            </button>
            <button
              onClick={() => {
                /* TODO: Open PDF upload modal */
              }}
              className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded transition-colors text-sm"
            >
              Upload PDF
            </button>
          </div>
        </div>

        {/* Openings Grid */}
        {loading ? (
          <div className="text-center py-12 text-slate-400">Loading...</div>
        ) : error ? (
          <div className="p-4 bg-red-900/20 border border-red-900 rounded text-red-200">
            {error}
          </div>
        ) : filteredOpenings.length === 0 ? (
          <div className="text-center py-12 text-slate-400">
            No openings found
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
                  className="bg-slate-900 rounded-lg border border-slate-800 p-6 hover:border-blue-500 cursor-pointer transition-colors"
                >
                  <h2 className="text-2xl font-bold text-white mb-1">
                    Door {opening.door_number}
                  </h2>
                  {opening.hw_set && (
                    <p className="text-blue-400 text-sm mb-1">
                      HW Set: {opening.hw_set}
                    </p>
                  )}
                  {opening.fire_rating && (
                    <p className="text-amber-400 text-xs mb-1">
                      {opening.fire_rating} Fire Rating
                    </p>
                  )}
                  {opening.location && (
                    <p className="text-slate-400 text-sm mb-3">
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
                    <ProgressBar value={progressPercent} size="sm" showLabel={false} />
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
    </div>
  );
}
