'use client'

import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { isOverdue } from '@/lib/utils/sla'

const STATUS_DOTS: Record<string, string> = {
  created: 'bg-gray-400',
  acknowledged: 'bg-blue-500',
  awaiting_action: 'bg-amber-500',
  blocked: 'bg-red-500',
  resolved: 'bg-green-500',
  duplicate: 'bg-purple-500',
  closed: 'bg-slate-400',
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'text-red-600',
  high: 'text-orange-600',
  medium: 'text-yellow-600',
  low: 'text-gray-500',
}

interface FeedIssue {
  id: string
  title: string
  status: string
  severity: string
  due_at: string | null
  created_at: string
}

function timeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export default function OpeningIssuesFeed({ openingId }: { openingId: string }) {
  const router = useRouter()
  const params = useParams()
  const projectId = params.projectId as string

  const [issues, setIssues] = useState<FeedIssue[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    const fetchIssues = async () => {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/issues?opening_id=${openingId}&limit=10`,
          { signal: controller.signal }
        )
        if (!res.ok) return
        const data = await res.json()
        setIssues(data.data ?? [])
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        // Non-critical
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    fetchIssues()
    return () => controller.abort()
  }, [projectId, openingId])

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4">
        <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        <span className="text-[12px] text-tertiary">Loading issues...</span>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[12px] text-gray-500 font-semibold uppercase tracking-wider">
          Issues ({issues.length})
        </h3>
        <button
          onClick={() => router.push(`/project/${projectId}/issues/new?opening_id=${openingId}`)}
          className="text-[12px] text-accent hover:text-accent/80 font-medium transition-colors"
        >
          Report Issue
        </button>
      </div>

      {issues.length === 0 ? (
        <p className="text-[12px] text-gray-400 py-2">No issues for this opening</p>
      ) : (
        <div className="space-y-1">
          {issues.map((issue) => {
            const overdue = isOverdue(issue)
            return (
              <button
                key={issue.id}
                onClick={() => router.push(`/project/${projectId}/issues/${issue.id}`)}
                className="w-full text-left flex items-center gap-2 py-1.5 px-2 rounded hover:bg-gray-50 transition-colors group"
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOTS[issue.status] ?? 'bg-gray-400'}`} />
                <span className="text-[12px] text-gray-700 truncate flex-1 group-hover:text-gray-900">
                  {issue.title}
                </span>
                <span className={`text-[10px] shrink-0 ${SEVERITY_COLORS[issue.severity] ?? 'text-gray-500'}`}>
                  {issue.severity}
                </span>
                <span className={`text-[10px] shrink-0 ${overdue ? 'text-red-600 font-semibold' : 'text-gray-400'}`}>
                  {timeAgo(issue.created_at)}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
