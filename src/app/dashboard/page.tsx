"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import OfflineIndicator from "@/components/OfflineIndicator";
import ProgressBar from "@/components/ProgressBar";
import { Project } from "@/lib/types/database";
import { playClick, playSuccess, playHover } from "@/lib/sounds";

interface ProjectFormData {
  name: string;
  job_number: string;
  general_contractor: string;
  architect: string;
  address: string;
}

interface ProjectStats {
  project_id: string;
  openings_total: number;
  openings_complete: number;
  openings_incomplete: number;
  items_total: number;
  items_checked: number;
  completion_pct: number;
}

interface PortfolioTotals {
  projects: number;
  openings: number;
  openings_complete: number;
  items_total: number;
  items_checked: number;
  completion_pct: number;
}

const emptyForm: ProjectFormData = {
  name: "",
  job_number: "",
  general_contractor: "",
  architect: "",
  address: "",
};

export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [statsByProject, setStatsByProject] = useState<Record<string, ProjectStats>>({});
  const [totals, setTotals] = useState<PortfolioTotals | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [formData, setFormData] = useState<ProjectFormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [syncingPortfolio, setSyncingPortfolio] = useState(false);
  const [portfolioResult, setPortfolioResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetchProjects();
    fetchPortfolioStats();
  }, []);

  useEffect(() => {
    const handleClick = () => setMenuOpen(null);
    if (menuOpen) document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [menuOpen]);

  const fetchProjects = async () => {
    try {
      const response = await fetch("/api/projects");
      if (!response.ok) throw new Error("Failed to fetch projects");
      const data = await response.json();
      setProjects(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const fetchPortfolioStats = async () => {
    try {
      const response = await fetch("/api/portfolio/stats");
      if (!response.ok) return;
      const data = await response.json();
      const map: Record<string, ProjectStats> = {};
      for (const p of (data.projects ?? []) as ProjectStats[]) {
        map[p.project_id] = p;
      }
      setStatsByProject(map);
      setTotals(data.totals ?? null);
    } catch (err) {
      console.error("Failed to fetch portfolio stats", err);
    } finally {
      setStatsLoading(false);
    }
  };

  const syncPortfolio = async () => {
    setSyncingPortfolio(true);
    setPortfolioResult(null);
    try {
      const res = await fetch("/api/portfolio/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setPortfolioResult({
          success: false,
          message: data.error || "Sync failed",
        });
      } else {
        playSuccess();
        setPortfolioResult({
          success: true,
          message: `Portfolio synced: ${data.projectCount} projects`,
        });
      }
    } catch (err) {
      setPortfolioResult({
        success: false,
        message: err instanceof Error ? err.message : "Sync failed",
      });
    } finally {
      setSyncingPortfolio(false);
    }
  };

  const openNewProject = () => {
    setEditingProject(null);
    setFormData(emptyForm);
    setShowModal(true);
  };

  const openEditProject = (project: Project) => {
    setEditingProject(project);
    setFormData({
      name: project.name,
      job_number: project.job_number || "",
      general_contractor: project.general_contractor || "",
      architect: project.architect || "",
      address: project.address || "",
    });
    setShowModal(true);
    setMenuOpen(null);
  };

  const handleSave = async () => {
    if (!formData.name.trim()) return;
    setSaving(true);
    try {
      if (editingProject) {
        const res = await fetch(`/api/projects/${editingProject.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        if (!res.ok) throw new Error("Failed to update project");
      } else {
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        if (!res.ok) throw new Error("Failed to create project");
      }
      setShowModal(false);
      fetchProjects();
      fetchPortfolioStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (projectId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete project");
      setDeleteConfirm(null);
      fetchProjects();
      fetchPortfolioStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    }
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--background)" }}>
      <OfflineIndicator />
      <Navbar />

      <main className="max-w-7xl mx-auto px-4 py-6 sm:py-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
          <div>
            <h1
              className="text-2xl sm:text-3xl font-bold text-[var(--text-primary)]"
              style={{ fontFamily: "var(--font-display)", letterSpacing: "0.02em" }}
            >
              PROJECTS
            </h1>
            <p className="text-[13px] text-[var(--text-tertiary)] mt-1">
              {projects.length} active project{projects.length !== 1 ? "s" : ""}
            </p>
          </div>
          <div className="flex gap-2 w-full sm:w-auto">
            <button
              onClick={() => {
                playClick();
                syncPortfolio();
              }}
              disabled={syncingPortfolio}
              className="glow-btn--success flex-1 sm:flex-none text-[13px] rounded-lg"
              style={{ padding: "0.5rem 1rem" }}
            >
              {syncingPortfolio ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-[var(--green)] border-t-transparent rounded-full animate-spin" />
                  Syncing...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Sync
                </>
              )}
            </button>
            <button
              onClick={() => {
                playClick();
                openNewProject();
              }}
              className="glow-btn--primary flex-1 sm:flex-none text-[13px] rounded-lg"
              style={{ padding: "0.5rem 1rem" }}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              New Project
            </button>
          </div>
        </div>

        {/* Portfolio summary */}
        {!statsLoading && totals && totals.projects > 0 && (
          <div className="panel corner-brackets p-4 sm:p-5 rounded-lg mb-5 animate-fade-in-up">
            <div className="flex items-center justify-between mb-3">
              <span
                className="text-[12px] text-[var(--text-secondary)] uppercase tracking-wider"
                style={{ fontFamily: "var(--font-display)", letterSpacing: "0.08em" }}
              >
                Portfolio Overview
              </span>
              <span className="text-[12px] text-[var(--text-tertiary)] tabular-nums">
                {totals.openings_complete} / {totals.openings} openings complete
              </span>
            </div>
            <ProgressBar value={totals.completion_pct} size="lg" showLabel={false} />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
              <div className="text-center sm:text-left">
                <div
                  className="text-[22px] font-bold text-[var(--text-primary)] tabular-nums"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {totals.projects}
                </div>
                <div className="text-[11px] text-[var(--text-tertiary)] uppercase tracking-wider mt-0.5">
                  Projects
                </div>
              </div>
              <div className="text-center sm:text-left">
                <div
                  className="text-[22px] font-bold text-[var(--text-primary)] tabular-nums"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {totals.openings}
                </div>
                <div className="text-[11px] text-[var(--text-tertiary)] uppercase tracking-wider mt-0.5">
                  Openings
                </div>
              </div>
              <div className="text-center sm:text-left">
                <div
                  className="text-[22px] font-bold text-[var(--green)] tabular-nums"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {totals.completion_pct}%
                </div>
                <div className="text-[11px] text-[var(--text-tertiary)] uppercase tracking-wider mt-0.5">
                  Complete
                </div>
              </div>
              <div className="text-center sm:text-left">
                <div
                  className="text-[22px] font-bold text-[var(--orange)] tabular-nums"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {totals.openings - totals.openings_complete}
                </div>
                <div className="text-[11px] text-[var(--text-tertiary)] uppercase tracking-wider mt-0.5">
                  Outstanding
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Sync result banner */}
        {portfolioResult && (
          <div
            className={`mb-5 p-3 rounded-lg flex items-center justify-between text-[13px] border animate-fade-in-up ${
              portfolioResult.success
                ? "bg-[rgba(48,209,88,0.08)] border-[rgba(48,209,88,0.15)] text-[var(--green)]"
                : "bg-[rgba(255,69,58,0.08)] border-[rgba(255,69,58,0.15)] text-[var(--red)]"
            }`}
          >
            <span>{portfolioResult.message}</span>
            <button
              onClick={() => setPortfolioResult(null)}
              className="text-current opacity-50 hover:opacity-100 transition-opacity ml-3"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-20 gap-3">
            <div className="w-5 h-5 border-2 border-[var(--blue)] border-t-transparent rounded-full animate-spin" />
            <span className="text-[13px] text-[var(--text-tertiary)]">Loading projects...</span>
          </div>
        ) : error ? (
          <div className="p-4 bg-[rgba(255,69,58,0.08)] border border-[rgba(255,69,58,0.15)] rounded-lg text-[var(--red)] text-[14px] mb-4 flex items-center justify-between">
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              className="text-[var(--red)]/60 hover:text-[var(--red)] text-sm ml-4"
            >
              Dismiss
            </button>
          </div>
        ) : projects.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-16 h-16 mx-auto mb-4 rounded-xl bg-[rgba(10,132,255,0.06)] border border-[rgba(10,132,255,0.12)] flex items-center justify-center">
              <svg className="w-7 h-7 text-[var(--blue)]/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            </div>
            <p className="text-[15px] text-[var(--text-secondary)] mb-1">No projects yet</p>
            <p className="text-[13px] text-[var(--text-tertiary)]">Create one to start tracking door hardware</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 stagger-children">
            {projects.map((project) => (
              <div
                key={project.id}
                onClick={() => {
                  playClick();
                  router.push(`/project/${project.id}`);
                }}
                onMouseEnter={() => playHover()}
                className="glow-card glow-card--cyan cursor-pointer p-5 relative group"
              >
                {/* Actions menu */}
                <div
                  className="absolute top-3 right-3 z-10"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() =>
                      setMenuOpen(menuOpen === project.id ? null : project.id)
                    }
                    className="w-8 h-8 rounded-md flex items-center justify-center text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] transition-all"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                    </svg>
                  </button>

                  {menuOpen === project.id && (
                    <div className="absolute right-0 mt-1 w-36 panel rounded-lg shadow-xl z-20 overflow-hidden animate-fade-in-up">
                      <button
                        onClick={() => openEditProject(project)}
                        className="w-full text-left px-4 py-2.5 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] transition-colors"
                      >
                        Edit
                      </button>
                      <div className="divider" />
                      <button
                        onClick={() => {
                          setDeleteConfirm(project.id);
                          setMenuOpen(null);
                        }}
                        className="w-full text-left px-4 py-2.5 text-[13px] text-[var(--red)] hover:bg-[rgba(255,69,58,0.06)] transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>

                {/* Project info */}
                <h2 className="text-[16px] font-semibold text-[var(--text-primary)] mb-2 pr-8 leading-snug">
                  {project.name}
                </h2>
                {project.general_contractor && (
                  <p className="text-[13px] text-[var(--text-secondary)] mb-0.5 flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5 text-[var(--text-tertiary)] shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                    </svg>
                    {project.general_contractor}
                  </p>
                )}
                {project.job_number && (
                  <p className="text-[12px] text-[var(--text-tertiary)] mb-3 flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5 text-[var(--text-tertiary)] shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
                    </svg>
                    {project.job_number}
                  </p>
                )}
                {project.address && (
                  <p className="text-[12px] text-[var(--text-tertiary)] flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5 text-[var(--text-tertiary)] shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    <span className="truncate">{project.address}</span>
                  </p>
                )}

                {/* Progress */}
                {(() => {
                  const s = statsByProject[project.id];
                  if (!s || s.openings_total === 0) {
                    return (
                      <div className="mt-4 pt-3 border-t border-[var(--border)]">
                        <div className="text-[11px] text-[var(--text-tertiary)] uppercase tracking-wider">
                          {statsLoading ? "Loading..." : "No openings yet"}
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div className="mt-4 pt-3 border-t border-[var(--border)]">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[11px] text-[var(--text-tertiary)] uppercase tracking-wider">
                          Progress
                        </span>
                        <span className="text-[12px] text-[var(--text-secondary)] tabular-nums font-semibold">
                          {s.completion_pct}%
                        </span>
                      </div>
                      <ProgressBar value={s.completion_pct} size="sm" showLabel={false} />
                      <div className="flex items-center justify-between mt-1.5 text-[11px] text-[var(--text-tertiary)] tabular-nums">
                        <span>
                          {s.openings_complete} / {s.openings_total} openings
                        </span>
                        {s.openings_incomplete > 0 && (
                          <span className="text-[var(--orange)]">
                            {s.openings_incomplete} outstanding
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Bottom arrow hint on hover */}
                <div className="absolute bottom-3 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                  <svg className="w-4 h-4 text-[var(--blue)]/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* ── New / Edit Project Modal ── */}
      {showModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="panel corner-brackets w-full max-w-md p-6 animate-fade-in-up">
            <h2
              className="text-lg font-bold text-[var(--text-primary)] mb-5"
              style={{ fontFamily: "var(--font-display)", letterSpacing: "0.02em" }}
            >
              {editingProject ? "EDIT PROJECT" : "NEW PROJECT"}
            </h2>

            <div className="space-y-3.5">
              {[
                { label: "Project Name", key: "name", placeholder: "e.g. Radius DC Project", required: true },
                { label: "Job Number", key: "job_number", placeholder: "e.g. 2026-001" },
                { label: "General Contractor", key: "general_contractor", placeholder: "e.g. Turner Construction" },
                { label: "Architect", key: "architect", placeholder: "e.g. Gensler" },
                { label: "Address", key: "address", placeholder: "e.g. 1234 Main St, Nashville TN" },
              ].map((field) => (
                <div key={field.key}>
                  <label className="block text-[12px] text-[var(--text-secondary)] mb-1.5 uppercase tracking-wider">
                    {field.label} {field.required && <span className="text-[var(--blue)]">*</span>}
                  </label>
                  <input
                    type="text"
                    value={formData[field.key as keyof ProjectFormData]}
                    onChange={(e) =>
                      setFormData({ ...formData, [field.key]: e.target.value })
                    }
                    className="input-field"
                    placeholder={field.placeholder}
                  />
                </div>
              ))}
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowModal(false)}
                className="glow-btn--ghost flex-1 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !formData.name.trim()}
                className="glow-btn--primary flex-1 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {saving
                  ? "Saving..."
                  : editingProject
                  ? "Save Changes"
                  : "Create Project"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete Confirmation Modal ── */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="panel w-full max-w-sm p-6 animate-fade-in-up">
            <h2
              className="text-lg font-bold text-[var(--text-primary)] mb-2"
              style={{ fontFamily: "var(--font-display)", letterSpacing: "0.02em" }}
            >
              DELETE PROJECT?
            </h2>
            <p className="text-[13px] text-[var(--text-secondary)] mb-6 leading-relaxed">
              This will permanently delete this project and all its openings,
              hardware items, and checklist data. This cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="glow-btn--ghost flex-1 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                className="glow-btn--danger flex-1 rounded-lg"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
