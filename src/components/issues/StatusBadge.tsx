'use client'

import type { IssueStatus } from '@/lib/types/database'

const STATUS_CONFIG: Record<IssueStatus, { label: string; bg: string; text: string; border: string }> = {
  created:         { label: 'Created',         bg: 'bg-gray-100',   text: 'text-gray-700',   border: 'border-gray-300' },
  acknowledged:    { label: 'Acknowledged',    bg: 'bg-blue-100',   text: 'text-blue-700',   border: 'border-blue-300' },
  awaiting_action: { label: 'Awaiting Action', bg: 'bg-amber-100',  text: 'text-amber-700',  border: 'border-amber-300' },
  blocked:         { label: 'Blocked',         bg: 'bg-red-100',    text: 'text-red-700',    border: 'border-red-300' },
  resolved:        { label: 'Resolved',        bg: 'bg-green-100',  text: 'text-green-700',  border: 'border-green-300' },
  duplicate:       { label: 'Duplicate',       bg: 'bg-purple-100', text: 'text-purple-700', border: 'border-purple-300' },
  closed:          { label: 'Closed',          bg: 'bg-slate-100',  text: 'text-slate-700',  border: 'border-slate-300' },
}

export default function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status as IssueStatus] ?? STATUS_CONFIG.created

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${config.bg} ${config.text} ${config.border}`}
    >
      {config.label}
    </span>
  )
}
