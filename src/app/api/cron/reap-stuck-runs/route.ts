import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import { reapStuckExtractionRuns } from '@/lib/extraction-staging'

const STUCK_AGE_MINUTES = 30

function verifyCronAuth(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return false
  return authHeader === `Bearer ${cronSecret}`
}

// GET handler — called by Vercel cron every 30 minutes (vercel.json).
//
// Marks any extraction_runs row that has been in status='extracting' for
// longer than STUCK_AGE_MINUTES as 'failed'. Defends against Vercel
// function timeouts / worker crashes that prevent the orchestrator's
// catch handler from running updateExtractionRun({status:'failed'}).
//
// Job route maxDuration is 800s (~13 min); 30 min threshold leaves
// plenty of headroom for a long-but-legitimate run while catching
// anything that's truly stuck.
export async function GET(request: NextRequest) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const adminSupabase = createAdminSupabaseClient()
    const reaped = await reapStuckExtractionRuns(adminSupabase, STUCK_AGE_MINUTES)

    if (reaped.length > 0) {
      console.warn(
        `[reap-stuck-runs] Reaped ${reaped.length} stuck extraction run(s):`,
        reaped.map(r => ({ id: r.id, started_at: r.started_at })),
      )
    } else {
      console.log('[reap-stuck-runs] No stuck runs found')
    }

    return NextResponse.json({
      success: true,
      reapedCount: reaped.length,
      stuckAgeMinutes: STUCK_AGE_MINUTES,
      reaped: reaped.map(r => ({ id: r.id, started_at: r.started_at })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Reaper failed'
    console.error('[reap-stuck-runs] Error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
