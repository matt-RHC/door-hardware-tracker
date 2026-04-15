import type { IssueSeverity } from '@/lib/types/database'

export const SLA_HOURS: Record<IssueSeverity, number> = {
  critical: 4,
  high: 24,
  medium: 72,
  low: 168, // 1 week
}

export function computeDueAt(severity: IssueSeverity, createdAt: Date = new Date()): Date {
  return new Date(createdAt.getTime() + SLA_HOURS[severity] * 60 * 60 * 1000)
}

export function isOverdue(issue: { due_at: string | null; status: string }): boolean {
  if (!issue.due_at || ['resolved', 'closed', 'duplicate'].includes(issue.status)) return false
  return new Date(issue.due_at) < new Date()
}
