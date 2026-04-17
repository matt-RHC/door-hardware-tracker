"use client";

import { useEffect, useState, FormEvent } from "react";
import Link from "next/link";

interface Company {
  id: string;
  name: string;
  slug: string;
  created_at: string;
}

export default function AdminCompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [creating, setCreating] = useState(false);

  async function loadCompanies() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/companies");
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { companies: Company[] };
      setCompanies(data.companies);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCompanies();
  }, []);

  async function createCompany(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, slug }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? `HTTP ${res.status}`);
        return;
      }
      setName("");
      setSlug("");
      void loadCompanies();
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="min-h-screen w-full bg-background p-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-bold text-primary mb-6" style={{ fontFamily: "var(--font-display)" }}>
          COMPANIES
        </h1>

        <form onSubmit={createCompany} className="panel p-4 mb-8 flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Company name (e.g. DPR Construction)"
            required
            className="input-field flex-1"
          />
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            placeholder="slug (e.g. dpr-construction)"
            pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]"
            required
            className="input-field flex-1"
          />
          <button
            type="submit"
            disabled={creating}
            className="glow-btn--primary rounded px-4 disabled:opacity-40"
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </form>

        {error && (
          <div className="mb-4 p-3 bg-danger-dim border border-danger rounded text-danger text-sm">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-tertiary">Loading…</p>
        ) : companies.length === 0 ? (
          <p className="text-tertiary">No companies yet.</p>
        ) : (
          <ul className="space-y-2">
            {companies.map((c) => (
              <li key={c.id} className="panel p-4 flex items-center justify-between">
                <div>
                  <p className="text-primary font-semibold">{c.name}</p>
                  <p className="text-tertiary text-xs font-mono">{c.slug}</p>
                </div>
                <Link
                  href={`/admin/companies/${c.id}`}
                  className="text-accent hover:text-accent/80 text-sm"
                >
                  Manage →
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
