import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { logActivity } from '@/lib/activity-log'

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

    // Verify issue belongs to project
    const { data: issue } = await (supabase as any)
      .from('issues')
      .select('id')
      .eq('id', issueId)
      .eq('project_id', projectId)
      .single()

    if (!issue) {
      return NextResponse.json({ error: 'Issue not found' }, { status: 404 })
    }

    const { data: comments, error } = await (supabase as any)
      .from('issue_comments')
      .select('*')
      .eq('issue_id', issueId)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('Comments GET error:', error)
      return NextResponse.json({ error: 'Failed to fetch comments' }, { status: 500 })
    }

    return NextResponse.json(comments)
  } catch (error) {
    console.error('Comments GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
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

    // Verify issue belongs to project
    const { data: issue } = await (supabase as any)
      .from('issues')
      .select('id')
      .eq('id', issueId)
      .eq('project_id', projectId)
      .single()

    if (!issue) {
      return NextResponse.json({ error: 'Issue not found' }, { status: 404 })
    }

    const body = await request.json()

    if (!body.body) {
      return NextResponse.json({ error: 'Missing required field: body' }, { status: 400 })
    }

    // Deduplicate email-in comments by email_message_id
    if (body.email_message_id) {
      const { data: existing } = await (supabase as any)
        .from('issue_comments')
        .select('id')
        .eq('issue_id', issueId)
        .eq('email_message_id', body.email_message_id)
        .single()

      if (existing) {
        return NextResponse.json(
          { error: 'Duplicate email comment', existing_id: existing.id },
          { status: 409 }
        )
      }
    }

    const { data: comment, error } = await (supabase as any)
      .from('issue_comments')
      .insert({
        issue_id: issueId,
        author_id: user.id,
        comment_type: body.comment_type || 'user_comment',
        visibility: body.visibility || 'internal',
        body: body.body,
        mentions: body.mentions || [],
        email_message_id: body.email_message_id || null,
        email_from: body.email_from || null,
      })
      .select()
      .single()

    if (error) {
      console.error('Error creating comment:', error)
      return NextResponse.json({ error: 'Failed to create comment' }, { status: 500 })
    }

    // Fire-and-forget activity log
    logActivity({
      projectId,
      userId: user.id,
      action: 'issue_comment_added',
      entityType: 'issue',
      entityId: issueId,
      details: {
        comment_id: comment.id,
        comment_type: body.comment_type || 'user_comment',
      },
    })

    return NextResponse.json(comment, { status: 201 })
  } catch (error) {
    console.error('Comments POST error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
