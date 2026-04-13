"use client"

import { useState, useEffect, useRef, useCallback } from 'react'
import type {
  JobStatus,
  JobStatusResponse,
  JobResultsResponse,
} from '@/components/ImportWizard/types'

const POLL_INTERVAL_MS = 2000

/** Terminal statuses — no more polling needed. */
const TERMINAL_STATUSES = new Set<JobStatus>([
  'completed',
  'failed',
  'cancelled',
])

/** Human-friendly status messages shown in the progress bar. */
const STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Queued — waiting to start...',
  processing: 'Processing...',
  classifying: 'Classifying pages...',
  extracting: 'Extracting hardware data...',
  triaging: 'Running AI triage...',
  validating: 'Applying validation rules...',
  completed: 'Extraction complete!',
  failed: 'Extraction failed',
  cancelled: 'Job cancelled',
}

export interface UseExtractionJobReturn {
  jobId: string | null
  status: JobStatus
  progress: number
  statusMessage: string | null
  error: string | null
  isRunning: boolean
  isComplete: boolean
  isFailed: boolean
  createJob: (projectId: string) => Promise<string>
  submitAnswers: (answers: Record<string, unknown>) => Promise<void>
  fetchResults: () => Promise<JobResultsResponse>
}

export function useExtractionJob(): UseExtractionJobReturn {
  const [jobId, setJobId] = useState<string | null>(null)
  const [status, setStatus] = useState<JobStatus>('queued')
  const [progress, setProgress] = useState(0)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const jobIdRef = useRef<string | null>(null)

  // Keep ref in sync for use inside interval callbacks
  useEffect(() => {
    jobIdRef.current = jobId
  }, [jobId])

  // ─── Polling ───
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const pollStatus = useCallback(async () => {
    const id = jobIdRef.current
    if (!id) return

    try {
      const resp = await fetch(`/api/jobs/${id}`)
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        throw new Error(body.error || `Poll failed (${resp.status})`)
      }

      const data: JobStatusResponse = await resp.json()
      setStatus(data.status)
      setProgress(data.progress ?? 0)
      setStatusMessage(
        data.statusMessage ?? STATUS_LABELS[data.status] ?? null,
      )

      if (data.error) {
        setError(data.error.message)
      }

      if (TERMINAL_STATUSES.has(data.status)) {
        stopPolling()
      }
    } catch (err) {
      console.error('Job poll error:', err)
      // Don't stop polling on transient network errors — let it retry
    }
  }, [stopPolling])

  const startPolling = useCallback(() => {
    stopPolling()
    // Immediate first poll
    pollStatus()
    pollRef.current = setInterval(pollStatus, POLL_INTERVAL_MS)
  }, [pollStatus, stopPolling])

  // Clean up on unmount
  useEffect(() => {
    return () => stopPolling()
  }, [stopPolling])

  // ─── Actions ───

  const createJob = useCallback(
    async (projectId: string): Promise<string> => {
      setError(null)
      setStatus('queued')
      setProgress(0)
      setStatusMessage(STATUS_LABELS.queued)

      const resp = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      })

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        const msg = body.error || `Failed to create job (${resp.status})`
        setError(msg)
        throw new Error(msg)
      }

      const { jobId: newJobId } = await resp.json()
      setJobId(newJobId)
      jobIdRef.current = newJobId

      // Start polling immediately
      startPolling()

      return newJobId
    },
    [startPolling],
  )

  const submitAnswers = useCallback(
    async (answers: Record<string, unknown>): Promise<void> => {
      const id = jobIdRef.current
      if (!id) throw new Error('No active job')

      const payload = Object.entries(answers)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([questionKey, answerValue]) => ({ questionKey, answerValue }))

      if (payload.length === 0) return

      const resp = await fetch(`/api/jobs/${id}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: payload }),
      })

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        console.error('Failed to submit answers:', body.error)
      }
    },
    [],
  )

  const fetchResults = useCallback(async (): Promise<JobResultsResponse> => {
    const id = jobIdRef.current
    if (!id) throw new Error('No active job')

    const resp = await fetch(`/api/jobs/${id}/results`)
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}))
      throw new Error(body.error || `Failed to fetch results (${resp.status})`)
    }

    return resp.json()
  }, [])

  return {
    jobId,
    status,
    progress,
    statusMessage,
    error,
    isRunning: !TERMINAL_STATUSES.has(status),
    isComplete: status === 'completed',
    isFailed: status === 'failed',
    createJob,
    submitAnswers,
    fetchResults,
  }
}
