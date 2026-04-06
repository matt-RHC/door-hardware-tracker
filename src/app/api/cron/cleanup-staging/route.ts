import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabaseClient } from '@/lib/supabase/server'

// Vercel cron secret protects this endpoint
function verifyCronAuth(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return false
  return authHeader === `Bearer ${cronSecret}`
}

// GET handler — called by Vercel cron daily
export async function GET(request: NextRequest) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const adminSupabase = createAdminSupabaseClient()
    const { data, error } = await adminSupabase.rpc('cleanup_old_staging')

    if (error) {
      console.error('Staging cleanup failed:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    console.log(`Staging cleanup complete: ${data} old extraction runs deleted`)
    return NextResponse.json({
      success: true,
      message: 'Staging cleanup complete',
      deletedRuns: data,
    })
  } catch (error) {
    console.error('Staging cleanup error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Staging cleanup failed' },
      { status: 500 }
    )
  }
}
