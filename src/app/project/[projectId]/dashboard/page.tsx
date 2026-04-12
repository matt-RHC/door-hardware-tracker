"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter, useParams } from "next/navigation";
import ProgressBar from "@/components/ProgressBar";

interface DoorRow {
  doorNumber: string;
  hwSet: string;
  hwHeading: string;
  location: string;
  status: string;
  progress: number;
  classification: string;
}

interface DashboardData {
  synced: boolean;
  lastFetched?: string;
  permalink?: string;
  summary?: {
    totalDoors: number;
    averageProgress: number;
    statusBreakdown: {
      notStarted: number;
      inProgress: number;
      complete: number;
    };
  };
  doors?: DoorRow[];
}

type SortKey = "doorNumber" | "hwSet" | "location" | "status" | "progress";
type SortDir = "asc" | "desc";

export default function DashboardPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const router = useRouter();

  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("doorNumber");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [refreshing, setRefreshing] = useState(false);

  const fetchDashboard = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/smartsheet-dashboard`);
      if (!response.ok) throw new Error("Failed to fetch dashboard");
      const result: DashboardData = await response.json();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchDashboard();
  }, [projectId]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sortedDoors = useMemo(() => {
    const doors = data?.doors ?? [];
    return [...doors].sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      const dir = sortDir === "asc" ? 1 : -1;
      if (typeof aVal === "number" && typeof bVal === "number") {
        return (aVal - bVal) * dir;
      }
      return String(aVal).localeCompare(String(bVal)) * dir;
    });
  }, [data?.doors, sortKey, sortDir]);

  const statusColor = (status: string) => {
    if (status === "Complete") return "bg-success-dim text-[var(--green)] border-[var(--green)]";
    if (status === "In Progress") return "bg-accent-dim text-[var(--blue)] border-[var(--blue)]";
    return "bg-[var(--surface)] text-[var(--text-tertiary)] border-[var(--border)]";
  };

  const SortIcon = ({ active, dir }: { active: boolean; dir: SortDir }) => (
    <svg className={`w-3 h-3 inline-block ml-1 ${active ? "text-[var(--blue)]" : "text-[var(--text-tertiary)]"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      {dir === "asc" ? (
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
      ) : (
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      )}
    </svg>
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--background)] flex items-center justify-center">
        <div className="text-[var(--text-secondary)]">Loading dashboard...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[var(--background)] p-4">
        <div className="max-w-4xl mx-auto">
          <button
            onClick={() => router.push(`/project/${projectId}`)}
            className="text-[var(--blue)] hover:text-[var(--blue)]/80 flex items-center gap-1 text-[15px] mb-4 min-h-[44px]"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </button>
          <div className="p-4 bg-danger-dim border border-[var(--red)] rounded-lg text-[var(--red)]">
            {error}
          </div>
        </div>
      </div>
    );
  }

  if (!data?.synced) {
    return (
      <div className="min-h-screen bg-[var(--background)] p-4">
        <div className="max-w-4xl mx-auto">
          <button
            onClick={() => router.push(`/project/${projectId}`)}
            className="text-[var(--blue)] hover:text-[var(--blue)]/80 flex items-center gap-1 text-[15px] mb-4 min-h-[44px]"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </button>
          <div className="text-center py-16">
            <svg className="w-16 h-16 text-[var(--text-tertiary)] mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <h2 className="text-[20px] font-semibold text-[var(--text-primary)] mb-2">No Smartsheet Synced</h2>
            <p className="text-[15px] text-[var(--text-secondary)] mb-6">
              Sync this project to Smartsheet first to view the dashboard.
            </p>
            <button
              onClick={() => router.push(`/project/${projectId}`)}
              className="px-6 py-2.5 min-h-[44px] bg-[var(--blue)] hover:bg-[var(--blue)]/80 text-white rounded-lg transition-colors text-[15px] font-medium"
            >
              Go to Project
            </button>
          </div>
        </div>
      </div>
    );
  }

  const summary = data.summary!;

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-[var(--background)]/85 backdrop-blur-xl border-b border-[var(--border)]">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <button
            onClick={() => router.push(`/project/${projectId}`)}
            className="text-[var(--blue)] hover:text-[var(--blue)]/80 flex items-center gap-1 text-[15px] min-h-[44px] min-w-[44px] justify-center"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-[17px] font-semibold text-[var(--text-primary)]">
            Smartsheet Dashboard
          </h1>
          <div className="flex items-center gap-2">
            {data.permalink && (
              <a
                href={data.permalink}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--blue)] hover:text-[var(--blue)]/80 text-[13px] underline min-h-[44px] flex items-center"
              >
                Open in Smartsheet
              </a>
            )}
            <button
              onClick={() => fetchDashboard(true)}
              disabled={refreshing}
              className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] min-h-[44px] min-w-[44px] flex items-center justify-center"
              title="Refresh"
            >
              <svg className={`w-5 h-5 ${refreshing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4">
            <p className="text-[11px] uppercase font-medium text-[var(--text-tertiary)] mb-1">Total Doors</p>
            <p className="text-[28px] font-bold text-[var(--text-primary)]">{summary.totalDoors}</p>
          </div>
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4">
            <p className="text-[11px] uppercase font-medium text-[var(--text-tertiary)] mb-1">Avg Progress</p>
            <p className="text-[28px] font-bold text-[var(--blue)]">{summary.averageProgress}%</p>
          </div>
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4">
            <p className="text-[11px] uppercase font-medium text-[var(--text-tertiary)] mb-1">In Progress</p>
            <p className="text-[28px] font-bold text-[var(--text-primary)]">{summary.statusBreakdown.inProgress}</p>
          </div>
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4">
            <p className="text-[11px] uppercase font-medium text-[var(--text-tertiary)] mb-1">Complete</p>
            <p className="text-[28px] font-bold text-[var(--green)]">{summary.statusBreakdown.complete}</p>
          </div>
        </div>

        {/* Overall Progress */}
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[11px] uppercase font-medium text-[var(--text-tertiary)]">Overall Progress</span>
            <span className="text-[13px] text-[var(--text-secondary)]">
              {summary.statusBreakdown.complete} / {summary.totalDoors} complete
            </span>
          </div>
          <ProgressBar
            value={summary.averageProgress}
            size="lg"
            showLabel={false}
          />
        </div>

        {/* Last fetched timestamp */}
        {data.lastFetched && (
          <p className="text-[11px] text-[var(--text-tertiary)] text-right">
            Last fetched: {new Date(data.lastFetched).toLocaleString()}
          </p>
        )}

        {/* Door Table */}
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  {([
                    { key: "doorNumber" as SortKey, label: "Door Number" },
                    { key: "hwSet" as SortKey, label: "HW Set" },
                    { key: "location" as SortKey, label: "Location" },
                    { key: "status" as SortKey, label: "Status" },
                    { key: "progress" as SortKey, label: "Progress" },
                  ]).map(({ key, label }) => (
                    <th
                      key={key}
                      onClick={() => handleSort(key)}
                      className="px-4 py-3 text-[11px] uppercase font-medium text-[var(--text-tertiary)] cursor-pointer hover:text-[var(--text-secondary)] select-none whitespace-nowrap"
                    >
                      {label}
                      <SortIcon active={sortKey === key} dir={sortKey === key ? sortDir : "asc"} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedDoors.map((door, idx) => (
                  <tr
                    key={`${door.doorNumber}-${idx}`}
                    className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--surface-hover)] transition-colors"
                  >
                    <td className="px-4 py-3 text-[13px] font-medium text-[var(--text-primary)] whitespace-nowrap">
                      {door.doorNumber}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-[var(--text-secondary)] whitespace-nowrap">
                      {door.hwSet || "—"}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-[var(--text-secondary)]">
                      {door.location || "—"}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`text-[11px] font-medium px-2 py-1 rounded-full border ${statusColor(door.status)}`}>
                        {door.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-2 min-w-[120px]">
                        <div className="flex-1 h-1.5 bg-[var(--border)] rounded-full overflow-hidden">
                          <div
                            className="h-full bg-[var(--blue)] rounded-full transition-all"
                            style={{ width: `${door.progress}%` }}
                          />
                        </div>
                        <span className="text-[11px] text-[var(--text-tertiary)] min-w-[32px] text-right">
                          {door.progress}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
                {sortedDoors.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-[var(--text-tertiary)] text-[13px]">
                      No door data available
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
