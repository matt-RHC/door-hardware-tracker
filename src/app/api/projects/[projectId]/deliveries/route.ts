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

    const { data: deliveries, error } = await (supabase as any)
      .from('deliveries')
      .select('*')
      .eq('project_id', projectId)
      .order('expected_date', { ascending: true })

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch deliveries' }, { status: 500 })
    }

    return NextResponse.json(deliveries)
  } catch (error) {
    console.error('Deliveries GET error:', error)
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

    const { data: delivery, error } = await (supabase as any)
      .from('deliveries')
      .insert({
        project_id: projectId,
        po_number: body.po_number || null,
        vendor: body.vendor || null,
        description: body.description || null,
        items_summary: body.items_summary || null,
        quantity: body.quantity || null,
        expected_date: body.expected_date || null,
        status: body.status || 'pending',
        tracking_number: body.tracking_number || null,
        notes: body.notes || null,
      })
      .select()
      .single()

    if (error) {
      console.error('Error creating delivery:', error)
      return NextResponse.json({ error: 'Failed to create delivery' }, { status: 500 })
    }

    // Auto-sync to Smartsheet
    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://trackdoorhardware.app'
      fetch(`${appUrl}/api/projects/${projectId}/sync-delivery`, {
        method: 'POST',
        headers: { cookie: request.headers.get('cookie') || '' },
      }).catch(err => { console.error('[smartsheet-sync] Background delivery sync failed:', err) })
    } catch {}

    return NextResponse.json(delivery, { status: 201 })
  } catch (error) {
    console.error('Deliveries POST error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
