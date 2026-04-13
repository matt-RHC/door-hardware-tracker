import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import { OpeningUpdate } from '@/lib/types/database'

interface UpdateOpeningRequest {
  door_number?: string
  hw_set?: string | null
  hw_heading?: string | null
  location?: string | null
  door_type?: string | null
  frame_type?: string | null
  fire_rating?: string | null
  hand?: string | null
  notes?: string | null
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; openingId: string }> }
) {
  try {
    const supabase = await createServerSupabaseClient()

    // Check authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId, openingId } = await params

    // Verify user has access to project
    const { data: projectMember, error: memberError } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (memberError || !projectMember) {
      return NextResponse.json(
        { error: 'Access denied to this project' },
        { status: 403 }
      )
    }

    // Get opening with all related data
    const { data: opening, error: openingError } = await supabase
      .from('openings')
      .select(`
        id,
        project_id,
        door_number,
        hw_set,
        hw_heading,
        location,
        door_type,
        frame_type,
        fire_rating,
        hand,
        notes,
        pdf_page,
        leaf_count,
        created_at,
        hardware_items(
          id,
          name,
          qty,
          manufacturer,
          model,
          finish,
          options,
          sort_order,
          install_type,
          created_at
        ),
        checklist_progress(
          id,
          item_id,
          leaf_index,
          checked,
          checked_by,
          checked_at,
          received,
          received_by,
          received_at,
          pre_install,
          pre_install_by,
          pre_install_at,
          installed,
          installed_by,
          installed_at,
          qa_qc,
          qa_qc_by,
          qa_qc_at,
          notes,
          created_at
        ),
        attachments(
          id,
          file_name,
          file_url,
          file_type,
          category,
          uploaded_by,
          uploaded_at
        )
      `)
      .eq('id', openingId)
      .eq('project_id', projectId)
      .single()

    if (openingError) {
      if (openingError.code === 'PGRST116') {
        return NextResponse.json(
          { error: 'Opening not found' },
          { status: 404 }
        )
      }
      console.error('Error fetching opening:', openingError)
      return NextResponse.json(
        { error: 'Failed to fetch opening' },
        { status: 500 }
      )
    }

    // Merge hardware items with their progress (per-leaf aware)
    const hardware_items = (opening as any).hardware_items?.map((item: any) => {
      const progressEntries = (opening as any).checklist_progress?.filter(
        (p: any) => p.item_id === item.id
      ) ?? []
      return {
        ...item,
        // Backward compat: single progress object (first entry or undefined)
        progress: progressEntries.length > 0 ? progressEntries[0] : undefined,
        // Per-leaf progress: array of all checklist_progress rows for this item
        progress_by_leaf: progressEntries.length > 0 ? progressEntries : undefined,
      }
    }) || []

    return NextResponse.json({
      ...(opening as any),
      hardware_items,
      checklist_progress: undefined,
    })
  } catch (error) {
    console.error('Opening GET error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; openingId: string }> }
) {
  try {
    const supabase = await createServerSupabaseClient()

    // Check authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId, openingId } = await params
    const body: UpdateOpeningRequest = await request.json()

    // Verify user has access to project
    const { data: projectMember, error: memberError } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (memberError || !projectMember) {
      return NextResponse.json(
        { error: 'Access denied to this project' },
        { status: 403 }
      )
    }

    // Verify opening belongs to project
    const { data: opening, error: openingError } = await supabase
      .from('openings')
      .select('id')
      .eq('id', openingId)
      .eq('project_id', projectId)
      .single()

    if (openingError || !opening) {
      return NextResponse.json(
        { error: 'Opening not found' },
        { status: 404 }
      )
    }

    // Use admin client for the update to bypass RLS if needed
    const adminSupabase = createAdminSupabaseClient()

    const updateData: OpeningUpdate = {}
    if (body.door_number !== undefined) updateData.door_number = body.door_number
    if ('hw_set' in body) updateData.hw_set = body.hw_set
    if ('hw_heading' in body) updateData.hw_heading = body.hw_heading
    if ('location' in body) updateData.location = body.location
    if ('door_type' in body) updateData.door_type = body.door_type
    if ('frame_type' in body) updateData.frame_type = body.frame_type
    if ('fire_rating' in body) updateData.fire_rating = body.fire_rating
    if ('hand' in body) updateData.hand = body.hand
    if ('notes' in body) updateData.notes = body.notes

    const { data: updatedOpening, error: updateError } = await (adminSupabase as any)
      .from('openings')
      .update(updateData as any)
      .eq('id', openingId)
      .select()
      .single()

    if (updateError) {
      console.error('Error updating opening:', updateError)
      return NextResponse.json(
        { error: 'Failed to update opening' },
        { status: 500 }
      )
    }

    return NextResponse.json(updatedOpening)
  } catch (error) {
    console.error('Opening PATCH error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
