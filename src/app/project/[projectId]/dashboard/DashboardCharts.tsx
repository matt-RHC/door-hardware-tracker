'use client'

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  LineChart, Line, ResponsiveContainer, Cell,
} from 'recharts'

const STAGE_COLORS: Record<string, string> = {
  ordered: '#6366f1',
  shipped: '#f59e0b',
  received: '#3b82f6',
  installed: '#22c55e',
  qa_passed: '#10b981',
}

const STAGE_LABELS: Record<string, string> = {
  ordered: 'Ordered',
  shipped: 'Shipped',
  received: 'Received',
  installed: 'Installed',
  qa_passed: 'QA Passed',
}

interface StageFunnelProps {
  data: Record<string, number>
}

export function StageFunnel({ data }: StageFunnelProps) {
  const chartData = Object.entries(data).map(([stage, count]) => ({
    stage: STAGE_LABELS[stage] ?? stage,
    count,
    key: stage,
  }))

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 20, top: 10, bottom: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--th-border)" />
        <XAxis type="number" tick={{ fontSize: 12, fill: 'var(--tertiary)' }} />
        <YAxis dataKey="stage" type="category" width={80} tick={{ fontSize: 12, fill: 'var(--secondary)' }} />
        <Tooltip
          contentStyle={{ background: 'var(--surface)', border: '1px solid var(--th-border)', borderRadius: '6px', fontSize: '13px' }}
          labelStyle={{ color: 'var(--primary)' }}
        />
        <Bar dataKey="count" radius={[0, 4, 4, 0]}>
          {chartData.map((entry) => (
            <Cell key={entry.key} fill={STAGE_COLORS[entry.key] ?? '#6366f1'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

interface FloorProgressProps {
  data: Array<{ floor: string; completed: number; remaining: number; pct: number }>
}

export function FloorProgress({ data }: FloorProgressProps) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ left: 10, right: 20, top: 10, bottom: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--th-border)" />
        <XAxis dataKey="floor" tick={{ fontSize: 12, fill: 'var(--secondary)' }} label={{ value: 'Floor', position: 'insideBottom', offset: -5, fontSize: 11, fill: 'var(--tertiary)' }} />
        <YAxis tick={{ fontSize: 12, fill: 'var(--tertiary)' }} />
        <Tooltip
          contentStyle={{ background: 'var(--surface)', border: '1px solid var(--th-border)', borderRadius: '6px', fontSize: '13px' }}
          labelStyle={{ color: 'var(--primary)' }}
        />
        <Legend wrapperStyle={{ fontSize: '12px' }} />
        <Bar dataKey="completed" stackId="a" fill="#22c55e" name="Completed" radius={[0, 0, 0, 0]} />
        <Bar dataKey="remaining" stackId="a" fill="#3b82f6" name="Remaining" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

interface TimelineTrendProps {
  data: Array<{ date: string; count: number; cumulative: number }>
}

export function TimelineTrend({ data }: TimelineTrendProps) {
  const formatted = data.map(d => ({
    ...d,
    label: d.date.slice(5), // MM-DD
  }))

  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={formatted} margin={{ left: 10, right: 20, top: 10, bottom: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--th-border)" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--tertiary)' }} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 12, fill: 'var(--tertiary)' }} />
        <Tooltip
          contentStyle={{ background: 'var(--surface)', border: '1px solid var(--th-border)', borderRadius: '6px', fontSize: '13px' }}
          labelStyle={{ color: 'var(--primary)' }}
        />
        <Legend wrapperStyle={{ fontSize: '12px' }} />
        <Line type="monotone" dataKey="cumulative" stroke="#22c55e" strokeWidth={2} name="Cumulative" dot={false} />
        <Line type="monotone" dataKey="count" stroke="#6366f1" strokeWidth={1.5} name="Daily" dot={false} strokeDasharray="4 2" />
      </LineChart>
    </ResponsiveContainer>
  )
}

interface ZoneHeatmapProps {
  data: Array<{ zone: string; total: number; completed: number; pct: number }>
}

function getHeatColor(pct: number): string {
  if (pct >= 90) return '#22c55e'
  if (pct >= 70) return '#4ade80'
  if (pct >= 50) return '#f59e0b'
  if (pct >= 25) return '#f97316'
  return '#ef4444'
}

export function ZoneHeatmap({ data }: ZoneHeatmapProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[260px] text-[13px] text-tertiary">
        No zone data available
      </div>
    )
  }

  return (
    <div className="overflow-auto max-h-[260px]">
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(140px, 1fr))` }}>
        {data.map((z) => (
          <div
            key={z.zone}
            className="rounded-md p-3 border border-th-border"
            style={{
              background: `${getHeatColor(z.pct)}15`,
              borderColor: getHeatColor(z.pct),
            }}
          >
            <div className="text-[12px] font-medium text-primary truncate" title={z.zone}>
              {z.zone}
            </div>
            <div className="text-[20px] font-bold mt-1" style={{ color: getHeatColor(z.pct) }}>
              {z.pct}%
            </div>
            <div className="text-[11px] text-tertiary">
              {z.completed}/{z.total} items
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
