import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase/server'

interface BulkUpdateRequest {
  original_name: string
  updates: {
    name?: string
    manufacturer?: string | null
    model?: string | null
    finish?: string | null
    options?: string | null
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
    const body: BulkUpdateRequest = await request.json()
    const { original_name, updates } = body

    if (!original_name || !updates || Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'original_name and updates required' }, { status: 400 })
    }

    // Verify user has access to project
    const { data: projectMember, error: memberError } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (memberError || !projectMember) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const adminSupabase = createAdminSupabaseClient()

    // Get all openings in this project
    const { data: openings, error: openingsError } = await (adminSupabase as any)
      .from('openings')
      .select('id')
      .eq('project_id', projectId)

    if (openingsError) {
      return NextResponse.json({ error: 'Failed to fetch openings' }, { status: 500 })
    }

    if (!openings || openings.length === 0) {
      return NextResponse.json({ updated: 0, items: [] })
    }

    const openingIds = openings.map((o: any) => o.id)

    // Update all hardware items with matching original name across all openings
    const { data: updatedItems, error: updateError } = await (adminSupabase as any)
      .from('hardware_items')
      .update(updates as any)
      .in('opening_id', openingIds)
      .eq('name', original_name)
      .select('id, name, opening_id, manufacturer, model, finish, options')

    if (updateError) {
      console.error('Error bulk updating items:', updateError)
      return NextResponse.json({ error: 'Failed to update items' }, { status: 500 })
    }

    return NextResponse.json({
      updated: updatedItems?.length || 0,
      items: updatedItems || [],
    })
  } catch (error) {
    console.error('Bulk update items error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
