import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import { HardwareItemUpdate } from '@/lib/types/database'
import { logActivity } from '@/lib/activity-log'

interface UpdateItemRequest {
  name?: string
  qty?: number
  qty_source?: string | null
  manufacturer?: string | null
  model?: string | null
  finish?: string | null
  options?: string | null
  install_type?: 'bench' | 'field' | null
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ openingId: string; itemId: string }> }
) {
  try {
    const supabase = await createServerSupabaseClient()

    // Check authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { openingId, itemId } = await params
    const body: UpdateItemRequest = await request.json()

    // Verify opening exists and user has access to the project
    const { data: opening, error: openingError } = await supabase
      .from('openings')
      .select('project_id')
      .eq('id', openingId)
      .single()

    if (openingError || !opening) {
      return NextResponse.json(
        { error: 'Opening not found' },
        { status: 404 }
      )
    }

    // Verify user has access to project
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: projectMember, error: memberError } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', (opening as any).project_id)
      .eq('user_id', user.id)
      .single()

    if (memberError || !projectMember) {
      return NextResponse.json(
        { error: 'Access denied' },
        { status: 403 }
      )
    }

    // Verify hardware item belongs to this opening
    const { data: item, error: itemError } = await supabase
      .from('hardware_items')
      .select('opening_id')
      .eq('id', itemId)
      .single()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (itemError || !item || (item as any).opening_id !== openingId) {
      return NextResponse.json(
        { error: 'Hardware item not found' },
        { status: 404 }
      )
    }

    // Use admin client for the update to bypass RLS if needed
    const adminSupabase = createAdminSupabaseClient()

    const updateData: HardwareItemUpdate = {}
    if (body.name !== undefined) updateData.name = body.name
    if (body.qty !== undefined) {
      updateData.qty = body.qty
      if (!body.qty_source) updateData.qty_source = 'manual'
    }
    if ('manufacturer' in body) updateData.manufacturer = body.manufacturer
    if ('model' in body) updateData.model = body.model
    if ('finish' in body) updateData.finish = body.finish
    if ('options' in body) updateData.options = body.options
    if ('install_type' in body) updateData.install_type = body.install_type
    if ('qty_source' in body) updateData.qty_source = body.qty_source

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: updatedItem, error: updateError } = await (adminSupabase as any)
      .from('hardware_items')
      .update(updateData as any)
      .eq('id', itemId)
      .select()
      .single()

    if (updateError) {
      console.error('Error updating hardware item:', updateError)
      return NextResponse.json(
        { error: 'Failed to update hardware item' },
        { status: 500 }
      )
    }

    // Log the appropriate action based on what changed
    const action = 'install_type' in body && Object.keys(body).length === 1
      ? 'install_type_changed' as const
      : 'item_edited' as const

    logActivity({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      projectId: (opening as any).project_id,
      userId: user.id,
      action,
      entityType: 'hardware_item',
      entityId: itemId,
      details: { opening_id: openingId, updates: body },
    })

    return NextResponse.json(updatedItem)
  } catch (error) {
    console.error('Update item PATCH error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
