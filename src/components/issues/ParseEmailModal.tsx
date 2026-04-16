'use client'

import { useState } from 'react'

interface ParsedIssue {
  id: string
  title: string
  category: string
  issue_type: string
  severity: string
  description: string | null
  parse_confidence: number
  source_data: {
    parse_notes?: string
    parsed_opening_identifier?: string
    parsed_item_name?: string
    parsed_evidence?: string
    parsed_requested_action?: string
    parsed_assignee_hint?: string
  }
}

interface ParseEmailModalProps {
  projectId: string
  onClose: () => void
  onSuccess: () => void
}

export default function ParseEmailModal({ projectId, onClose, onSuccess }: ParseEmailModalProps) {
  const [emailBody, setEmailBody] = useState('')
  const [emailSubject, setEmailSubject] = useState('')
  const [emailFrom, setEmailFrom] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<ParsedIssue[] | null>(null)

  const handleParse = async () => {
    if (!emailBody.trim()) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/issues/parse-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email_body: emailBody,
          email_subject: emailSubject || undefined,
          email_from: emailFrom || undefined,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to parse email')
      }
      const data = await res.json()
      setResults(data.issues ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }

  const handleDone = () => {
    onSuccess()
    onClose()
  }

  const confidenceColor = (c: number) => {
    if (c >= 0.75) return 'text-green-700 bg-green-100'
    if (c >= 0.5) return 'text-yellow-700 bg-yellow-100'
    return 'text-red-700 bg-red-100'
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="text-[15px] font-bold text-gray-900">Parse Email into Issues</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {!results ? (
            <>
              <div>
                <label className="block text-[12px] text-gray-500 mb-1.5 uppercase tracking-wider">
                  Email Body *
                </label>
                <textarea
                  value={emailBody}
                  onChange={(e) => setEmailBody(e.target.value)}
                  rows={8}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-[13px] text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
                  placeholder="Paste the email body here..."
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] text-gray-500 mb-1.5 uppercase tracking-wider">
                    Subject
                  </label>
                  <input
                    type="text"
                    value={emailSubject}
                    onChange={(e) => setEmailSubject(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-[13px] text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="Email subject"
                  />
                </div>
                <div>
                  <label className="block text-[12px] text-gray-500 mb-1.5 uppercase tracking-wider">
                    From
                  </label>
                  <input
                    type="text"
                    value={emailFrom}
                    onChange={(e) => setEmailFrom(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-[13px] text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="sender@example.com"
                  />
                </div>
              </div>
              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-md text-[13px] text-red-700">
                  {error}
                </div>
              )}
            </>
          ) : (
            <>
              {results.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-[14px] text-gray-500">No issues could be parsed from this email.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-[13px] text-gray-600">
                    {results.length} issue{results.length !== 1 ? 's' : ''} created from email:
                  </p>
                  {results.map((issue) => (
                    <div key={issue.id} className="border border-gray-200 rounded-lg p-4">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <h3 className="text-[13px] font-semibold text-gray-900">{issue.title}</h3>
                        <span className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold ${confidenceColor(issue.parse_confidence)}`}>
                          {Math.round(issue.parse_confidence * 100)}%
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-2 mb-2">
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                          {issue.issue_type}
                        </span>
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                          {issue.severity}
                        </span>
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                          {issue.category}
                        </span>
                      </div>
                      {issue.description && (
                        <p className="text-[12px] text-gray-500 line-clamp-2">{issue.description}</p>
                      )}
                      {issue.source_data?.parse_notes && (
                        <p className="text-[11px] text-amber-600 mt-1">
                          Note: {issue.source_data.parse_notes}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-200">
          {!results ? (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 text-[13px] text-gray-600 hover:text-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleParse}
                disabled={loading || !emailBody.trim()}
                className="px-4 py-2 text-[13px] font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {loading && (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                )}
                {loading ? 'Parsing...' : 'Parse Email'}
              </button>
            </>
          ) : (
            <button
              onClick={handleDone}
              className="px-4 py-2 text-[13px] font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
