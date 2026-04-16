'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter, useParams } from 'next/navigation'
import StatusBadge from '@/components/issues/StatusBadge'
import SeverityBadge from '@/components/issues/SeverityBadge'
import { isValidTransition } from '@/lib/utils/issue-transitions'
import { isOverdue } from '@/lib/utils/sla'
import type { IssueStatus, IssueComment, IssueAttachment } from '@/lib/types/database'

const ALL_STATUSES: IssueStatus[] = [
  'created', 'acknowledged', 'awaiting_action', 'blocked', 'resolved', 'duplicate', 'closed',
]

const STATUS_BUTTON_COLORS: Record<string, string> = {
  acknowledged: 'bg-blue-600 hover:bg-blue-700 text-white',
  awaiting_action: 'bg-amber-600 hover:bg-amber-700 text-white',
  blocked: 'bg-red-600 hover:bg-red-700 text-white',
  resolved: 'bg-green-600 hover:bg-green-700 text-white',
  duplicate: 'bg-purple-600 hover:bg-purple-700 text-white',
  closed: 'bg-slate-600 hover:bg-slate-700 text-white',
}

interface IssueDetail {
  id: string
  project_id: string
  opening_id: string | null
  hardware_item_id: string | null
  category: string
  issue_type: string
  severity: string
  status: string
  assigned_to: string | null
  awaiting_from: string | null
  due_at: string | null
  awaited_since: string | null
  title: string
  description: string | null
  resolution_summary: string | null
  reported_by: string | null
  source: string
  source_data: Record<string, unknown>
  parse_confidence: number
  created_at: string
  updated_at: string
  resolved_at: string | null
  issue_comments: IssueComment[]
  issue_attachments: IssueAttachment[]
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

export default function IssueDetailPage() {
  const params = useParams()
  const projectId = params.projectId as string
  const issueId = params.issueId as string
  const router = useRouter()

  const [issue, setIssue] = useState<IssueDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [transitionLoading, setTransitionLoading] = useState<string | null>(null)

  const [commentBody, setCommentBody] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)

  const [uploadingFile, setUploadingFile] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [showOriginalEmail, setShowOriginalEmail] = useState(false)

