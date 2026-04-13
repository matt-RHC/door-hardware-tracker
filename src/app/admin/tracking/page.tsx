"use client"

// /admin/tracking — read-only dashboard for the unified tracking_items table.
//
// Milestone 1 deliverable. Shows three tabs (Plan Items / Sessions / Metrics)
// and two admin buttons to trigger import and git-walk status refresh.
//
// Styling uses the project's CSS variable theme system from globals.css so it
// works in both dark and light mode. Dark is default on :root, light applies
// via [data-theme="light"] — variables defined in both blocks.
//
// Admin access is enforced in the API routes. If a non-admin navigates here,
// /api/admin/tracking/items will return 403 and the page shows an error state.

import { useEffect, useState } from 'react'
import type { TrackingItem } from '@/lib/types/database'

type TabKey = 'plan_item' | 'session' | 'metric_run'

const TAB_LABELS: Record<TabKey, string> = {
  plan_item: 'Plan Items',
  session: 'Sessions',
  metric_run: 'Metrics',
}

interface ApiResponse {
  items: TrackingItem[]
  count: number
}

interface ActionResult {
  label: string
  ok: boolean
  message: string
}

export default function AdminTrackingPage() {
  const [tab, setTab] = useState<TabKey>('plan_item')
  const [items, setItems] = useState<TrackingItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [actionResult, setActionResult] = useState<ActionResult | null>(null)

  useEffect(() => {
    void loadItems(tab)
  }, [tab])

  async function loadItems(recordType: TabKey) {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/tracking/items?type=${recordType}`)
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string }
        setError(payload.error ?? `HTTP ${res.status}`)
        setItems([])
        return
      }
      const data = (await res.json()) as ApiResponse
      setItems(data.items ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  async function runAction(label: string, path: string) {
    setRunning(label)
    setActionResult(null)
    try {
      const res = await fetch(path, { method: 'POST' })
      const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        setActionResult({
          label,
          ok: false,
          message: (payload.error as string | undefined) ?? `HTTP ${res.status}`,
        })
        return
      }
      setActionResult({
        label,
        ok: true,
        message: JSON.stringify(payload, null, 2),
      })
      await loadItems(tab)
    } catch (err) {
      setActionResult({
        label,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setRunning(null)
    }
  }

  return (
    <main className="min-h-screen bg-background text-primary p-6">
      <div className="max-w-7xl mx-auto">
        <header className="mb-6">
          <h1 className="font-display text-2xl tracking-wider text-info text-glow-cyan">
            Tracking Admin
          </h1>
          <p className="text-sm text-secondary mt-2">
            Unified view of plan items, sessions, and metric runs.
          </p>
        </header>

        <section className="mb-6 flex flex-wrap gap-3">
          <AdminButton
            label="Refresh status (dry run)"
            path="/api/admin/tracking/refresh-status?dryRun=1"
            running={running}
            onRun={runAction}
          />
          <AdminButton
            label="Refresh status"
            path="/api/admin/tracking/refresh-status"
            running={running}
            onRun={runAction}
          />
        </section>

        {actionResult ? (
          <section
            className={`mb-6 rounded-[var(--radius-sm)] border p-3 ${
              actionResult.ok
                ? 'border-success bg-success-dim'
                : 'border-danger bg-danger-dim'
            }`}
          >
            <div className="flex items-start justify-between">
              <span className="text-sm font-semibold text-primary">
                {actionResult.label}: {actionResult.ok ? 'OK' : 'FAILED'}
              </span>
              <button
                type="button"
                onClick={() => setActionResult(null)}
                className="text-xs text-tertiary hover:text-primary"
              >
                dismiss
              </button>
            </div>
            <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-secondary">
              {actionResult.message}
            </pre>
          </section>
        ) : null}

        <nav className="mb-4 flex gap-2 border-b border-th-border">
          {(Object.keys(TAB_LABELS) as TabKey[]).map(key => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm transition-colors ${
                tab === key
                  ? 'border-info text-info'
                  : 'border-transparent text-secondary hover:text-primary'
              }`}
            >
              {TAB_LABELS[key]}
            </button>
          ))}
        </nav>

        {loading ? (
          <p className="text-sm text-secondary">Loading…</p>
        ) : error ? (
          <p className="text-sm text-danger">Error: {error}</p>
        ) : items.length === 0 ? (
          <p className="text-sm italic text-tertiary">
            No {TAB_LABELS[tab].toLowerCase()} yet. Run the import to populate.
          </p>
        ) : (
          <ItemTable tab={tab} items={items} />
        )}
      </div>
    </main>
  )
}

