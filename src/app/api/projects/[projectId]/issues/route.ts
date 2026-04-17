import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { logActivity } from '@/lib/activity-log'
import { computeDueAt } from '@/lib/utils/sla'
import type { IssueSeverity } from '@/lib/types/database'

const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low']
const VALID_STATUSES = [
  'created', 'acknowledged', 'awaiting_action', 'blocked',
  'resolved', 'duplicate', 'closed',
]

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId } = await params

    const { data: membership } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const url = request.nextUrl
    const statusFilter = url.searchParams.get('status')
    const severityFilter = url.searchParams.get('severity')
    const assignedTo = url.searchParams.get('assigned_to')
    const openingId = url.searchParams.get('opening_id')
    const category = url.searchParams.get('category')
    const issueType = url.searchParams.get('issue_type')
    const rawPage = parseInt(url.searchParams.get('page') || '1', 10)
    const rawLimit = parseInt(url.searchParams.get('limit') || '25', 10)
    const page = Math.max(1, Number.isNaN(rawPage) ? 1 : rawPage)
    const limit = Math.min(100, Math.max(1, Number.isNaN(rawLimit) ? 25 : rawLimit))
    const offset = (page - 1) * limit

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (supabase as any)
      .from('issues')
      .select('*, issue_comments(count), issue_attachments(count)', { count: 'exact' })
      .eq('project_id', projectId)

    if (statusFilter) {
      const statuses = statusFilter.split(',').filter(s => VALID_STATUSES.includes(s))
      if (statuses.length > 0) query = query.in('status', statuses)
    }
    if (severityFilter) {
      const severities = severityFilter.split(',').filter(s => VALID_SEVERITIES.includes(s))
      if (severities.length > 0) query = query.in('severity', severities)
    }
    if (assignedTo) query = query.eq('assigned_to', assignedTo)
    if (openingId) query = query.eq('opening_id', openingId)
    if (category) query = query.eq('category', category)
    if (issueType) query = query.eq('issue_type', issueType)

    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    const { data: issues, error, count } = await query

    if (error) {
      console.error('Issues GET error:', error)
      return NextResponse.json({ error: 'Failed to fetch issues' }, { status: 500 })
    }

    // Flatten the aggregated counts
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const formatted = (issues ?? []).map((issue: any) => ({
      ...issue,
      comment_count: issue.issue_comments?.[0]?.count ?? 0,
      attachment_count: issue.issue_attachments?.[0]?.count ?? 0,
      issue_comments: undefined,
      issue_attachments: undefined,
    }))

    return NextResponse.json({ data: formatted, total: count ?? 0, page, limit })
  } catch (error) {
    console.error('Issues GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId } = await params

    const { data: membership } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const body = await request.json()

    if (!body.title || !body.category || !body.issue_type) {
      return NextResponse.json(
        { error: 'Missing required fields: title, category, issue_type' },
        { status: 400 }
      )
    }

    const severity: IssueSeverity = VALID_SEVERITIES.includes(body.severity)
      ? body.severity
      : 'medium'

    const now = new Date()
    const dueAt = computeDueAt(severity, now)

    const { data: issue, error } = await (supabase as any)
      .from('issues')
      .insert({
        project_id: projectId,
        opening_id: body.opening_id || null,
        hardware_item_id: body.hardware_item_id || null,
        category: body.category,
        issue_type: body.issue_type,
        severity,
        status: 'created',
        title: body.title,
        description: body.description || null,
        reported_by: user.id,
        source: body.source || 'form',
        source_data: body.source_data || {},
        parse_confidence: body.parse_confidence ?? 1.0,
        due_at: dueAt.toISOString(),
      })
      .select()
      .single()

    if (error) {
      console.error('Error creating issue:', error)
      return NextResponse.json({ error: 'Failed to create issue' }, { status: 500 })
    }

    // Fire-and-forget activity log
    logActivity({
      projectId,
      userId: user.id,
      action: 'issue_created',
      entityType: 'issue',
      entityId: issue.id,
      details: {
        title: body.title,
        category: body.category,
        issue_type: body.issue_type,
        severity,
        source: body.source || 'form',
      },
    })

    return NextResponse.json(issue, { status: 201 })
  } catch (error) {
    console.error('Issues POST error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
