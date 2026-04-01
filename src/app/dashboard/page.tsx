"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Navbar from "@/components/Navbar";
import OfflineIndicator from "@/components/OfflineIndicator";
import { Project } from "@/lib/types/database";

export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetchProjects();
  }, []);

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

  return (
    <div className="min-h-screen bg-slate-950">
      <OfflineIndicator />
      <Navbar />

      <main className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold text-white">Projects</h1>
          <button
            onClick={() => {
              /* TODO: Open new project modal */
            }}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded transition-colors"
          >
            New Project
          </button>
        </div>

        {loading ? (
          <div className="text-center py-12 text-slate-400">Loading...</div>
        ) : error ? (
          <div className="p-4 bg-red-900/20 border border-red-900 rounded text-red-200">
            {error}
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
                className="bg-slate-900 rounded-lg border border-slate-800 p-6 hover:border-blue-500 cursor-pointer transition-colors"
              >
                <h2 className="text-xl font-bold text-white mb-2">
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
                <div className="flex justify-between items-center text-sm">
                  <span className="text-slate-400">
                    {project.address || ""}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      /* TODO: Open PDF upload modal */
                    }}
                    className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-xs"
                  >
                    Upload PDF
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
