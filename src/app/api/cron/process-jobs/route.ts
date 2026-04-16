import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'

export const maxDuration = 30

/**
 * GET /api/cron/process-jobs — Cron handler to pick up stale queued jobs.
 *
 * Finds extraction_jobs stuck in 'queued' status for more than 30 seconds
 * (fire-and-forget from POST /api/jobs may have failed) and re-dispatches
 * them by calling /api/jobs/:id/run.
 *
 * Runs every 2 minutes via Vercel cron (see vercel.json).
 */
function verifyCronAuth(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return false
  return authHeader === `Bearer ${cronSecret}`
}

export async function GET(request: NextRequest) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const adminSupabase = createAdminSupabaseClient()

    // Find jobs that have been queued for more than 30 seconds
    const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString()

    const { data: staleJobs, error } = await adminSupabase
      .from('extraction_jobs')
      .select('id')
      .eq('status', 'queued')
      .lt('created_at', thirtySecondsAgo)
      .order('created_at', { ascending: true })
      .limit(5) // process at most 5 per cron tick

    if (error) {
      console.error('[process-jobs] Failed to query stale jobs:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // ── Recover jobs stuck in intermediate states ──
    // If a Vercel function crashes or times out after leaving 'queued',
    // the job is permanently stuck. Mark it failed after 15 minutes.
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60_000).toISOString()

    const INTERMEDIATE_STATUSES = [
      'classifying',
      'detecting_columns',
      'extracting',
      'triaging',
      'validating',
      'writing_staging',
    ] as const

    const { data: stuckJobs, error: stuckError } = await adminSupabase
      .from('extraction_jobs')
      .select('id, status')
      .in('status', [...INTERMEDIATE_STATUSES])
      .lt('updated_at', fifteenMinutesAgo)
      .limit(5)

    if (stuckError) {
      console.error('[process-jobs] Failed to query stuck jobs:', stuckError.message)
    }

    let recovered = 0
    for (const job of stuckJobs ?? []) {
      const { error: updateError } = await adminSupabase
        .from('extraction_jobs')
        .update({
          status: 'failed',
          error_message: `Job stuck in '${job.status}' for >15 minutes — likely Vercel timeout or crash. Please retry.`,
          error_phase: job.status,
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', job.id)

      if (!updateError) {
        recovered++
        console.log(`[process-jobs] Recovered stuck job ${job.id} (was '${job.status}')`)
      } else {
        console.error(`[process-jobs] Failed to recover job ${job.id}:`, updateError.message)
      }
    }

    if ((!staleJobs || staleJobs.length === 0) && recovered === 0) {
      return NextResponse.json({ dispatched: 0, recovered: 0 })
    }

    // Derive base URL for dispatching run calls
    const requestOrigin = new URL(request.url).origin
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL
      || (requestOrigin && requestOrigin !== 'null' ? requestOrigin : null)
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

    let dispatched = 0
    for (const job of staleJobs) {
      try {
        fetch(`${baseUrl}/api/jobs/${job.id}/run`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': process.env.CRON_SECRET!,
          },
        }).catch(err => {
          console.error(`[process-jobs] Fire-and-forget for job ${job.id} failed:`, err)
        })
        dispatched++
      } catch (err) {
        console.error(`[process-jobs] Failed to dispatch job ${job.id}:`, err)
      }
    }

    console.log(`[process-jobs] Dispatched ${dispatched} stale job(s), recovered ${recovered} stuck job(s)`)
    return NextResponse.json({ dispatched, recovered })
  } catch (error) {
    console.error('[process-jobs] Error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Process jobs failed' },
      { status: 500 }
    )
  }
}
