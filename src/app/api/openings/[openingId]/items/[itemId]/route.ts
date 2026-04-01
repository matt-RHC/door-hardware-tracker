import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase/server'
import { HardwareItemUpdate } from '@/lib/types/database'

interface UpdateItemRequest {
  name?: string
  qty?: number
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
    if (body.qty !== undefined) updateData.qty = body.qty
    if ('manufacturer' in body) updateData.manufacturer = body.manufacturer
    if ('model' in body) updateData.model = body.model
    if ('finish' in body) updateData.finish = body.finish
    if ('options' in body) updateData.options = body.options
    if ('install_type' in body) updateData.install_type = body.install_type

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

    return NextResponse.json(updatedItem)
  } catch (error) {
    console.error('Update item PATCH error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
