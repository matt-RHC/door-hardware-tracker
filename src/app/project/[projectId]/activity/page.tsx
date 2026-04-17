"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter, useParams } from "next/navigation"
import OfflineIndicator from "@/components/OfflineIndicator"
import { ACTION_LABELS } from "@/lib/constants/activity-actions"

interface ActivityEntry {
  id: string
  project_id: string
  user_id: string | null
  action: string
  entity_type: string | null
  entity_id: string | null
  details: Record<string, unknown>
  created_at: string
}

type ActionCategory = 'workflow' | 'damage' | 'sync' | 'edit' | 'extraction'

function getActionCategory(action: string): ActionCategory {
  if (action.startsWith('item_received') || action.startsWith('item_installed') ||
      action.startsWith('item_pre_install') || action.startsWith('item_qa_') ||
      action.startsWith('item_checked') || action.startsWith('item_unchecked') ||
      action.includes('_undone')) {
    return 'workflow'
  }
  if (action.startsWith('damage_') || action.startsWith('issue_')) return 'damage'
  if (action.startsWith('offline_sync_')) return 'sync'
  if (action.startsWith('extraction_')) return 'extraction'
  return 'edit'
}

function getCategoryColor(category: ActionCategory): string {
  switch (category) {
    case 'workflow': return 'var(--green)'
    case 'damage': return 'var(--danger)'
    case 'sync': return 'var(--blue)'
    case 'extraction': return 'var(--purple)'
    case 'edit': return 'var(--tertiary)'
  }
}

function formatRelativeTime(dateStr: string): string {
  const now = new Date()
  const date = new Date(dateStr)
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHr = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHr / 24)

  if (diffSec < 60) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHr < 24) return `${diffHr}h ago`
  if (diffDay < 7) return `${diffDay}d ago`
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function getActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, ' ')
}

function getEntityLabel(entry: ActivityEntry): string {
  const details = entry.details ?? {}
  if (details.opening_id) {
    return `Opening ${(details.opening_id as string).slice(0, 8)}…`
  }
  if (entry.entity_type === 'hardware_item' && details.original_name) {
    return String(details.original_name)
  }
  if (entry.entity_id) {
    return `${entry.entity_type ?? 'item'} ${entry.entity_id.slice(0, 8)}…`
  }
  return ''
}

const ENTITY_TYPES = [
  { value: '', label: 'All Types' },
  { value: 'opening', label: 'Opening' },
  { value: 'hardware_item', label: 'Hardware Item' },
  { value: 'checklist_progress', label: 'Checklist' },
  { value: 'extraction_job', label: 'Extraction' },
  { value: 'project_member', label: 'Member' },
  { value: 'delivery', label: 'Delivery' },
  { value: 'issue', label: 'Issue' },
]

export default function ActivityLogPage() {
  const params = useParams()
  const projectId = params.projectId as string
  const router = useRouter()

  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const [actionFilter, setActionFilter] = useState('')
  const [entityTypeFilter, setEntityTypeFilter] = useState('')

  const LIMIT = 50

  const fetchActivity = useCallback(async (pageNum: number, append: boolean) => {
    try {
      if (append) setLoadingMore(true)
      else setLoading(true)

      const queryParams = new URLSearchParams({
        page: String(pageNum),
        limit: String(LIMIT),
      })
      if (actionFilter) queryParams.set('action', actionFilter)
      if (entityTypeFilter) queryParams.set('entity_type', entityTypeFilter)

      const res = await fetch(`/api/projects/${projectId}/activity?${queryParams}`)
      if (!res.ok) throw new Error('Failed to fetch activity')

      const json = await res.json()
      if (append) {
        setEntries(prev => [...prev, ...json.data])
      } else {
        setEntries(json.data)
      }
      setTotal(json.total)
      setHasMore(json.data.length === LIMIT)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [projectId, actionFilter, entityTypeFilter])

  useEffect(() => {
    setPage(1)
    fetchActivity(1, false)
  }, [fetchActivity])

  const loadMore = () => {
    const nextPage = page + 1
    setPage(nextPage)
    fetchActivity(nextPage, true)
  }

  const actionOptions = Object.entries(ACTION_LABELS).map(([value, label]) => ({
    value,
    label,
  }))

  return (
    <div className="min-h-screen" style={{ background: "var(--background)" }}>
      <OfflineIndicator />
      <main className="max-w-4xl mx-auto px-4 py-6 sm:py-8">
        <div className="mb-6">
          <button
            onClick={() => router.push(`/project/${projectId}`)}
            className="text-accent hover:text-accent/80 mb-3 text-[13px] flex items-center gap-1 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Project
          </button>
          <h1
            className="text-xl sm:text-2xl font-bold text-primary mb-2 pb-3 border-b border-th-border"
            style={{ fontFamily: "var(--font-display)", letterSpacing: "0.02em" }}
          >
            ACTIVITY LOG
          </h1>
          <p className="text-[13px] text-tertiary">
            {total} total {total === 1 ? 'entry' : 'entries'}
          </p>
        </div>

        <div className="panel p-4 rounded-md mb-5">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1">
              <label className="block text-[11px] text-tertiary mb-1.5 uppercase tracking-wider">Action</label>
              <select
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value)}
                className="input-field text-[13px] py-2 w-full"
              >
                <option value="">All Actions</option>
                {actionOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-[11px] text-tertiary mb-1.5 uppercase tracking-wider">Entity Type</label>
              <select
                value={entityTypeFilter}
                onChange={(e) => setEntityTypeFilter(e.target.value)}
                className="input-field text-[13px] py-2 w-full"
              >
                {ENTITY_TYPES.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20 gap-3">
            <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-[13px] text-tertiary">Loading activity...</span>
          </div>
        ) : error ? (
          <div className="p-4 bg-danger-dim border border-danger rounded-md text-danger text-[14px]">{error}</div>
        ) : entries.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-[15px] text-secondary mb-1">No activity found</p>
            <p className="text-[13px] text-tertiary">Activity will appear here as team members interact with the project</p>
          </div>
        ) : (
          <div className="space-y-0">
            {entries.map((entry) => {
              const category = getActionCategory(entry.action)
              const dotColor = getCategoryColor(category)
              const entityLabel = getEntityLabel(entry)

              return (
                <div key={entry.id} className="flex items-start gap-3 py-3 border-b border-th-border last:border-b-0">
                  <div className="pt-1 shrink-0">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: dotColor }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-[13px] text-primary font-medium">{getActionLabel(entry.action)}</span>
                      {entityLabel && <span className="text-[12px] text-tertiary truncate">{entityLabel}</span>}
                    </div>
                    {entry.user_id && (
                      <p className="text-[11px] text-tertiary mt-0.5">by {entry.user_id.slice(0, 8)}…</p>
                    )}
                  </div>
                  <span className="text-[11px] text-tertiary shrink-0 tabular-nums pt-0.5">
                    {formatRelativeTime(entry.created_at)}
                  </span>
                </div>
              )
            })}

            {hasMore && (
              <div className="pt-4 text-center">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="glow-btn glow-btn--ghost text-[13px] rounded px-4 py-2"
                >
                  {loadingMore ? (
                    <span className="flex items-center gap-2">
                      <div className="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                      Loading...
                    </span>
                  ) : 'Load more'}
                </button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
