'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import OfflineIndicator from '@/components/OfflineIndicator'
import type { DashboardShare } from '@/lib/types/database'

const StageFunnel = dynamic(
  () => import('./DashboardCharts').then(mod => ({ default: mod.StageFunnel })),
  { ssr: false }
)
const FloorProgress = dynamic(
  () => import('./DashboardCharts').then(mod => ({ default: mod.FloorProgress })),
  { ssr: false }
)
const TimelineTrend = dynamic(
  () => import('./DashboardCharts').then(mod => ({ default: mod.TimelineTrend })),
  { ssr: false }
)
const ZoneHeatmap = dynamic(
  () => import('./DashboardCharts').then(mod => ({ default: mod.ZoneHeatmap })),
  { ssr: false }
)

interface DashboardData {
  stageCounts: Record<string, number>
  floorProgress: Array<{ floor: string; completed: number; remaining: number; pct: number }>
  zoneSummary: Array<{ zone: string; total: number; completed: number; pct: number }>
  timeline: Array<{ date: string; count: number; cumulative: number }>
  totalItems: number
  completedItems: number
  blockedItems: number
}

export default function DashboardPage() {
  const params = useParams()
  const projectId = params.projectId as string
  const router = useRouter()

  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [shareLoading, setShareLoading] = useState(false)
  const [shareLink, setShareLink] = useState<string | null>(null)
  const [shares, setShares] = useState<DashboardShare[]>([])
  const [showShares, setShowShares] = useState(false)

  const fetchDashboard = useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch(`/api/projects/${projectId}/dashboard`)
      if (!res.ok) throw new Error('Failed to fetch dashboard data')
      const json = await res.json()
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  const fetchShares = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/dashboard/shares`)
      if (!res.ok) return
      const json = await res.json()
      setShares(json.data ?? [])
    } catch {
      // silent
    }
  }, [projectId])

  useEffect(() => {
    fetchDashboard()
    fetchShares()
  }, [fetchDashboard, fetchShares])

  const createShare = async () => {
    try {
      setShareLoading(true)
      const res = await fetch(`/api/projects/${projectId}/dashboard/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Dashboard share' }),
      })
      if (!res.ok) throw new Error('Failed to create share')
      const json = await res.json()
      const token = json.data?.share_token
      if (token) {
        const link = `${window.location.origin}/shared/${token}`
        setShareLink(link)
        await navigator.clipboard.writeText(link).catch(() => {})
      }
      fetchShares()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create share')
    } finally {
      setShareLoading(false)
    }
  }

  const revokeShare = async (shareId: string) => {
    try {
      await fetch(`/api/projects/${projectId}/dashboard/shares?id=${shareId}`, {
        method: 'DELETE',
      })
      setShares(prev => prev.filter(s => s.id !== shareId))
    } catch {
      // silent
    }
  }

  const overallPct = data && data.totalItems > 0
    ? Math.round((data.completedItems / data.totalItems) * 100)
    : 0

  return (
    <div className="min-h-screen" style={{ background: 'var(--background)' }}>
      <OfflineIndicator />
      <main className="max-w-6xl mx-auto px-4 py-6 sm:py-8">
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
          <div className="flex items-center justify-between flex-wrap gap-3">
            <h1
              className="text-xl sm:text-2xl font-bold text-primary pb-1"
              style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.02em' }}
            >
              DASHBOARD
            </h1>
            <div className="flex gap-2">
              <button
                onClick={() => setShowShares(!showShares)}
                className="glow-btn glow-btn--ghost text-[13px] rounded px-3 py-1.5"
              >
                Shares ({shares.length})
              </button>
              <button
                onClick={createShare}
                disabled={shareLoading}
                className="glow-btn glow-btn--primary text-[13px] rounded px-3 py-1.5"
              >
                {shareLoading ? 'Creating...' : 'Share Dashboard'}
              </button>
            </div>
          </div>
          {shareLink && (
            <div className="mt-2 p-3 panel rounded-md text-[13px]">
              <span className="text-secondary">Link copied! </span>
              <code className="text-accent break-all">{shareLink}</code>
              <button
                onClick={() => setShareLink(null)}
                className="ml-2 text-tertiary hover:text-primary"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>

        {/* Share list */}
        {showShares && shares.length > 0 && (
          <div className="panel p-4 rounded-md mb-5">
            <h2 className="text-[13px] text-secondary uppercase tracking-wider mb-3">Active Shares</h2>
            <div className="space-y-2">
              {shares.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-3 py-2 border-b border-th-border last:border-b-0">
                  <div className="min-w-0">
                    <span className="text-[13px] text-primary">{s.label ?? 'Untitled'}</span>
                    <span className="text-[11px] text-tertiary ml-2">
                      {new Date(s.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <button
                    onClick={() => revokeShare(s.id)}
                    className="shrink-0 text-[12px] text-danger hover:text-danger/80 transition-colors"
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20 gap-3">
            <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-[13px] text-tertiary">Loading dashboard...</span>
          </div>
        ) : error ? (
          <div className="p-4 bg-danger-dim border border-danger rounded-md text-danger text-[14px]">{error}</div>
        ) : data ? (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              <div className="panel p-4 rounded-md">
                <div className="text-[11px] text-tertiary uppercase tracking-wider mb-1">Total Items</div>
                <div className="text-[22px] font-bold text-primary tabular-nums">{data.totalItems}</div>
              </div>
              <div className="panel p-4 rounded-md">
                <div className="text-[11px] text-tertiary uppercase tracking-wider mb-1">Completed</div>
                <div className="text-[22px] font-bold tabular-nums" style={{ color: 'var(--green)' }}>{data.completedItems}</div>
              </div>
              <div className="panel p-4 rounded-md">
                <div className="text-[11px] text-tertiary uppercase tracking-wider mb-1">Progress</div>
                <div className="text-[22px] font-bold text-accent tabular-nums">{overallPct}%</div>
              </div>
              <div className="panel p-4 rounded-md">
                <div className="text-[11px] text-tertiary uppercase tracking-wider mb-1">Blocked</div>
                <div className="text-[22px] font-bold tabular-nums" style={{ color: data.blockedItems > 0 ? 'var(--red)' : 'var(--tertiary)' }}>
                  {data.blockedItems}
                </div>
              </div>
            </div>

            {/* Charts grid: 2x2 on desktop, 1-col on mobile */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* Stage Funnel */}
              <div className="panel p-4 rounded-md">
                <h2 className="text-[13px] text-secondary uppercase tracking-wider mb-3">Stage Funnel</h2>
                <StageFunnel data={data.stageCounts} />
              </div>

              {/* Floor Progress */}
              <div className="panel p-4 rounded-md">
                <h2 className="text-[13px] text-secondary uppercase tracking-wider mb-3">Floor Progress</h2>
                <FloorProgress data={data.floorProgress} />
              </div>

              {/* Zone Heatmap */}
              <div className="panel p-4 rounded-md">
                <h2 className="text-[13px] text-secondary uppercase tracking-wider mb-3">Zone Heatmap</h2>
                <ZoneHeatmap data={data.zoneSummary} />
              </div>

              {/* Timeline Trend */}
              <div className="panel p-4 rounded-md">
                <h2 className="text-[13px] text-secondary uppercase tracking-wider mb-3">30-Day Timeline</h2>
                <TimelineTrend data={data.timeline} />
              </div>
            </div>
          </>
        ) : null}
      </main>
    </div>
  )
}
