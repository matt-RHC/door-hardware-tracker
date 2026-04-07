import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

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

    const { data: issues, error } = await (supabase as any)
      .from('issues')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch issues' }, { status: 500 })
    }

    return NextResponse.json(issues)
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

    // Generate short issue ID
    const { count } = await (supabase as any)
      .from('issues')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
    const seq = (count || 0) + 1
    const issueIdShort = `ISS-${seq.toString().padStart(3, '0')}`

    const { data: issue, error } = await (supabase as any)
      .from('issues')
      .insert({
        project_id: projectId,
        opening_id: body.opening_id || null,
        hardware_item_id: body.hardware_item_id || null,
        door_number: body.door_number || null,
        hardware_item_name: body.hardware_item_name || null,
        issue_id_short: issueIdShort,
        description: body.description,
        severity: body.severity || 'medium',
        status: 'open',
        assigned_to: body.assigned_to || null,
        reported_by: user.email || 'unknown',
      })
      .select()
      .single()

    if (error) {
      console.error('Error creating issue:', error)
      return NextResponse.json({ error: 'Failed to create issue' }, { status: 500 })
    }

    // Auto-sync to Smartsheet (non-blocking)
    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://trackdoorhardware.app'
      fetch(`${appUrl}/api/projects/${projectId}/sync-issues`, {
        method: 'POST',
        headers: { cookie: request.headers.get('cookie') || '' },
      }).catch(err => { console.error('[smartsheet-sync] Background issues sync failed:', err) })
    } catch {}

    return NextResponse.json(issue, { status: 201 })
  } catch (error) {
    console.error('Issues POST error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
