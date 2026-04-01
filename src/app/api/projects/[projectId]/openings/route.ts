import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

interface OpeningWithCounts {
  id: string
  project_id: string
  door_number: string
  hw_set: string | null
  hw_heading: string | null
  location: string | null
  door_type: string | null
  frame_type: string | null
  fire_rating: string | null
  hand: string | null
  notes: string | null
  created_at: string
  hardware_items: Array<{ id: string }>
  checklist_progress: Array<{ id: string; checked: boolean }>
}

export async function GET(
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

    // Get openings with hardware counts and checklist progress
    const { data: openings, error: openingsError } = await supabase
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
        created_at,
        hardware_items:hardware_items(id),
        checklist_progress(id, checked)
      `)
      .eq('project_id', projectId)
      .order('door_number', { ascending: true })

    if (openingsError) {
      console.error('Error fetching openings:', openingsError)
      return NextResponse.json(
        { error: 'Failed to fetch openings' },
        { status: 500 }
      )
    }

    // Transform data to include counts
    const transformedOpenings = (openings as OpeningWithCounts[]).map((opening) => ({
      ...opening,
      total_items: opening.hardware_items?.length || 0,
      checked_items: opening.checklist_progress?.filter((cp) => cp.checked).length || 0,
      total_checklist: opening.checklist_progress?.length || 0,
      hardware_items: undefined,
      checklist_progress: undefined,
    }))

    return NextResponse.json(transformedOpenings)
  } catch (error) {
    console.error('Openings GET error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
