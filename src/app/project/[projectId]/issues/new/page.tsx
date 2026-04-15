'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
import { SLA_HOURS } from '@/lib/utils/sla'
import type { IssueSeverity, IssueType } from '@/lib/types/database'

const ISSUE_TYPES: { value: IssueType; label: string }[] = [
  { value: 'wrong_sku', label: 'Wrong SKU' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'keying_mismatch', label: 'Keying Mismatch' },
  { value: 'finish_variation', label: 'Finish Variation' },
  { value: 'missing_items', label: 'Missing Items' },
  { value: 'substitution_needed', label: 'Substitution Needed' },
  { value: 'install_defect', label: 'Install Defect' },
  { value: 'photo_mismatch', label: 'Photo Mismatch' },
  { value: 'compliance_risk', label: 'Compliance Risk' },
  { value: 'other', label: 'Other' },
]

const SEVERITIES: { value: IssueSeverity; label: string; sla: string }[] = [
  { value: 'critical', label: 'Critical', sla: `${SLA_HOURS.critical}h SLA` },
  { value: 'high', label: 'High', sla: `${SLA_HOURS.high}h SLA` },
  { value: 'medium', label: 'Medium', sla: `${SLA_HOURS.medium}h SLA` },
  { value: 'low', label: 'Low', sla: `${Math.round(SLA_HOURS.low / 24)}d SLA` },
]

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'border-red-500 bg-red-50 text-red-700',
  high: 'border-orange-500 bg-orange-50 text-orange-700',
  medium: 'border-yellow-500 bg-yellow-50 text-yellow-700',
  low: 'border-gray-300 bg-gray-50 text-gray-600',
}

interface Opening {
  id: string
  door_number: string
  location: string | null
  hardware_items?: { id: string; name: string; category: string | null }[]
}