function AdminButton({
  label,
  path,
  running,
  onRun,
}: {
  label: string
  path: string
  running: string | null
  onRun: (label: string, path: string) => void
}) {
  const isRunning = running === label
  return (
    <button
      type="button"
      onClick={() => onRun(label, path)}
      disabled={running !== null}
      className="rounded-[var(--radius-sm)] border border-info bg-info-dim px-4 py-2 text-sm text-info transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
    >
      {isRunning ? 'Running…' : label}
    </button>
  )
}

function ItemTable({ tab, items }: { tab: TabKey; items: TrackingItem[] }) {
  if (tab === 'plan_item') {
    return (
      <TableShell>
        <thead className="bg-surface-raised text-secondary">
          <tr>
            <Th>Title</Th>
            <Th>Status</Th>
            <Th>Priority</Th>
            <Th>Area</Th>
            <Th>Session Refs</Th>
            <Th>Resolved PR</Th>
            <Th>Relevance</Th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <tr
              key={item.id}
              className="border-t border-border-dim hover:bg-surface-hover"
            >
              <Td primary>{item.title}</Td>
              <Td>{item.status ?? '—'}</Td>
              <Td>{item.priority ?? '—'}</Td>
              <Td>{item.area ?? '—'}</Td>
              <Td muted>{(item.session_refs ?? []).join(', ') || '—'}</Td>
              <Td>{item.resolved_pr !== null ? `#${item.resolved_pr}` : '—'}</Td>
              <Td>{item.relevance ?? '—'}</Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    )
  }

  if (tab === 'session') {
    return (
      <TableShell>
        <thead className="bg-surface-raised text-secondary">
          <tr>
            <Th>Session</Th>
            <Th>Date</Th>
            <Th>Status</Th>
            <Th>Topics</Th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <tr
              key={item.id}
              className="border-t border-border-dim hover:bg-surface-hover"
            >
              <Td primary>{item.title}</Td>
              <Td>{item.date_identified ?? '—'}</Td>
              <Td>{item.session_status ?? item.status ?? '—'}</Td>
              <Td muted>{item.session_topics ?? item.notes ?? '—'}</Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    )
  }

  return (
    <TableShell>
      <thead className="bg-surface-raised text-secondary">
        <tr>
          <Th>Run</Th>
          <Th>PDF</Th>
          <Th>Doors (got / exp)</Th>
          <Th>Sets (got / exp)</Th>
          <Th>Accuracy %</Th>
          <Th>Commit</Th>
        </tr>
      </thead>
      <tbody>
        {items.map(item => (
          <tr
            key={item.id}
            className="border-t border-border-dim hover:bg-surface-hover"
          >
            <Td primary>{item.title}</Td>
            <Td>{item.metric_pdf_name ?? '—'}</Td>
            <Td>
              {item.metric_doors_extracted ?? '—'} / {item.metric_doors_expected ?? '—'}
            </Td>
            <Td>
              {item.metric_sets_extracted ?? '—'} / {item.metric_sets_expected ?? '—'}
            </Td>
            <Td>
              {item.metric_accuracy_pct !== null ? item.metric_accuracy_pct.toFixed(1) : '—'}
            </Td>
            <Td muted>{item.metric_build_commit?.slice(0, 7) ?? '—'}</Td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  )
}

function TableShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-sm)] border border-th-border">
      <table className="w-full text-sm">{children}</table>
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-left font-semibold">{children}</th>
}

function Td({
  children,
  primary,
  muted,
}: {
  children: React.ReactNode
  primary?: boolean
  muted?: boolean
}) {
  const colorClass = primary
    ? 'text-primary'
    : muted
      ? 'text-tertiary text-xs'
      : 'text-secondary'
  return <td className={`px-3 py-2 ${colorClass}`}>{children}</td>
}
