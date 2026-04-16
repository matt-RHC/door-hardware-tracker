import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'

async function verifyAccess(projectId: string) {
  const supabase = await createServerSupabaseClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return { error: 'Unauthorized', status: 401, user: null }

  const { data: projectMember, error: memberError } = await supabase
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', user.id)
    .single()

  if (memberError || !projectMember) return { error: 'Access denied', status: 403, user: null }

  return { error: null, status: 200, user }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params
    const auth = await verifyAccess(projectId)
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

    const adminSupabase = createAdminSupabaseClient()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (adminSupabase as any)
      .from('dashboard_shares')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Error fetching dashboard shares:', error)
      return NextResponse.json({ error: 'Failed to fetch shares' }, { status: 500 })
    }

    return NextResponse.json({ data: data ?? [] })
  } catch (error) {
    console.error('Dashboard shares GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params
    const auth = await verifyAccess(projectId)
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

    const body = await request.json()
    const { label, permissions, expires_at } = body ?? {}

    const adminSupabase = createAdminSupabaseClient()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (adminSupabase as any)
      .from('dashboard_shares')
      .insert({
        project_id: projectId,
        shared_by: auth.user!.id,
        label: label ?? null,
        permissions: permissions ?? ['view_progress'],
        expires_at: expires_at ?? null,
      })
      .select()
      .single()

    if (error) {
      console.error('Error creating dashboard share:', error)
      return NextResponse.json({ error: 'Failed to create share' }, { status: 500 })
    }

    return NextResponse.json({ data }, { status: 201 })
  } catch (error) {
    console.error('Dashboard shares POST error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params
    const auth = await verifyAccess(projectId)
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status })

    const { searchParams } = new URL(request.url)
    const shareId = searchParams.get('id')
    if (!shareId) {
      return NextResponse.json({ error: 'Missing share id' }, { status: 400 })
    }

    const adminSupabase = createAdminSupabaseClient()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (adminSupabase as any)
      .from('dashboard_shares')
      .delete()
      .eq('id', shareId)
      .eq('project_id', projectId)

    if (error) {
      console.error('Error deleting dashboard share:', error)
      return NextResponse.json({ error: 'Failed to delete share' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Dashboard shares DELETE error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