  const fetchIssue = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/issues/${issueId}`)
      if (!res.ok) throw new Error('Failed to fetch issue')
      const data = await res.json()
      setIssue(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }, [projectId, issueId])

  useEffect(() => {
    fetchIssue()
  }, [fetchIssue])

  const handleTransition = async (newStatus: string) => {
    if (!issue) return
    setTransitionLoading(newStatus)
    try {
      const res = await fetch(`/api/projects/${projectId}/issues/${issueId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to update status')
      }
      const updated = await res.json()
      setIssue((prev) => prev ? { ...prev, ...updated, issue_comments: prev.issue_comments, issue_attachments: prev.issue_attachments } : null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setTransitionLoading(null)
    }
  }

  const handleAddComment = async () => {
    if (!commentBody.trim()) return
    setCommentSubmitting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/issues/${issueId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: commentBody }),
      })
      if (!res.ok) throw new Error('Failed to add comment')
      const comment = await res.json()
      setIssue((prev) => prev ? {
        ...prev,
        issue_comments: [...prev.issue_comments, comment],
      } : null)
      setCommentBody('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setCommentSubmitting(false)
    }
  }

  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingFile(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('file_type', file.type.startsWith('image/') ? 'photo' : 'document')

      const res = await fetch(`/api/projects/${projectId}/issues/${issueId}/attachments`, {
        method: 'POST',
        body: formData,
      })
      if (!res.ok) throw new Error('Failed to upload file')
      const attachment = await res.json()
      setIssue((prev) => prev ? {
        ...prev,
        issue_attachments: [attachment, ...prev.issue_attachments],
      } : null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setUploadingFile(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--background)' }}>
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <span className="text-[13px] text-tertiary">Loading issue...</span>
        </div>
      </div>
    )
  }

  if (error && !issue) {
    return (
      <div className="min-h-screen" style={{ background: 'var(--background)' }}>
        <main className="max-w-5xl mx-auto px-4 py-8">
          <div className="p-4 bg-danger-dim border border-danger rounded-md text-danger text-[14px]">
            {error}
          </div>
        </main>
      </div>
    )
  }

  if (!issue) return null

  const overdue = isOverdue(issue)
  const validTransitions = ALL_STATUSES.filter((s) => isValidTransition(issue.status, s))
  const comments = [...(issue.issue_comments ?? [])].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  )
  const attachments = issue.issue_attachments ?? []

  return (
    <div className="min-h-screen" style={{ background: 'var(--background)' }}>
      <main className="max-w-5xl mx-auto px-4 py-6 sm:py-8">
        {/* Back nav */}
        <button
          onClick={() => router.push(`/project/${projectId}/issues`)}
          className="text-accent hover:text-accent/80 mb-4 text-[13px] flex items-center gap-1 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Issues
        </button>

        {/* Low confidence banner */}
        {issue.parse_confidence < 0.75 && (
          <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md flex items-start gap-2">
            <svg className="w-5 h-5 text-yellow-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-[13px] text-yellow-800">
              AI-parsed with low confidence ({Math.round(issue.parse_confidence * 100)}%) — please review.
            </p>
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-[13px] text-red-700">
            {error}
          </div>
        )}

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-lg sm:text-xl font-bold text-primary mb-2">{issue.title}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={issue.status} />
            <SeverityBadge severity={issue.severity} />
            {overdue && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-100 text-red-700 border border-red-300">
                Overdue
              </span>
            )}
          </div>
        </div>

        {/* Main layout */}
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Left: content */}
          <div className="flex-1 min-w-0 space-y-6">
            {/* Description */}
            {issue.description && (
              <div className="panel p-4 rounded-lg">
                <h2 className="text-[12px] text-gray-500 font-semibold uppercase tracking-wider mb-2">Description</h2>
                <p className="text-[13px] text-gray-700 whitespace-pre-wrap">{issue.description}</p>
              </div>
            )}

            {/* Resolution summary */}
            {issue.resolution_summary && (
              <div className="panel p-4 rounded-lg border-l-3 border-l-green-500">
                <h2 className="text-[12px] text-green-600 font-semibold uppercase tracking-wider mb-2">Resolution</h2>
                <p className="text-[13px] text-gray-700 whitespace-pre-wrap">{issue.resolution_summary}</p>
              </div>
            )}

            {/* Status transitions */}
            {validTransitions.length > 0 && (
              <div className="panel p-4 rounded-lg">
                <h2 className="text-[12px] text-gray-500 font-semibold uppercase tracking-wider mb-3">Transition Status</h2>
                <div className="flex flex-wrap gap-2">
                  {validTransitions.map((s) => (
                    <button
                      key={s}
                      onClick={() => handleTransition(s)}
                      disabled={transitionLoading !== null}
                      className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors disabled:opacity-50 ${
                        STATUS_BUTTON_COLORS[s] ?? 'bg-gray-600 hover:bg-gray-700 text-white'
                      }`}
                    >
                      {transitionLoading === s ? (
                        <span className="flex items-center gap-1.5">
                          <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          Updating...
                        </span>
                      ) : (
                        s.replace(/_/g, ' ')
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Original email */}
            {issue.source === 'email' && issue.source_data && (
              <div className="panel rounded-lg overflow-hidden">
                <button
                  onClick={() => setShowOriginalEmail(!showOriginalEmail)}
                  className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-gray-50 transition-colors"
                >
                  <span className="text-[12px] text-gray-500 font-semibold uppercase tracking-wider">
                    Original Email
                  </span>
                  <svg
                    className={`w-4 h-4 text-gray-400 transition-transform ${showOriginalEmail ? 'rotate-180' : ''}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showOriginalEmail && (() => {
                  const sd = issue.source_data as Record<string, string | undefined>
                  return (
                    <div className="px-4 pb-4 border-t border-gray-100">
                      {sd.email_subject ? (
                        <p className="text-[12px] text-gray-500 mt-3">
                          <strong>Subject:</strong> {sd.email_subject}
                        </p>
                      ) : null}
                      {sd.email_from ? (
                        <p className="text-[12px] text-gray-500 mt-1">
                          <strong>From:</strong> {sd.email_from}
                        </p>
                      ) : null}
                      {sd.email_body ? (
                        <pre className="mt-2 text-[12px] text-gray-600 whitespace-pre-wrap bg-gray-50 rounded-md p-3 max-h-64 overflow-y-auto">
                          {sd.email_body}
                        </pre>
                      ) : null}
                    </div>
                  )
                })()}
              </div>
            )}

            {/* Comments */}
            <div className="panel p-4 rounded-lg">
              <h2 className="text-[12px] text-gray-500 font-semibold uppercase tracking-wider mb-4">
                Comments ({comments.length})
              </h2>

              {comments.length > 0 && (
                <div className="space-y-4 mb-4">
                  {comments.map((comment) => (
                    <div key={comment.id} className="border-l-2 border-gray-200 pl-3">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[12px] font-medium text-gray-700">
                          {comment.author_id ? comment.author_id.slice(0, 8) + '...' : 'System'}
                        </span>
                        <span className="text-[11px] text-gray-400">{timeAgo(comment.created_at)}</span>
                        {comment.visibility === 'external' && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-blue-100 text-blue-600 uppercase">
                            External
                          </span>
                        )}
                        {comment.comment_type !== 'user_comment' && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-gray-100 text-gray-500 uppercase">
                            {comment.comment_type.replace(/_/g, ' ')}
                          </span>
                        )}
                      </div>
                      <p className="text-[13px] text-gray-700 whitespace-pre-wrap">{comment.body}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* Add comment form */}
              <div className="border-t border-gray-100 pt-4">
                <textarea
                  value={commentBody}
                  onChange={(e) => setCommentBody(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-200 rounded-md text-[13px] text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
                  placeholder="Add a comment..."
                />
                <div className="flex justify-end mt-2">
                  <button
                    onClick={handleAddComment}
                    disabled={commentSubmitting || !commentBody.trim()}
                    className="px-4 py-1.5 text-[12px] font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                  >
                    {commentSubmitting && (
                      <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    )}
                    Add Comment
                  </button>
                </div>
              </div>
            </div>

            {/* Attachments */}
            <div className="panel p-4 rounded-lg">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-[12px] text-gray-500 font-semibold uppercase tracking-wider">
                  Attachments ({attachments.length})
                </h2>
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    onChange={handleUploadFile}
                    className="hidden"
                    accept="image/*,.pdf,.doc,.docx,.txt"
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingFile}
                    className="px-3 py-1.5 text-[12px] font-medium border border-gray-200 rounded-md hover:bg-gray-50 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {uploadingFile ? (
                      <>
                        <div className="w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                        Uploading...
                      </>
                    ) : (
                      <>
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                        Upload
                      </>
                    )}
                  </button>
                </div>
              </div>

              {attachments.length === 0 ? (
                <p className="text-[12px] text-gray-400 text-center py-4">No attachments yet</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {attachments.map((att) => {
                    const isImage = att.content_type?.startsWith('image/') || att.file_type === 'photo'
                    return (
                      <a
                        key={att.id}
                        href={att.signed_url ?? '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block border border-gray-200 rounded-lg overflow-hidden hover:border-blue-300 transition-colors group"
                      >
                        {isImage && att.signed_url ? (
                          <div className="aspect-square bg-gray-100 flex items-center justify-center overflow-hidden">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={att.signed_url}
                              alt={att.file_name}
                              className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                            />
                          </div>
                        ) : (
                          <div className="aspect-square bg-gray-50 flex items-center justify-center">
                            <svg className="w-8 h-8 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                          </div>
                        )}
                        <div className="px-2 py-1.5">
                          <p className="text-[11px] text-gray-600 truncate">{att.file_name}</p>
                        </div>
                      </a>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right sidebar */}
          <div className="lg:w-72 shrink-0 space-y-4">
            <div className="panel p-4 rounded-lg space-y-3">
              <h2 className="text-[12px] text-gray-500 font-semibold uppercase tracking-wider mb-1">Details</h2>

              <div>
                <label className="text-[11px] text-gray-400 uppercase tracking-wider">Assigned To</label>
                <p className="text-[13px] text-gray-700 mt-0.5">
                  {issue.assigned_to ? issue.assigned_to.slice(0, 8) + '...' : 'Unassigned'}
                </p>
              </div>

              <div>
                <label className="text-[11px] text-gray-400 uppercase tracking-wider">Awaiting From</label>
                <p className="text-[13px] text-gray-700 mt-0.5">
                  {issue.awaiting_from ? issue.awaiting_from.replace(/_/g, ' ') : '\u2014'}
                </p>
              </div>

              <div>
                <label className="text-[11px] text-gray-400 uppercase tracking-wider">Reported By</label>
                <p className="text-[13px] text-gray-700 mt-0.5">
                  {issue.reported_by ? issue.reported_by.slice(0, 8) + '...' : '\u2014'}
                </p>
              </div>

              <div>
                <label className="text-[11px] text-gray-400 uppercase tracking-wider">Source</label>
                <p className="text-[13px] text-gray-700 mt-0.5 capitalize">
                  {issue.source.replace(/_/g, ' ')}
                </p>
              </div>

              <div>
                <label className="text-[11px] text-gray-400 uppercase tracking-wider">Category</label>
                <p className="text-[13px] text-gray-700 mt-0.5">
                  {issue.category.replace(/_/g, ' ')}
                </p>
              </div>

              <div>
                <label className="text-[11px] text-gray-400 uppercase tracking-wider">Type</label>
                <p className="text-[13px] text-gray-700 mt-0.5">
                  {issue.issue_type.replace(/_/g, ' ')}
                </p>
              </div>

              <div>
                <label className="text-[11px] text-gray-400 uppercase tracking-wider">Created</label>
                <p className="text-[13px] text-gray-700 mt-0.5">
                  {new Date(issue.created_at).toLocaleString()}
                </p>
              </div>

              <div>
                <label className="text-[11px] text-gray-400 uppercase tracking-wider">Due</label>
                <p className={`text-[13px] mt-0.5 ${overdue ? 'text-red-600 font-semibold' : 'text-gray-700'}`}>
                  {issue.due_at ? new Date(issue.due_at).toLocaleString() : '\u2014'}
                </p>
              </div>

              {issue.parse_confidence < 1.0 && (
                <div>
                  <label className="text-[11px] text-gray-400 uppercase tracking-wider">Parse Confidence</label>
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          issue.parse_confidence >= 0.75 ? 'bg-green-500' :
                          issue.parse_confidence >= 0.5 ? 'bg-yellow-500' : 'bg-red-500'
                        }`}
                        style={{ width: `${issue.parse_confidence * 100}%` }}
                      />
                    </div>
                    <span className="text-[11px] text-gray-500 tabular-nums">
                      {Math.round(issue.parse_confidence * 100)}%
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
