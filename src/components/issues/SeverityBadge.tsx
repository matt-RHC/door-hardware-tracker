'use client'

import type { IssueSeverity } from '@/lib/types/database'

const SEVERITY_CONFIG: Record<IssueSeverity, { label: string; dot: string; text: string }> = {
  critical: { label: 'Critical', dot: 'bg-red-500',    text: 'text-red-700' },
  high:     { label: 'High',     dot: 'bg-orange-500', text: 'text-orange-700' },
  medium:   { label: 'Medium',   dot: 'bg-yellow-500', text: 'text-yellow-700' },
  low:      { label: 'Low',      dot: 'bg-gray-400',   text: 'text-gray-600' },
}

export default function SeverityBadge({ severity }: { severity: string }) {
  const config = SEVERITY_CONFIG[severity as IssueSeverity] ?? SEVERITY_CONFIG.medium

  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${config.text}`}>
      <span className={`w-2 h-2 rounded-full ${config.dot}`} />
      {config.label}
    </span>
  )
}
