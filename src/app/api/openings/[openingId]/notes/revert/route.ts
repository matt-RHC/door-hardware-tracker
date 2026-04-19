/**
 * POST /api/openings/[openingId]/notes/revert
 *
 * Swaps notes_ai_summary ↔ notes_ai_summary_previous so the user can
 * un-do a regeneration that produced a worse output. Symmetric: a second
 * revert call swaps them back.
 *
 * 400 if there's no previous version to revert to.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { logActivity } from '@/lib/activity-log'
import { ACTIVITY_ACTIONS } from '@/lib/constants/activity-actions'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ openingId: string }> },
) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authErr } = await supabase.auth.getUser()
    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { openingId } = await params

    // Read project_id (for activity log) + both summary slots in one round-trip.
    const { data: state, error: readErr } = await supabase
      .from('openings')
      .select('project_id, notes_ai_summary, notes_ai_summary_previous')
      .eq('id', openingId)
      .single()

    if (readErr) {
      if (readErr.code === 'PGRST116') {
        return NextResponse.json({ error: 'Opening not found' }, { status: 404 })
      }
      console.error('[openings/notes/revert] read failed:', readErr.message)
      return NextResponse.json({ error: 'Failed to read opening' }, { status: 500 })
    }

    if (!state.notes_ai_summary_previous) {
      return NextResponse.json(
        { error: 'No previous summary to revert to' },
        { status: 400 },
      )
    }

    // Swap. Keep both slots populated so a second revert call swaps back.
    const { error: updateErr } = await supabase
      .from('openings')
      .update({
        notes_ai_summary: state.notes_ai_summary_previous,
        notes_ai_summary_previous: state.notes_ai_summary,
        notes_ai_summary_at: new Date().toISOString(),
        // Don't touch the stale flag — reverting doesn't mean the notes
        // changed, so staleness state from before the regenerate is still
        // accurate. (If the user's revert was BECAUSE the new summary was
        // bad, the previous summary may already have been stale; leaving
        // the flag alone preserves that signal.)
      })
      .eq('id', openingId)

    if (updateErr) {
      console.error('[openings/notes/revert] update failed:', updateErr.message)
      return NextResponse.json({ error: 'Failed to revert summary' }, { status: 500 })
    }

    void logActivity({
      projectId: state.project_id,
      userId: user.id,
      action: ACTIVITY_ACTIONS.PUNCH_NOTES_REVERTED,
      entityType: 'opening',
      entityId: openingId,
      details: { scope: 'opening' },
    })

    return NextResponse.json({
      summary: state.notes_ai_summary_previous,
      previous: state.notes_ai_summary,
      reverted_at: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[openings/notes/revert] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
