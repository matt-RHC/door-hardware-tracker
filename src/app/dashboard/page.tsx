"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import OfflineIndicator from "@/components/OfflineIndicator";
import { Project } from "@/lib/types/database";

interface ProjectFormData {
  name: string;
  job_number: string;
  general_contractor: string;
  architect: string;
  address: string;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [formData, setFormData] = useState<ProjectFormData>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetchProjects();
  }, []);

  // Close menu on outside click
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
        // Update existing
        const res = await fetch(`/api/projects/${editingProject.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        if (!res.ok) throw new Error("Failed to update project");
      } else {
        // Create new
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        if (!res.ok) throw new Error("Failed to create project");
      }
      setShowModal(false);
      fetchProjects();
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    }
  };

  return (
    <div className="min-h-screen bg-slate-950">
      <OfflineIndicator />
      <Navbar />

      <main className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold text-white">Projects</h1>
          <button
            onClick={openNewProject}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded transition-colors"
          >
            New Project
          </button>
        </div>

        {loading ? (
          <div className="text-center py-12 text-slate-400">Loading...</div>
        ) : error ? (
          <div className="p-4 bg-red-900/20 border border-red-900 rounded text-red-200 mb-4">
            {error}
            <button
              onClick={() => setError(null)}
              className="ml-4 text-red-400 hover:text-red-300 text-sm"
            >
              Dismiss
            </button>
          </div>
        ) : projects.length === 0 ? (
          <div className="text-center py-12 text-slate-400">
            No projects yet. Create one to get started!
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects.map((project) => (
              <div
                key={project.id}
                onClick={() => router.push(`/project/${project.id}`)}
                className="bg-slate-900 rounded-lg border border-slate-800 p-6 hover:border-blue-500 cursor-pointer transition-colors relative"
              >
                {/* Actions menu - z-10 and stopPropagation prevent card navigation */}
                <div
                  className="absolute top-2 right-2 z-10"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() =>
                      setMenuOpen(menuOpen === project.id ? null : project.id)
                    }
                    className="p-2 text-slate-500 hover:text-slate-300 hover:bg-slate-800 rounded transition-colors"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-5 w-5"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                    </svg>
                  </button>

                  {menuOpen === project.id && (
                    <div className="absolute right-0 mt-1 w-36 bg-slate-800 border border-slate-700 rounded shadow-lg z-20">
                      <button
                        onClick={() => openEditProject(project)}
                        className="w-full text-left px-4 py-2 text-sm text-slate-300 hover:bg-slate-700 transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => {
                          setDeleteConfirm(project.id);
                          setMenuOpen(null);
                        }}
                        className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-slate-700 transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>

                <h2 className="text-xl font-bold text-white mb-2 pr-8">
                  {project.name}
                </h2>
                {project.general_contractor && (
                  <p className="text-slate-400 text-sm mb-1">
                    GC: {project.general_contractor}
                  </p>
                )}
                {project.job_number && (
                  <p className="text-slate-500 text-xs mb-4">
                    Job #{project.job_number}
                  </p>
                )}
                <div className="text-sm text-slate-400">
                  {project.address || ""}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* New / Edit Project Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-lg w-full max-w-md p-6">
            <h2 className="text-xl font-bold text-white mb-4">
              {editingProject ? "Edit Project" : "New Project"}
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  Project Name *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g. Radius DC Project"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  Job Number
                </label>
                <input
                  type="text"
                  value={formData.job_number}
                  onChange={(e) =>
                    setFormData({ ...formData, job_number: e.target.value })
                  }
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g. 2026-001"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  General Contractor
                </label>
                <input
                  type="text"
                  value={formData.general_contractor}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      general_contractor: e.target.value,
                    })
                  }
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g. Turner Construction"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  Architect
                </label>
                <input
                  type="text"
                  value={formData.architect}
                  onChange={(e) =>
                    setFormData({ ...formData, architect: e.target.value })
                  }
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g. Gensler"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">
                  Address
                </label>
                <input
                  type="text"
                  value={formData.address}
                  onChange={(e) =>
                    setFormData({ ...formData, address: e.target.value })
                  }
                  className="w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g. 1234 Main St, Washington DC"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !formData.name.trim()}
                className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:text-blue-400 text-white rounded transition-colors"
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

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-lg w-full max-w-sm p-6">
            <h2 className="text-xl font-bold text-white mb-2">
              Delete Project?
            </h2>
            <p className="text-slate-400 text-sm mb-6">
              This will permanently delete this project and all its openings,
              hardware items, and checklist data. This cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
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
