import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { logActivity } from '@/lib/activity-log'
import { isValidTransition } from '@/lib/utils/issue-transitions'

type RouteParams = { params: Promise<{ projectId: string; issueId: string }> }

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId, issueId } = await params

    const { data: membership } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // Fetch issue with related data
    const { data: issue, error } = await (supabase as any)
      .from('issues')
      .select(`
        *,
        issue_comments ( * ),
        issue_attachments ( * ),
        issue_links!issue_links_source_issue_id_fkey ( * ),
        issue_watches ( * )
      `)
      .eq('id', issueId)
      .eq('project_id', projectId)
      .single()

    if (error || !issue) {
      return NextResponse.json({ error: 'Issue not found' }, { status: 404 })
    }

    return NextResponse.json(issue)
  } catch (error) {
    console.error('Issue GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId, issueId } = await params

    const { data: membership } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // Fetch current issue state for transition validation
    const { data: current, error: fetchError } = await (supabase as any)
      .from('issues')
      .select('*')
      .eq('id', issueId)
      .eq('project_id', projectId)
      .single()

    if (fetchError || !current) {
      return NextResponse.json({ error: 'Issue not found' }, { status: 404 })
    }

    const body = await request.json()

    // Validate status transition if status is being changed
    if (body.status && body.status !== current.status) {
      if (!isValidTransition(current.status, body.status)) {
        return NextResponse.json(
          { error: `Invalid status transition from '${current.status}' to '${body.status}'` },
          { status: 400 }
        )
      }
    }

    // Build the update object with only allowed fields
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: Record<string, any> = {}
    const allowedFields = [
      'status', 'severity', 'assigned_to', 'awaiting_from', 'title',
      'description', 'resolution_summary', 'category', 'issue_type',
      'opening_id', 'hardware_item_id', 'due_at',
    ]
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        updates[field] = body[field]
      }
    }

    // Handle status-specific side effects
    if (body.status && body.status !== current.status) {
      if (body.status === 'awaiting_action') {
        updates.awaited_since = new Date().toISOString()
      }
      if (body.status === 'resolved') {
        updates.resolved_at = new Date().toISOString()
      }
      // Clear awaited_since when leaving awaiting_action
      if (current.status === 'awaiting_action' && body.status !== 'awaiting_action') {
        updates.awaited_since = null
      }
    }

    updates.updated_at = new Date().toISOString()

    const { data: updated, error: updateError } = await (supabase as any)
      .from('issues')
      .update(updates)
      .eq('id', issueId)
      .eq('project_id', projectId)
      .select()
      .single()

    if (updateError) {
      console.error('Issue PATCH error:', updateError)
      return NextResponse.json({ error: 'Failed to update issue' }, { status: 500 })
    }

    // Fire-and-forget activity logs
    if (body.status && body.status !== current.status) {
      logActivity({
        projectId,
        userId: user.id,
        action: 'issue_status_changed',
        entityType: 'issue',
        entityId: issueId,
        details: {
          old_status: current.status,
          new_status: body.status,
        },
      })
    }

    if (body.assigned_to && body.assigned_to !== current.assigned_to) {
      logActivity({
        projectId,
        userId: user.id,
        action: 'issue_assigned',
        entityType: 'issue',
        entityId: issueId,
        details: {
          old_assigned_to: current.assigned_to,
          new_assigned_to: body.assigned_to,
        },
      })
    }

    return NextResponse.json(updated)
  } catch (error) {
    console.error('Issue PATCH error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId, issueId } = await params

    const { data: membership } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // Hard delete — consistent with existing patterns in the codebase
    const { error } = await (supabase as any)
      .from('issues')
      .delete()
      .eq('id', issueId)
      .eq('project_id', projectId)

    if (error) {
      console.error('Issue DELETE error:', error)
      return NextResponse.json({ error: 'Failed to delete issue' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Issue DELETE error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
