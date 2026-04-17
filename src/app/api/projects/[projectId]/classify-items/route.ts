import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import { logActivity } from '@/lib/activity-log'

interface ClassifyRequest {
  item_name: string
  install_type: 'bench' | 'field'
  item_ids?: string[]  // optional: specific IDs to update (for "just this one")
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const supabase = await createServerSupabaseClient()

    // Check authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId } = await params
    const body: ClassifyRequest = await request.json()
    const { item_name, install_type, item_ids } = body

    if (!item_name || !install_type) {
      return NextResponse.json({ error: 'item_name and install_type required' }, { status: 400 })
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: openings, error: openingsError } = await (adminSupabase as any)
      .from('openings')
      .select('id')
      .eq('project_id', projectId)

    if (openingsError) {
      console.error('Error fetching openings:', openingsError)
      return NextResponse.json({ error: 'Failed to fetch openings' }, { status: 500 })
    }

    if (!openings || openings.length === 0) {
      return NextResponse.json({ updated: 0, items: [] })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openingIds = openings.map((o: any) => o.id)

    if (item_ids && item_ids.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (adminSupabase as any)
        .from('hardware_items')
        .update({ install_type } as any)
        .in('id', item_ids)
        .in('opening_id', openingIds)
        .select('id, name, install_type')

      if (error) {
        console.error('Error classifying specific items:', error)
        return NextResponse.json({ error: 'Failed to classify items' }, { status: 500 })
      }

      logActivity({
        projectId,
        userId: user.id,
        action: 'install_type_changed',
        entityType: 'hardware_item',
        details: {
          item_name,
          install_type,
          item_ids,
          updated_count: data?.length ?? 0,
        },
      })

      return NextResponse.json({ updated: data?.length || 0, items: data })
    }

    // Update all hardware items with matching name across all openings in the project
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: updatedItems, error: updateError } = await (adminSupabase as any)
      .from('hardware_items')
      .update({ install_type } as any)
      .in('opening_id', openingIds)
      .eq('name', item_name)
      .select('id, name, opening_id, install_type')

    if (updateError) {
      console.error('Error classifying items across project:', updateError)
      return NextResponse.json({ error: 'Failed to classify items' }, { status: 500 })
    }

    logActivity({
      projectId,
      userId: user.id,
      action: 'install_type_changed',
      entityType: 'hardware_item',
      details: {
        item_name,
        install_type,
        updated_count: updatedItems?.length ?? 0,
      },
    })

    return NextResponse.json({
      updated: updatedItems?.length || 0,
      items: updatedItems || [],
    })
  } catch (error) {
    console.error('Classify items error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// GET: Count how many items with a given name exist across the project
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
    const url = new URL(request.url)
    const itemName = url.searchParams.get('item_name')

    if (!itemName) {
      return NextResponse.json({ error: 'item_name query param required' }, { status: 400 })
    }

    // Verify user has access to project
    const { data: projectMember } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (!projectMember) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const adminSupabase = createAdminSupabaseClient()

    // Get all openings in project
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: openings } = await (adminSupabase as any)
      .from('openings')
      .select('id')
      .eq('project_id', projectId)

    if (!openings || openings.length === 0) {
      return NextResponse.json({ total: 0, unclassified: 0 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openingIds = openings.map((o: any) => o.id)

    // Count all items with this name
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: items } = await (adminSupabase as any)
      .from('hardware_items')
      .select('id, install_type, opening_id')
      .in('opening_id', openingIds)
      .eq('name', itemName)

    const total = items?.length || 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unclassified = items?.filter((i: any) => !i.install_type).length || 0

    return NextResponse.json({ total, unclassified })
  } catch (error) {
    console.error('Get classify count error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
