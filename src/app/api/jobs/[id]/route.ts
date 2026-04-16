import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const maxDuration = 10

/**
 * GET /api/jobs/[id] — Poll job status.
 *
 * Returns current status, progress, and summary data for a background
 * extraction job. Used by the UI to poll for completion.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: jobId } = await params

  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
    }

    // RLS enforces project membership on the SELECT
    const { data: job, error: jobError } = await supabase
      .from('extraction_jobs')
      .select('*')
      .eq('id', jobId)
      .single()

    if (jobError || !job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = job as any

    return NextResponse.json({
      id: row.id,
      projectId: row.project_id,
      status: row.status,
      progress: row.progress,
      statusMessage: row.status_message,
      extractionRunId: row.extraction_run_id,
      constraintFlags: row.constraint_flags,
      classifyResult: row.classify_result,
      extractionSummary: row.extraction_summary,
      phaseData: row.phase_data ?? {},
      error: row.error_message ? {
        message: row.error_message,
        phase: row.error_phase,
      } : null,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
    })
  } catch (error) {
    console.error('GET /api/jobs/[id] error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
