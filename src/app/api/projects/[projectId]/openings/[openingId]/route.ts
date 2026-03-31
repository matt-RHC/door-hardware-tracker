import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

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
        name,
        description,
        location,
        status,
        created_at,
        updated_at,
        hardware_items(
          id,
          name,
          category,
          quantity,
          specification,
          notes,
          created_at,
          updated_at
        ),
        checklist_progress(
          id,
          item_id,
          checked,
          checked_by,
          checked_at,
          created_at,
          updated_at
        ),
        attachments(
          id,
          file_name,
          file_url,
          file_type,
          file_size,
          uploaded_by,
          created_at
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

    // Merge hardware items with their progress
    const hardware_items = (opening as any).hardware_items?.map((item: any) => {
      const progress = (opening as any).checklist_progress?.find(
        (p: any) => p.item_id === item.id
      )
      return {
        ...item,
        progress,
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
