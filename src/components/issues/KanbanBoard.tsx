'use client'

import { useRouter, useParams } from 'next/navigation'
import { isOverdue } from '@/lib/utils/sla'
import type { IssueStatus } from '@/lib/types/database'

const COLUMNS: { status: IssueStatus; label: string; headerColor: string }[] = [
  { status: 'created',         label: 'Created',         headerColor: 'bg-gray-200 text-gray-800' },
  { status: 'acknowledged',    label: 'Acknowledged',    headerColor: 'bg-blue-200 text-blue-800' },
  { status: 'awaiting_action', label: 'Awaiting Action', headerColor: 'bg-amber-200 text-amber-800' },
  { status: 'blocked',         label: 'Blocked',         headerColor: 'bg-red-200 text-red-800' },
  { status: 'resolved',        label: 'Resolved',        headerColor: 'bg-green-200 text-green-800' },
  { status: 'closed',          label: 'Closed',          headerColor: 'bg-slate-200 text-slate-800' },
]

const SEVERITY_DOTS: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-gray-400',
}

interface KanbanIssue {
  id: string
  title: string
  status: string
  severity: string
  category: string
  assigned_to: string | null
  due_at: string | null
}

export default function KanbanBoard({ issues }: { issues: KanbanIssue[] }) {
  const router = useRouter()
  const params = useParams()
  const projectId = params.projectId as string

  const grouped = new Map<string, KanbanIssue[]>()
  for (const col of COLUMNS) {
    grouped.set(col.status, [])
  }
  for (const issue of issues) {
    const list = grouped.get(issue.status)
    if (list) list.push(issue)
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-4 -mx-4 px-4">
      {COLUMNS.map((col) => {
        const colIssues = grouped.get(col.status) ?? []
        return (
          <div key={col.status} className="flex-shrink-0 w-64 min-w-[16rem]">
            <div className={`rounded-t-lg px-3 py-2 ${col.headerColor}`}>
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-semibold uppercase tracking-wider">
                  {col.label}
                </span>
                <span className="text-[11px] font-medium opacity-70">
                  {colIssues.length}
                </span>
              </div>
            </div>
            <div className="bg-gray-50 rounded-b-lg border border-t-0 border-gray-200 min-h-[200px] p-2 space-y-2">
              {colIssues.length === 0 && (
                <p className="text-[11px] text-gray-400 text-center py-8">No issues</p>
              )}
              {colIssues.map((issue) => {
                const overdue = isOverdue(issue)
                return (
                  <button
                    key={issue.id}
                    onClick={() => router.push(`/project/${projectId}/issues/${issue.id}`)}
                    className={`w-full text-left panel p-3 rounded-md hover:bg-gray-100 transition-colors cursor-pointer ${
                      overdue ? 'border-l-3 border-l-red-500' : ''
                    }`}
                  >
                    <p className="text-[13px] font-medium text-gray-900 line-clamp-2 mb-2">
                      {issue.title}
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`w-2 h-2 rounded-full ${SEVERITY_DOTS[issue.severity] ?? 'bg-gray-400'}`} />
                      <span className="text-[10px] text-gray-500 truncate max-w-[8rem]">
                        {issue.category}
                      </span>
                      {issue.assigned_to && (
                        <span className="ml-auto inline-flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-[10px] font-semibold">
                          {issue.assigned_to.slice(0, 2).toUpperCase()}
                        </span>
                      )}
                    </div>
                    {issue.due_at && (
                      <p className={`text-[10px] mt-1.5 ${overdue ? 'text-red-600 font-semibold' : 'text-gray-400'}`}>
                        Due {new Date(issue.due_at).toLocaleDateString()}
                      </p>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
