'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import StatusBadge from '@/components/issues/StatusBadge'
import SeverityBadge from '@/components/issues/SeverityBadge'
import KanbanBoard from '@/components/issues/KanbanBoard'
import ParseEmailModal from '@/components/issues/ParseEmailModal'
import { isOverdue } from '@/lib/utils/sla'
import type { IssueStatus, IssueSeverity } from '@/lib/types/database'

const ALL_STATUSES: IssueStatus[] = [
  'created', 'acknowledged', 'awaiting_action', 'blocked', 'resolved', 'duplicate', 'closed',
]

const ALL_SEVERITIES: IssueSeverity[] = ['critical', 'high', 'medium', 'low']

const CATEGORIES = [
  'hinges', 'locksets', 'closers', 'exit_devices', 'pulls', 'stops', 'thresholds',
  'weatherstripping', 'seals', 'coordinators', 'flush_bolts', 'other',
]

interface IssueRow {
  id: string
  title: string
  status: string
  severity: string
  category: string
  assigned_to: string | null
  due_at: string | null
  created_at: string
  comment_count: number
  attachment_count: number
}

interface IssuesResponse {
  data: IssueRow[]
  total: number
  page: number
  limit: number
}

const PAGE_SIZE = 25

export default function IssuesListPage() {
  const params = useParams()
  const projectId = params.projectId as string
  const router = useRouter()

  const [issues, setIssues] = useState<IssueRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [selectedStatuses, setSelectedStatuses] = useState<Set<IssueStatus>>(new Set())
  const [selectedSeverity, setSelectedSeverity] = useState<string>('')
  const [selectedCategory, setSelectedCategory] = useState<string>('')

  const [viewMode, setViewMode] = useState<'list' | 'board'>('list')
  const [showEmailModal, setShowEmailModal] = useState(false)

  const fetchIssues = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('page', String(page))
      params.set('limit', String(PAGE_SIZE))
      if (selectedStatuses.size > 0) {
        params.set('status', Array.from(selectedStatuses).join(','))
      }
      if (selectedSeverity) params.set('severity', selectedSeverity)
      if (selectedCategory) params.set('category', selectedCategory)

      const res = await fetch(`/api/projects/${projectId}/issues?${params.toString()}`)
      if (!res.ok) throw new Error('Failed to fetch issues')
      const data: IssuesResponse = await res.json()
      setIssues(data.data)
      setTotal(data.total)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }, [projectId, page, selectedStatuses, selectedSeverity, selectedCategory])

  useEffect(() => {
    fetchIssues()
  }, [fetchIssues])

  const toggleStatus = (status: IssueStatus) => {
    setSelectedStatuses((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
    setPage(1)
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="min-h-screen" style={{ background: 'var(--background)' }}>
      <main className="max-w-7xl mx-auto px-4 py-6 sm:py-8">
        {/* Header */}
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
          <div className="flex items-center justify-between pb-3 border-b border-th-border">
            <h1
              className="text-xl sm:text-2xl font-bold text-primary"
              style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.02em' }}
            >
              ISSUES
            </h1>
            <span className="text-[13px] text-tertiary tabular-nums">
              {total} issue{total !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        {/* Actions Row */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <button
            onClick={() => router.push(`/project/${projectId}/issues/new`)}
            className="shrink-0 glow-btn glow-btn--primary text-[13px] rounded flex items-center gap-1.5"
            style={{ padding: '0.5rem 0.875rem' }}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Issue
          </button>
          <button
            onClick={() => setShowEmailModal(true)}
            className="shrink-0 glow-btn glow-btn--ghost text-[13px] rounded flex items-center gap-1.5"
            style={{ padding: '0.5rem 0.875rem' }}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            Parse Email
          </button>

          <div className="ml-auto flex items-center gap-1 bg-gray-100 rounded-md p-0.5">
            <button
              onClick={() => setViewMode('list')}
              className={`px-3 py-1.5 text-[12px] font-medium rounded transition-colors ${
                viewMode === 'list' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              List
            </button>
            <button
              onClick={() => setViewMode('board')}
              className={`px-3 py-1.5 text-[12px] font-medium rounded transition-colors ${
                viewMode === 'board' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Board
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="mb-4 space-y-3">
          {/* Status chips */}
          <div className="flex flex-wrap gap-1.5">
            {ALL_STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => toggleStatus(s)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                  selectedStatuses.has(s)
                    ? 'bg-blue-100 text-blue-700 border-blue-300'
                    : 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100'
                }`}
              >
                {s.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <select
              value={selectedSeverity}
              onChange={(e) => { setSelectedSeverity(e.target.value); setPage(1) }}
              className="px-3 py-1.5 border border-gray-200 rounded-md text-[12px] text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">All Severities</option>
              {ALL_SEVERITIES.map((s) => (
                <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
              ))}
            </select>
            <select
              value={selectedCategory}
              onChange={(e) => { setSelectedCategory(e.target.value); setPage(1) }}
              className="px-3 py-1.5 border border-gray-200 rounded-md text-[12px] text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">All Categories</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-20 gap-3">
            <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-[13px] text-tertiary">Loading issues...</span>
          </div>
        ) : error ? (
          <div className="p-4 bg-danger-dim border border-danger rounded-md text-danger text-[14px]">
            {error}
          </div>
        ) : issues.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-[15px] text-secondary mb-1">No issues found</p>
            <p className="text-[13px] text-tertiary">Create an issue or parse an email to get started</p>
          </div>
        ) : viewMode === 'board' ? (
          <KanbanBoard issues={issues} />
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block">
              <div className="panel rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50">
                      <th className="text-left px-4 py-3 text-[11px] text-gray-500 font-semibold uppercase tracking-wider">Title</th>
                      <th className="text-left px-4 py-3 text-[11px] text-gray-500 font-semibold uppercase tracking-wider">Status</th>
                      <th className="text-left px-4 py-3 text-[11px] text-gray-500 font-semibold uppercase tracking-wider">Severity</th>
                      <th className="text-left px-4 py-3 text-[11px] text-gray-500 font-semibold uppercase tracking-wider">Category</th>
                      <th className="text-left px-4 py-3 text-[11px] text-gray-500 font-semibold uppercase tracking-wider">Assignee</th>
                      <th className="text-left px-4 py-3 text-[11px] text-gray-500 font-semibold uppercase tracking-wider">Due</th>
                      <th className="text-right px-4 py-3 text-[11px] text-gray-500 font-semibold uppercase tracking-wider">Comments</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {issues.map((issue) => {
                      const overdue = isOverdue(issue)
                      return (
                        <tr
                          key={issue.id}
                          onClick={() => router.push(`/project/${projectId}/issues/${issue.id}`)}
                          className="hover:bg-gray-50 cursor-pointer transition-colors"
                        >
                          <td className="px-4 py-3 text-[13px] font-medium text-gray-900 max-w-xs truncate">
                            {issue.title}
                          </td>
                          <td className="px-4 py-3">
                            <StatusBadge status={issue.status} />
                          </td>
                          <td className="px-4 py-3">
                            <SeverityBadge severity={issue.severity} />
                          </td>
                          <td className="px-4 py-3 text-[12px] text-gray-500">
                            {issue.category.replace(/_/g, ' ')}
                          </td>
                          <td className="px-4 py-3 text-[12px] text-gray-500">
                            {issue.assigned_to ? issue.assigned_to.slice(0, 8) + '...' : '\u2014'}
                          </td>
                          <td className={`px-4 py-3 text-[12px] ${overdue ? 'text-red-600 font-semibold' : 'text-gray-500'}`}>
                            {issue.due_at ? new Date(issue.due_at).toLocaleDateString() : '\u2014'}
                          </td>
                          <td className="px-4 py-3 text-right text-[12px] text-gray-400 tabular-nums">
                            {issue.comment_count > 0 && (
                              <span className="inline-flex items-center gap-1">
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                                </svg>
                                {issue.comment_count}
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-2">
              {issues.map((issue) => {
                const overdue = isOverdue(issue)
                return (
                  <button
                    key={issue.id}
                    onClick={() => router.push(`/project/${projectId}/issues/${issue.id}`)}
                    className={`w-full text-left panel p-4 rounded-lg hover:bg-gray-50 transition-colors ${
                      overdue ? 'border-l-3 border-l-red-500' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <p className="text-[13px] font-medium text-gray-900 line-clamp-2">{issue.title}</p>
                      {issue.comment_count > 0 && (
                        <span className="shrink-0 text-[11px] text-gray-400 flex items-center gap-0.5">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                          </svg>
                          {issue.comment_count}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={issue.status} />
                      <SeverityBadge severity={issue.severity} />
                      <span className="text-[11px] text-gray-400">{issue.category.replace(/_/g, ' ')}</span>
                    </div>
                    {issue.due_at && (
                      <p className={`text-[11px] mt-2 ${overdue ? 'text-red-600 font-semibold' : 'text-gray-400'}`}>
                        Due {new Date(issue.due_at).toLocaleDateString()}
                      </p>
                    )}
                  </button>
                )
              })}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 mt-6">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1.5 text-[12px] border border-gray-200 rounded-md hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <span className="text-[12px] text-gray-500 tabular-nums">
                  Page {page} of {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="px-3 py-1.5 text-[12px] border border-gray-200 rounded-md hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </main>

      {showEmailModal && (
        <ParseEmailModal
          projectId={projectId}
          onClose={() => setShowEmailModal(false)}
          onSuccess={fetchIssues}
        />
      )}
    </div>
  )
}
