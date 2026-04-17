"use client";

import { useEffect, useState, FormEvent, use } from "react";
import Link from "next/link";

type PreferredProvider = "google" | "azure" | null;

interface DomainRow {
  id: string;
  domain: string;
  verified_at: string | null;
  created_at: string;
  preferred_provider: PreferredProvider;
}

interface MemberRow {
  company_id: string;
  user_id: string;
  role: "owner" | "admin" | "member";
  is_default: boolean;
  joined_at: string;
}

export default function AdminCompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [domainInput, setDomainInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const [dRes, mRes] = await Promise.all([
        fetch(`/api/admin/companies/${id}/domains`),
        fetch(`/api/admin/companies/${id}/members`),
      ]);
      if (!dRes.ok || !mRes.ok) {
        setError(`Failed to load (domains HTTP ${dRes.status}, members HTTP ${mRes.status})`);
        return;
      }
      const dData = (await dRes.json()) as { domains: DomainRow[] };
      const mData = (await mRes.json()) as { members: MemberRow[] };
      setDomains(dData.domains);
      setMembers(mData.members);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function addDomain(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch(`/api/admin/companies/${id}/domains`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: domainInput }),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      setError(payload.error ?? `HTTP ${res.status}`);
      return;
    }
    setDomainInput("");
    void reload();
  }

  async function removeDomain(domainId: string) {
    await fetch(`/api/admin/companies/${id}/domains?domain_id=${domainId}`, {
      method: "DELETE",
    });
    void reload();
  }

  async function updateDomainProvider(domainId: string, value: string) {
    // "" from the <select> means "auto-detect" → clear the override (null).
    const preferred_provider: PreferredProvider =
      value === "google" || value === "azure" ? value : null;
    const res = await fetch(`/api/admin/companies/${id}/domains`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain_id: domainId, preferred_provider }),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      setError(payload.error ?? `HTTP ${res.status}`);
      return;
    }
    void reload();
  }

  async function updateRole(userId: string, role: "owner" | "admin" | "member") {
    await fetch(`/api/admin/companies/${id}/members`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, role }),
    });
    void reload();
  }

  async function removeMember(userId: string) {
    await fetch(`/api/admin/companies/${id}/members?user_id=${userId}`, {
      method: "DELETE",
    });
    void reload();
  }

  return (
    <div className="min-h-screen w-full bg-background p-8">
      <div className="mx-auto max-w-3xl">
        <Link href="/admin/companies" className="text-accent hover:text-accent/80 text-sm">
          ← All companies
        </Link>

        <h1 className="text-2xl font-bold text-primary mb-6 mt-3" style={{ fontFamily: "var(--font-display)" }}>
          COMPANY {id.slice(0, 8)}
        </h1>

        {error && (
          <div className="mb-4 p-3 bg-danger-dim border border-danger rounded text-danger text-sm">
            {error}
          </div>
        )}

        <section className="panel p-6 mb-8">
          <h2 className="text-lg font-semibold text-primary mb-4">Domains</h2>
          <form onSubmit={addDomain} className="flex gap-3 mb-4">
            <input
              type="text"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value.toLowerCase())}
              placeholder="dpr.com"
              className="input-field flex-1"
              required
            />
            <button type="submit" className="glow-btn--primary rounded px-4">
              Add domain
            </button>
          </form>
          {loading ? (
            <p className="text-tertiary">Loading…</p>
          ) : domains.length === 0 ? (
            <p className="text-tertiary">No domains registered.</p>
          ) : (
            <ul className="divide-y divide-border-dim">
              {domains.map((d) => (
                <li key={d.id} className="flex items-center justify-between py-2">
                  <code className="text-primary">{d.domain}</code>
                  <div className="flex items-center gap-3">
                    <select
                      value={d.preferred_provider ?? ""}
                      onChange={(e) => updateDomainProvider(d.id, e.target.value)}
                      className="input-field py-1 text-xs"
                      aria-label={`OAuth provider for ${d.domain}`}
                    >
                      <option value="">Auto-detect (default)</option>
                      <option value="google">Google Workspace</option>
                      <option value="azure">Microsoft 365</option>
                    </select>
                    <button
                      onClick={() => removeDomain(d.id)}
                      className="text-danger text-xs hover:underline"
                    >
                      remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel p-6">
          <h2 className="text-lg font-semibold text-primary mb-4">Members</h2>
          {members.length === 0 ? (
            <p className="text-tertiary">No members yet.</p>
          ) : (
            <ul className="divide-y divide-border-dim">
              {members.map((m) => (
                <li key={m.user_id} className="flex items-center justify-between py-2">
                  <code className="text-primary text-xs">{m.user_id}</code>
                  <div className="flex items-center gap-3">
                    <select
                      value={m.role}
                      onChange={(e) =>
                        updateRole(m.user_id, e.target.value as MemberRow["role"])
                      }
                      className="input-field py-1 text-xs"
                    >
                      <option value="owner">owner</option>
                      <option value="admin">admin</option>
                      <option value="member">member</option>
                    </select>
                    <button
                      onClick={() => removeMember(m.user_id)}
                      className="text-danger text-xs hover:underline"
                    >
                      remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
