"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
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

/* ─── SVG Progress Ring ─── */
function ProgressRing({
  value,
  size = 120,
  strokeWidth = 8,
  color = "#3b82f6",
  trackColor = "#1e293b",
  label,
  sublabel,
}: {
  value: number;
  size?: number;
  strokeWidth?: number;
  color?: string;
  trackColor?: string;
  label: string;
  sublabel?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (Math.min(value, 100) / 100) * circumference;

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} className="ring-svg">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={trackColor}
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="ring-progress"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x={size / 2}
          y={size / 2 - 4}
          textAnchor="middle"
          dominantBaseline="central"
          fill="white"
          fontSize={size * 0.22}
          fontWeight="bold"
        >
          {Math.round(value)}%
        </text>
        {sublabel && (
          <text
            x={size / 2}
            y={size / 2 + size * 0.15}
            textAnchor="middle"
            dominantBaseline="central"
            fill="#94a3b8"
            fontSize={size * 0.1}
          >
            {sublabel}
          </text>
        )}
      </svg>
      <p className="text-xs text-slate-400 mt-2 text-center">{label}</p>
    </div>
  );
}

/* ─── Donut Chart for Classification ─── */
function DonutChart({
  segments,
  size = 120,
  strokeWidth = 16,
}: {
  segments: { value: number; color: string; label: string }[];
  size?: number;
  strokeWidth?: number;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  let accumulated = 0;

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size}>
        {/* Background track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#1e293b"
          strokeWidth={strokeWidth}
        />
        {total > 0 &&
          segments.map((seg, i) => {
            const pct = seg.value / total;
            const dashLength = pct * circumference;
            const dashOffset = -(accumulated / total) * circumference;
            accumulated += seg.value;
            return (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={seg.color}
                strokeWidth={strokeWidth}
                strokeLinecap="butt"
                strokeDasharray={`${dashLength} ${circumference - dashLength}`}
                strokeDashoffset={dashOffset}
                className="donut-segment"
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              />
            );
          })}
        <text
          x={size / 2}
          y={size / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fill="white"
          fontSize={size * 0.2}
          fontWeight="bold"
        >
          {total}
        </text>
      </svg>
      <div className="flex gap-3 mt-2">
        {segments.map((seg, i) => (
          <div key={i} className="flex items-center gap-1">
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: seg.color }}
            />
            <span className="text-xs text-slate-400">
              {seg.label} ({seg.value})
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Workflow Pipeline Visual ─── */
function WorkflowPipeline({
  steps,
  total,
}: {
  steps: { label: string; value: number; color: string; icon: string }[];
  total: number;
}) {
  return (
    <div className="flex items-stretch gap-0">
      {steps.map((step, i) => {
        const pct = total > 0 ? Math.round((step.value / total) * 100) : 0;
        return (
          <div key={step.label} className="flex-1 flex flex-col items-center relative">
            {/* Connector line */}
            {i < steps.length - 1 && (
              <div className="absolute top-6 left-[50%] w-full h-0.5 bg-slate-700 z-0">
                <div
                  className="h-full transition-all duration-700 ease-out"
                  style={{
                    width: pct > 0 ? "100%" : "0%",
                    backgroundColor: step.color,
                    opacity: 0.5,
                  }}
                />
              </div>
            )}
            {/* Circle node */}
            <div
              className="pipeline-node w-12 h-12 rounded-full flex items-center justify-center text-lg z-10 border-2 transition-all duration-300"
              style={{
                backgroundColor: pct > 0 ? step.color + "20" : "#0f172a",
                borderColor: pct > 0 ? step.color : "#334155",
                boxShadow: pct > 50 ? `0 0 16px ${step.color}40` : "none",
              }}
            >
              <span>{step.icon}</span>
            </div>
            <p className="text-xs text-slate-400 mt-2 font-medium">{step.label}</p>
            <p className="text-sm font-bold text-white">
              {step.value}
              <span className="text-xs text-slate-500 font-normal ml-1">
                ({pct}%)
              </span>
            </p>
          </div>
        );
      })}
    </div>
  );
}

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
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [activeTab, setActiveTab] = useState<"dashboard" | "openings">("dashboard");

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

  const handleCardClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, openingId: string) => {
      const card = e.currentTarget;
      const rect = card.getBoundingClientRect();
      const ripple = document.createElement("span");
      const size = Math.max(rect.width, rect.height);
      ripple.className = "ripple";
      ripple.style.width = ripple.style.height = `${size}px`;
      ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
      ripple.style.top = `${e.clientY - rect.top - size / 2}px`;
      card.appendChild(ripple);
      setTimeout(() => ripple.remove(), 600);
      setTimeout(
        () => router.push(`/project/${projectId}/door/${openingId}`),
        120
      );
    },
    [projectId, router]
  );

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
        const pct =
          o.total_items > 0 ? (o.checked_items / o.total_items) * 100 : 0;
        return filters.status === "complete" ? pct === 100 : pct < 100;
      });
    }
    if (filters.hwSet)
      filtered = filtered.filter((o) => o.hw_set === filters.hwSet);
    if (filters.doorType)
      filtered = filtered.filter((o) => o.door_type === filters.doorType);
    if (filters.fireRating)
      filtered = filtered.filter((o) => o.fire_rating === filters.fireRating);
    if (filters.hand)
      filtered = filtered.filter((o) => o.hand === filters.hand);
    return filtered;
  }, [openings, filters]);

  const activeFilterCount =
    [filters.hwSet, filters.doorType, filters.fireRating, filters.hand].filter(
      Boolean
    ).length + (filters.status !== "all" ? 1 : 0);

  const clearFilters = () => {
    setFilters({ ...defaultFilters, search: filters.search });
  };

  const totalItems = openings.reduce((sum, o) => sum + o.total_items, 0);
  const totalChecked = openings.reduce((sum, o) => sum + o.checked_items, 0);
  const overallProgress =
    totalItems > 0 ? (totalChecked / totalItems) * 100 : 0;

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
    <div className="min-h-screen bg-slate-950">
      <style>{`
        /* ─── Global Animations ─── */
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes rippleOut {
          0% { opacity: 0.4; transform: scale(0); }
          100% { opacity: 0; transform: scale(2.5); }
        }
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        @keyframes ringDraw {
          from { stroke-dashoffset: var(--circumference); }
        }
        .ring-progress {
          transition: stroke-dashoffset 1s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .donut-segment {
          transition: stroke-dasharray 0.8s cubic-bezier(0.4, 0, 0.2, 1),
                      stroke-dashoffset 0.8s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .fade-slide-in {
          animation: fadeSlideIn 0.35s cubic-bezier(0.2, 0, 0.2, 1) both;
        }

        /* ─── Tab Pill Buttons ─── */
        .tab-pill {
          position: relative;
          transition: all 0.2s cubic-bezier(0.2, 0, 0.2, 1);
          overflow: hidden;
        }
        .tab-pill::after {
          content: '';
          position: absolute;
          bottom: 0;
          left: 50%;
          width: 0;
          height: 2px;
          background: #3b82f6;
          transition: all 0.25s cubic-bezier(0.2, 0, 0.2, 1);
          transform: translateX(-50%);
          border-radius: 1px;
        }
        .tab-pill.active::after {
          width: 60%;
        }
        .tab-pill:active {
          transform: scale(0.96);
        }

        /* ─── Card Press ─── */
        .card-press {
          transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1),
                      box-shadow 0.2s cubic-bezier(0.2, 0, 0.2, 1),
                      border-color 0.2s ease;
          will-change: transform;
        }
        .card-press:hover {
          transform: translateY(-3px);
          box-shadow: 0 8px 30px rgba(59, 130, 246, 0.12),
                      0 2px 8px rgba(0, 0, 0, 0.3);
        }
        .card-press:active {
          transform: scale(0.965) translateY(0px);
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.5),
                      0 4px 16px rgba(59, 130, 246, 0.15);
          transition: transform 0.1s cubic-bezier(0.3, 0, 0.5, 1),
                      box-shadow 0.1s cubic-bezier(0.3, 0, 0.5, 1);
        }
        .card-press .ripple {
          position: absolute;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(59, 130, 246, 0.35) 0%, transparent 70%);
          animation: rippleOut 0.6s cubic-bezier(0, 0, 0.2, 1) forwards;
          pointer-events: none;
        }

        /* ─── Interactive Elements (buttons, tags, selects) ─── */
        .interactive-el {
          transition: all 0.15s cubic-bezier(0.2, 0, 0.2, 1);
        }
        .interactive-el:hover {
          transform: translateY(-1px);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
        }
        .interactive-el:active {
          transform: scale(0.96) translateY(0);
          transition: transform 0.08s ease;
        }

        /* ─── Tag Chips ─── */
        .tag-chip {
          transition: all 0.15s cubic-bezier(0.2, 0, 0.2, 1);
        }
        .tag-chip:hover {
          filter: brightness(1.2);
          transform: translateY(-1px);
        }

        /* ─── Select dropdowns ─── */
        .select-animated {
          transition: all 0.15s cubic-bezier(0.2, 0, 0.2, 1);
        }
        .select-animated:focus {
          transform: translateY(-1px);
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.4),
                      0 4px 12px rgba(59, 130, 246, 0.1);
        }

        /* ─── Stat Cards ─── */
        .stat-card {
          transition: all 0.2s cubic-bezier(0.2, 0, 0.2, 1);
        }
        .stat-card:hover {
          border-color: #334155;
          transform: translateY(-2px);
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        }

        /* ─── Pipeline Node ─── */
        .pipeline-node {
          transition: all 0.3s cubic-bezier(0.2, 0, 0.2, 1);
        }
        .pipeline-node:hover {
          transform: scale(1.1);
        }

        /* ─── Stagger children ─── */
        .stagger > * {
          animation: fadeSlideIn 0.3s cubic-bezier(0.2, 0, 0.2, 1) both;
        }
        .stagger > *:nth-child(1) { animation-delay: 0ms; }
        .stagger > *:nth-child(2) { animation-delay: 60ms; }
        .stagger > *:nth-child(3) { animation-delay: 120ms; }
        .stagger > *:nth-child(4) { animation-delay: 180ms; }
        .stagger > *:nth-child(5) { animation-delay: 240ms; }
        .stagger > *:nth-child(6) { animation-delay: 300ms; }
        .stagger > *:nth-child(7) { animation-delay: 360ms; }
        .stagger > *:nth-child(8) { animation-delay: 420ms; }

        /* Card grid stagger */
        .card-grid > * {
          animation: fadeSlideIn 0.35s cubic-bezier(0.2, 0, 0.2, 1) both;
        }
        .card-grid > *:nth-child(1) { animation-delay: 0ms; }
        .card-grid > *:nth-child(2) { animation-delay: 40ms; }
        .card-grid > *:nth-child(3) { animation-delay: 80ms; }
        .card-grid > *:nth-child(4) { animation-delay: 120ms; }
        .card-grid > *:nth-child(5) { animation-delay: 160ms; }
        .card-grid > *:nth-child(6) { animation-delay: 200ms; }
        .card-grid > *:nth-child(7) { animation-delay: 240ms; }
        .card-grid > *:nth-child(8) { animation-delay: 280ms; }
        .card-grid > *:nth-child(9) { animation-delay: 320ms; }
        .card-grid > *:nth-child(n+10) { animation-delay: 350ms; }
      `}</style>
      <OfflineIndicator />

      <main className="max-w-7xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-6">
          <button
            onClick={() => router.push("/dashboard")}
            className="interactive-el text-blue-400 hover:text-blue-300 mb-4 text-sm inline-block"
          >
            &larr; Back to Projects
          </button>

          {/* Project Title + Meta */}
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-2 mb-4">
            <div>
              <h1 className="text-3xl font-bold text-white">
                {summary?.project?.name || "Project Details"}
              </h1>
              {summary?.project && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
                  {summary.project.job_number && (
                    <span className="text-sm text-slate-500">
                      Job #{summary.project.job_number}
                    </span>
                  )}
                  {summary.project.general_contractor && (
                    <span className="text-sm text-slate-500">
                      GC: {summary.project.general_contractor}
                    </span>
                  )}
                  {summary.project.architect && (
                    <span className="text-sm text-slate-500">
                      Architect: {summary.project.architect}
                    </span>
                  )}
                  {summary.project.submittal_date && (
                    <span className="text-sm text-slate-500">
                      Submittal:{" "}
                      {new Date(
                        summary.project.submittal_date
                      ).toLocaleDateString()}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => router.push(`/project/${projectId}/qr-codes`)}
                className="interactive-el px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm border border-slate-700"
              >
                Print QR Codes
              </button>
              <button
                onClick={() => {
                  window.location.href = `/api/projects/${projectId}/export-csv`;
                }}
                className="interactive-el px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm border border-slate-700"
              >
                Export CSV
              </button>
              <button
                onClick={syncToSmartsheet}
                disabled={syncing}
                className={`interactive-el px-4 py-2 rounded-lg text-sm flex items-center gap-2 ${
                  syncing
                    ? "bg-green-800/50 text-green-300 cursor-wait"
                    : "bg-green-700 hover:bg-green-600 text-white"
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
                className="interactive-el px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm"
              >
                Upload PDF
              </button>
            </div>
          </div>

          {/* Smartsheet Sync Result Banner */}
          {syncResult && (
            <div
              className={`p-3 rounded-lg flex items-center justify-between text-sm ${
                syncResult.success
                  ? "bg-green-900/30 border border-green-800 text-green-200"
                  : "bg-red-900/30 border border-red-800 text-red-200"
              }`}
            >
              <span>{syncResult.message}</span>
              <div className="flex items-center gap-3">
                {syncResult.permalink && (
                  <a
                    href={syncResult.permalink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-green-400 hover:text-green-300 underline"
                  >
                    Open in Smartsheet
                  </a>
                )}
                <button
                  onClick={() => setSyncResult(null)}
                  className="text-slate-400 hover:text-white"
                >
                  &times;
                </button>
              </div>
            </div>
          )}

          {/* Tab Bar */}
          <div className="flex gap-1 bg-slate-900/50 p-1 rounded-xl border border-slate-800 w-fit">
            {(
              [
                { key: "dashboard", label: "Dashboard", icon: "M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" },
                { key: "openings", label: `Openings (${openings.length})`, icon: "M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key as "dashboard" | "openings")}
                className={`tab-pill flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium ${
                  activeTab === tab.key
                    ? "bg-slate-800 text-white shadow-md active"
                    : "text-slate-400 hover:text-slate-300 hover:bg-slate-800/50"
                }`}
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d={tab.icon}
                  />
                </svg>
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* ═══════════════ DASHBOARD TAB ═══════════════ */}
        {activeTab === "dashboard" && (
          <div className="fade-slide-in">
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

            {summary && (
              <>
                {/* Visual Rings Row */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6 stagger">
                  {/* Completion Ring */}
                  <div className="stat-card bg-slate-900 border border-slate-800 rounded-xl p-6 flex flex-col items-center">
                    <ProgressRing
                      value={overallProgress}
                      size={140}
                      strokeWidth={10}
                      color="#22c55e"
                      label="Checklist Progress"
                      sublabel={`${totalChecked} of ${totalItems}`}
                    />
                  </div>

                  {/* Openings Ring */}
                  <div className="stat-card bg-slate-900 border border-slate-800 rounded-xl p-6 flex flex-col items-center">
                    <ProgressRing
                      value={
                        summary.totals.openings > 0
                          ? (summary.openings_complete /
                              summary.totals.openings) *
                            100
                          : 0
                      }
                      size={140}
                      strokeWidth={10}
                      color="#3b82f6"
                      label="Openings Complete"
                      sublabel={`${summary.openings_complete} of ${summary.totals.openings}`}
                    />
                  </div>

                  {/* Classification Donut */}
                  <div className="stat-card bg-slate-900 border border-slate-800 rounded-xl p-6 flex flex-col items-center">
                    <DonutChart
                      size={140}
                      strokeWidth={18}
                      segments={[
                        {
                          value: summary.classification.bench,
                          color: "#3b82f6",
                          label: "Bench",
                        },
                        {
                          value: summary.classification.field,
                          color: "#a855f7",
                          label: "Field",
                        },
                        {
                          value: summary.classification.unclassified,
                          color: "#475569",
                          label: "TBD",
                        },
                      ]}
                    />
                    <p className="text-xs text-slate-400 mt-2">
                      Install Classification
                    </p>
                  </div>
                </div>

                {/* Workflow Pipeline */}
                {summary.totals.hardware_items > 0 && (
                  <div className="stat-card bg-slate-900 border border-slate-800 rounded-xl p-6 mb-6 fade-slide-in">
                    <p className="text-sm font-medium text-slate-300 mb-5">
                      Workflow Pipeline
                    </p>
                    <WorkflowPipeline
                      total={summary.totals.hardware_items}
                      steps={[
                        {
                          label: "Received",
                          value: summary.workflow.received,
                          color: "#3b82f6",
                          icon: "\u{1F4E6}",
                        },
                        {
                          label: "Pre-Install",
                          value: summary.workflow.pre_install,
                          color: "#f59e0b",
                          icon: "\u{1F527}",
                        },
                        {
                          label: "Installed",
                          value: summary.workflow.installed,
                          color: "#22c55e",
                          icon: "\u2705",
                        },
                        {
                          label: "QA / QC",
                          value: summary.workflow.qa_qc,
                          color: "#a855f7",
                          icon: "\u{1F50D}",
                        },
                      ]}
                    />
                  </div>
                )}

                {/* Stat Cards Row */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 stagger">
                  <div className="stat-card bg-slate-900 border border-slate-800 rounded-xl p-5">
                    <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">
                      Total Openings
                    </p>
                    <p className="text-3xl font-bold text-white">
                      {summary.totals.openings}
                    </p>
                    <div className="flex gap-2 mt-2">
                      <span className="tag-chip text-xs bg-green-900/30 text-green-400 px-2 py-0.5 rounded-full">
                        {summary.openings_complete} done
                      </span>
                      {summary.openings_incomplete > 0 && (
                        <span className="tag-chip text-xs bg-amber-900/30 text-amber-400 px-2 py-0.5 rounded-full">
                          {summary.openings_incomplete} left
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="stat-card bg-slate-900 border border-slate-800 rounded-xl p-5">
                    <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">
                      Hardware Items
                    </p>
                    <p className="text-3xl font-bold text-white">
                      {summary.totals.hardware_items}
                    </p>
                    <div className="mt-2">
                      <span className="tag-chip text-xs bg-green-900/30 text-green-400 px-2 py-0.5 rounded-full">
                        {summary.totals.checked} checked
                      </span>
                    </div>
                  </div>

                  <div className="stat-card bg-slate-900 border border-slate-800 rounded-xl p-5">
                    <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">
                      Drawings Uploaded
                    </p>
                    <p className="text-3xl font-bold text-white">
                      {summary.attachments.total}
                    </p>
                    <div className="flex flex-wrap gap-1 mt-2">
                      <span className="tag-chip text-xs bg-blue-900/30 text-blue-400 px-2 py-0.5 rounded-full">
                        {summary.attachments.floor_plan} floor
                      </span>
                      <span className="tag-chip text-xs bg-purple-900/30 text-purple-400 px-2 py-0.5 rounded-full">
                        {summary.attachments.door_drawing} door
                      </span>
                      <span className="tag-chip text-xs bg-emerald-900/30 text-emerald-400 px-2 py-0.5 rounded-full">
                        {summary.attachments.frame_drawing} frame
                      </span>
                    </div>
                  </div>

                  <div className="stat-card bg-slate-900 border border-slate-800 rounded-xl p-5">
                    <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">
                      Classification
                    </p>
                    <div className="flex items-baseline gap-3 mt-1">
                      <div>
                        <span className="text-2xl font-bold text-blue-400">
                          {summary.classification.bench}
                        </span>
                        <span className="text-xs text-slate-500 ml-1">
                          bench
                        </span>
                      </div>
                      <div>
                        <span className="text-2xl font-bold text-purple-400">
                          {summary.classification.field}
                        </span>
                        <span className="text-xs text-slate-500 ml-1">
                          field
                        </span>
                      </div>
                    </div>
                    {summary.classification.unclassified > 0 && (
                      <p className="text-xs text-amber-400 mt-2">
                        {summary.classification.unclassified} unclassified
                      </p>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ═══════════════ OPENINGS TAB ═══════════════ */}
        {activeTab === "openings" && (
          <div className="fade-slide-in">
            {/* Search + Filters */}
            <div className="flex flex-col md:flex-row gap-4 mb-4">
              <input
                type="text"
                placeholder="Search by door number, location, or HW set..."
                value={filters.search}
                onChange={(e) => updateFilter("search", e.target.value)}
                className="select-animated flex-1 px-4 py-2 bg-slate-900 border border-slate-800 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />

              <div className="flex gap-2">
                <button
                  onClick={() => setShowFilters(!showFilters)}
                  className={`interactive-el px-4 py-2 rounded-lg text-sm flex items-center gap-2 border ${
                    showFilters || activeFilterCount > 0
                      ? "bg-blue-600/20 border-blue-500 text-blue-400"
                      : "bg-slate-800 border-slate-700 hover:bg-slate-700 text-white"
                  }`}
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
                    />
                  </svg>
                  Filters
                  {activeFilterCount > 0 && (
                    <span className="bg-blue-500 text-white text-xs w-5 h-5 flex items-center justify-center rounded-full">
                      {activeFilterCount}
                    </span>
                  )}
                </button>
              </div>
            </div>

            {/* Filter Panel */}
            {showFilters && (
              <div className="fade-slide-in bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6">
                <div className="flex justify-between items-center mb-3">
                  <span className="text-sm font-medium text-slate-300">
                    Filter Openings
                  </span>
                  {activeFilterCount > 0 && (
                    <button
                      onClick={clearFilters}
                      className="interactive-el text-xs text-blue-400 hover:text-blue-300 px-2 py-1 rounded"
                    >
                      Clear all filters
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  {[
                    {
                      label: "Status",
                      value: filters.status,
                      key: "status" as const,
                      options: [
                        { value: "all", label: "All" },
                        { value: "complete", label: "Complete" },
                        { value: "incomplete", label: "Incomplete" },
                      ],
                    },
                    {
                      label: "HW Set",
                      value: filters.hwSet,
                      key: "hwSet" as const,
                      options: [
                        { value: "", label: "All Sets" },
                        ...filterOptions.hwSets.map((s) => ({
                          value: s,
                          label: s,
                        })),
                      ],
                    },
                    {
                      label: "Door Type",
                      value: filters.doorType,
                      key: "doorType" as const,
                      options: [
                        { value: "", label: "All Types" },
                        ...filterOptions.doorTypes.map((t) => ({
                          value: t,
                          label: t,
                        })),
                      ],
                    },
                    {
                      label: "Fire Rating",
                      value: filters.fireRating,
                      key: "fireRating" as const,
                      options: [
                        { value: "", label: "All Ratings" },
                        ...filterOptions.fireRatings.map((r) => ({
                          value: r,
                          label: r,
                        })),
                      ],
                    },
                    {
                      label: "Hand",
                      value: filters.hand,
                      key: "hand" as const,
                      options: [
                        { value: "", label: "All" },
                        ...filterOptions.hands.map((h) => ({
                          value: h,
                          label: h,
                        })),
                      ],
                    },
                  ].map((f) => (
                    <div key={f.key}>
                      <label className="block text-xs text-slate-500 mb-1">
                        {f.label}
                      </label>
                      <select
                        value={f.value}
                        onChange={(e) => updateFilter(f.key, e.target.value)}
                        className="select-animated w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        {f.options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
                <div className="mt-3 text-xs text-slate-500">
                  Showing {filteredOpenings.length} of {openings.length}{" "}
                  openings
                </div>
              </div>
            )}

            {/* Openings Grid */}
            {loading ? (
              <div className="text-center py-12 text-slate-400">
                Loading...
              </div>
            ) : error ? (
              <div className="p-4 bg-red-900/20 border border-red-900 rounded-lg text-red-200">
                {error}
              </div>
            ) : filteredOpenings.length === 0 ? (
              <div className="text-center py-12 text-slate-400">
                {openings.length === 0
                  ? "No openings found"
                  : "No openings match your filters"}
              </div>
            ) : (
              <div className="card-grid grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {filteredOpenings.map((opening) => {
                  const progressPercent =
                    opening.total_items > 0
                      ? (opening.checked_items / opening.total_items) * 100
                      : 0;
                  return (
                    <div
                      key={opening.id}
                      onClick={(e) => handleCardClick(e, opening.id)}
                      className="card-press relative overflow-hidden bg-slate-900 rounded-xl border border-slate-800 p-6 hover:border-blue-500/50 cursor-pointer"
                    >
                      {/* Completion indicator strip */}
                      <div
                        className="absolute top-0 left-0 h-1 rounded-t-xl transition-all duration-500"
                        style={{
                          width: `${progressPercent}%`,
                          backgroundColor:
                            progressPercent === 100
                              ? "#22c55e"
                              : progressPercent > 50
                                ? "#3b82f6"
                                : "#f59e0b",
                        }}
                      />

                      <h2 className="text-2xl font-bold text-white mb-2">
                        Door {opening.door_number}
                      </h2>
                      <div className="flex flex-wrap gap-2 mb-2">
                        {opening.hw_set && (
                          <span className="tag-chip text-xs bg-slate-800 text-slate-300 px-2 py-0.5 rounded-full border border-slate-700">
                            {opening.hw_set}
                          </span>
                        )}
                        {opening.door_type && (
                          <span className="tag-chip text-xs bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full border border-slate-700">
                            {opening.door_type}
                          </span>
                        )}
                        {opening.fire_rating && (
                          <span className="tag-chip text-xs bg-orange-900/40 text-orange-300 px-2 py-0.5 rounded-full border border-orange-800/40">
                            {opening.fire_rating}
                          </span>
                        )}
                        {opening.hand && (
                          <span className="tag-chip text-xs bg-slate-800 text-slate-500 px-2 py-0.5 rounded-full border border-slate-700">
                            {opening.hand}
                          </span>
                        )}
                      </div>
                      {opening.location && (
                        <p className="text-slate-400 text-sm mb-4">
                          {opening.location}
                        </p>
                      )}

                      <div className="mb-2">
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
