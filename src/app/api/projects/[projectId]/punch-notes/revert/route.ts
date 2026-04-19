/**
 * POST /api/projects/[projectId]/punch-notes/revert
 *
 * Symmetric to /api/openings/[id]/notes/revert but at the project level.
 * Swaps punch_notes_ai_summary ↔ punch_notes_ai_summary_previous.
 *
 * 400 if there's no previous version to revert to.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { logActivity } from '@/lib/activity-log'
import { ACTIVITY_ACTIONS } from '@/lib/constants/activity-actions'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authErr } = await supabase.auth.getUser()
    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId } = await params

    const { data: state, error: readErr } = await supabase
      .from('projects')
      .select('punch_notes_ai_summary, punch_notes_ai_summary_previous')
      .eq('id', projectId)
      .single()

    if (readErr) {
      if (readErr.code === 'PGRST116') {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 })
      }
      console.error('[projects/punch-notes/revert] read failed:', readErr.message)
      return NextResponse.json({ error: 'Failed to read project' }, { status: 500 })
    }

    if (!state.punch_notes_ai_summary_previous) {
      return NextResponse.json(
        { error: 'No previous summary to revert to' },
        { status: 400 },
      )
    }

    const { error: updateErr } = await supabase
      .from('projects')
      .update({
        punch_notes_ai_summary: state.punch_notes_ai_summary_previous,
        punch_notes_ai_summary_previous: state.punch_notes_ai_summary,
        punch_notes_ai_summary_at: new Date().toISOString(),
      })
      .eq('id', projectId)

    if (updateErr) {
      console.error('[projects/punch-notes/revert] update failed:', updateErr.message)
      return NextResponse.json({ error: 'Failed to revert summary' }, { status: 500 })
    }

    void logActivity({
      projectId,
      userId: user.id,
      action: ACTIVITY_ACTIONS.PUNCH_NOTES_REVERTED,
      entityType: 'project',
      entityId: projectId,
      details: { scope: 'project' },
    })

    return NextResponse.json({
      summary: state.punch_notes_ai_summary_previous,
      previous: state.punch_notes_ai_summary,
      reverted_at: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[projects/punch-notes/revert] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
