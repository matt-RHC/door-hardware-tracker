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

    const url = new URL(request.url)
    const deliveryId = url.searchParams.get('delivery_id')
    const status = url.searchParams.get('status')

    let query = (supabase as any)
      .from('delivery_items')
      .select(`
        *,
        hardware_item:hardware_items(id, name),
        delivery:deliveries!inner(id, po_number, project_id)
      `)
      .eq('delivery.project_id', projectId)

    if (deliveryId) {
      query = query.eq('delivery_id', deliveryId)
    }
    if (status) {
      query = query.eq('status', status)
    }

    const { data, error } = await query.order('created_at', { ascending: false })

    if (error) {
      console.error('Delivery items GET error:', error)
      return NextResponse.json({ error: 'Failed to fetch delivery items' }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (error) {
    console.error('Delivery items GET error:', error)
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

    // Verify the delivery belongs to this project
    const { data: delivery } = await (supabase as any)
      .from('deliveries')
      .select('id')
      .eq('id', body.delivery_id)
      .eq('project_id', projectId)
      .single()

    if (!delivery) {
      return NextResponse.json({ error: 'Delivery not found in this project' }, { status: 404 })
    }

    const { data, error } = await (supabase as any)
      .from('delivery_items')
      .insert({
        delivery_id: body.delivery_id,
        hardware_item_id: body.hardware_item_id || null,
        opening_id: body.opening_id || null,
        qty_expected: body.qty_expected ?? 1,
        status: body.status || 'expected',
        eta: body.eta || null,
        notes: body.notes || null,
      })
      .select()
      .single()

    if (error) {
      console.error('Error creating delivery item:', error)
      return NextResponse.json({ error: 'Failed to create delivery item' }, { status: 500 })
    }

    return NextResponse.json(data, { status: 201 })
  } catch (error) {
    console.error('Delivery items POST error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