export default function NewIssuePage() {
  const params = useParams()
  const projectId = params.projectId as string
  const searchParams = useSearchParams()
  const router = useRouter()

  const prefilledOpeningId = searchParams.get('opening_id') ?? ''

  const [openings, setOpenings] = useState<Opening[]>([])
  const [openingSearch, setOpeningSearch] = useState('')
  const [selectedOpeningId, setSelectedOpeningId] = useState(prefilledOpeningId)
  const [selectedItemId, setSelectedItemId] = useState('')
  const [category, setCategory] = useState('')
  const [issueType, setIssueType] = useState<string>('')
  const [severity, setSeverity] = useState<IssueSeverity>('medium')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchOpenings = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/openings`)
        if (!res.ok) return
        const data = await res.json()
        setOpenings(data.map((o: Opening & { hardware_items?: unknown[] }) => ({
          id: o.id,
          door_number: o.door_number,
          location: o.location,
          hardware_items: o.hardware_items ?? [],
        })))
      } catch {
        // Non-critical — openings are optional
      }
    }
    fetchOpenings()
  }, [projectId])

  const filteredOpenings = useMemo(() => {
    if (!openingSearch) return openings.slice(0, 20)
    const q = openingSearch.toLowerCase()
    return openings.filter(
      (o) => o.door_number.toLowerCase().includes(q) || o.location?.toLowerCase().includes(q)
    ).slice(0, 20)
  }, [openings, openingSearch])

  const selectedOpening = openings.find((o) => o.id === selectedOpeningId)
  const hardwareItems = selectedOpening?.hardware_items ?? []

  const handleFileAdd = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newFiles = Array.from(e.target.files ?? [])
    setFiles((prev) => [...prev, ...newFiles].slice(0, 5))
    e.target.value = ''
  }

  const handleRemoveFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !issueType || !category) return

    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch(`/api/projects/${projectId}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          opening_id: selectedOpeningId || undefined,
          hardware_item_id: selectedItemId || undefined,
          category,
          issue_type: issueType,
          severity,
          title: title.trim(),
          description: description.trim() || undefined,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to create issue')
      }

      const issue = await res.json()

      // Upload photos if any
      for (const file of files) {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('file_type', file.type.startsWith('image/') ? 'photo' : 'document')
        await fetch(`/api/projects/${projectId}/issues/${issue.id}/attachments`, {
          method: 'POST',
          body: formData,
        })
      }

      router.push(`/project/${projectId}/issues/${issue.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--background)' }}>
      <main className="max-w-2xl mx-auto px-4 py-6 sm:py-8">
        {/* Header */}
        <button
          onClick={() => router.push(`/project/${projectId}/issues`)}
          className="text-accent hover:text-accent/80 mb-4 text-[13px] flex items-center gap-1 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Issues
        </button>
        <h1
          className="text-xl sm:text-2xl font-bold text-primary mb-6 pb-3 border-b border-th-border"
          style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.02em' }}
        >
          NEW ISSUE
        </h1>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-[13px] text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Opening select */}
          <div>
            <label className="block text-[12px] text-gray-500 mb-1.5 uppercase tracking-wider">
              Opening
            </label>
            <input
              type="text"
              value={openingSearch}
              onChange={(e) => setOpeningSearch(e.target.value)}
              placeholder="Search door number or location..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-[13px] text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            {openingSearch && filteredOpenings.length > 0 && (
              <div className="mt-1 border border-gray-200 rounded-md bg-white max-h-40 overflow-y-auto shadow-sm">
                {filteredOpenings.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => {
                      setSelectedOpeningId(o.id)
                      setOpeningSearch(o.door_number)
                      setSelectedItemId('')
                    }}
                    className={`w-full text-left px-3 py-2 text-[13px] hover:bg-blue-50 transition-colors ${
                      o.id === selectedOpeningId ? 'bg-blue-50 text-blue-700' : 'text-gray-700'
                    }`}
                  >
                    <span className="font-medium">{o.door_number}</span>
                    {o.location && <span className="text-gray-400 ml-2">{o.location}</span>}
                  </button>
                ))}
              </div>
            )}
            {selectedOpening && !openingSearch && (
              <p className="text-[12px] text-gray-500 mt-1">
                Selected: <strong>{selectedOpening.door_number}</strong>
                {selectedOpening.location && ` — ${selectedOpening.location}`}
              </p>
            )}
          </div>

          {/* Hardware item (filtered by opening) */}
          {hardwareItems.length > 0 && (
            <div>
              <label className="block text-[12px] text-gray-500 mb-1.5 uppercase tracking-wider">
                Hardware Item
              </label>
              <select
                value={selectedItemId}
                onChange={(e) => {
                  setSelectedItemId(e.target.value)
                  const item = hardwareItems.find((i) => i.id === e.target.value)
                  if (item?.category && !category) setCategory(item.category)
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-[13px] text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="">Select item...</option>
                {hardwareItems.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Category */}
          <div>
            <label className="block text-[12px] text-gray-500 mb-1.5 uppercase tracking-wider">
              Category *
            </label>
            <input
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g., hinges, locksets, closers..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-[13px] text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
            />
          </div>

          {/* Issue type */}
          <div>
            <label className="block text-[12px] text-gray-500 mb-1.5 uppercase tracking-wider">
              Issue Type *
            </label>
            <select
              value={issueType}
              onChange={(e) => setIssueType(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-[13px] text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
            >
              <option value="">Select type...</option>
              {ISSUE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {/* Severity radio */}
          <div>
            <label className="block text-[12px] text-gray-500 mb-2 uppercase tracking-wider">
              Severity *
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {SEVERITIES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setSeverity(s.value)}
                  className={`px-3 py-2.5 rounded-md border-2 text-left transition-colors ${
                    severity === s.value
                      ? SEVERITY_COLORS[s.value]
                      : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  <span className="block text-[13px] font-semibold">{s.label}</span>
                  <span className="block text-[11px] opacity-70">{s.sla}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Title */}
          <div>
            <label className="block text-[12px] text-gray-500 mb-1.5 uppercase tracking-wider">
              Title *
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, 120))}
              maxLength={120}
              placeholder="Brief description of the issue..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-[13px] text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              required
            />
            <p className="text-[11px] text-gray-400 mt-1 text-right tabular-nums">{title.length}/120</p>
          </div>

          {/* Description */}
          <div>
            <label className="block text-[12px] text-gray-500 mb-1.5 uppercase tracking-wider">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-[13px] text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
              placeholder="Provide more details about the issue..."
            />
          </div>

          {/* Photo upload */}
          <div>
            <label className="block text-[12px] text-gray-500 mb-1.5 uppercase tracking-wider">
              Photos (up to 5)
            </label>
            <div className="flex flex-wrap gap-2 mb-2">
              {files.map((f, i) => (
                <div key={i} className="relative border border-gray-200 rounded-md overflow-hidden group">
                  {f.type.startsWith('image/') ? (
                    <div className="w-20 h-20 bg-gray-100">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={URL.createObjectURL(f)}
                        alt={f.name}
                        className="w-full h-full object-cover"
                      />
                    </div>
                  ) : (
                    <div className="w-20 h-20 bg-gray-50 flex items-center justify-center">
                      <svg className="w-6 h-6 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRemoveFile(i)}
                    className="absolute top-0.5 right-0.5 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
              {files.length < 5 && (
                <label className="w-20 h-20 border-2 border-dashed border-gray-300 rounded-md flex items-center justify-center cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleFileAdd}
                    className="hidden"
                    multiple
                  />
                  <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                </label>
              )}
            </div>
          </div>

          {/* Submit */}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={submitting || !title.trim() || !issueType || !category}
              className="px-6 py-2.5 text-[13px] font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {submitting && (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              )}
              {submitting ? 'Creating...' : 'Create Issue'}
            </button>
            <button
              type="button"
              onClick={() => router.push(`/project/${projectId}/issues`)}
              className="px-4 py-2.5 text-[13px] text-gray-600 hover:text-gray-800 transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      </main>
    </div>
  )
}
