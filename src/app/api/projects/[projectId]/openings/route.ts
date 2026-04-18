import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { OPENING_LIST_SELECT } from '@/lib/supabase-selects'

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
  pdf_page: number | null
  leaf_count: number
  is_active: boolean
  floor_number: number | null
  zone_name: string | null
  created_at: string
  hardware_items: Array<{ id: string }>
  checklist_progress: Array<{
    id: string
    checked: boolean
    received: boolean | null
    pre_install: boolean | null
    installed: boolean | null
    qa_qc: boolean | null
  }>
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
      .select(OPENING_LIST_SELECT)
      .eq('project_id', projectId)
      .order('door_number', { ascending: true })

    if (openingsError) {
      console.error('Error fetching openings:', openingsError)
      return NextResponse.json(
        { error: 'Failed to fetch openings' },
        { status: 500 }
      )
    }

    // Transform data to include counts + per-stage breakdown.
    //
    // total_items counts per-leaf rows on pair doors (split-placement items
    // emit one row per leaf — see PAIR_LEAF_PLACEMENT in hardware-taxonomy.ts
    // and the projects/[id]/summary route for the full rationale).
    const transformedOpenings = (openings as OpeningWithCounts[]).map((opening) => {
      const cp = opening.checklist_progress || []
      return {
        ...opening,
        total_items: opening.hardware_items?.length || 0,
        checked_items: cp.filter((c) => c.checked).length || 0,
        total_checklist: cp.length || 0,
        stage_counts: {
          received: cp.filter((c) => c.received).length,
          pre_install: cp.filter((c) => c.pre_install).length,
          installed: cp.filter((c) => c.installed).length,
          qa_qc: cp.filter((c) => c.qa_qc).length,
        },
        hardware_items: undefined,
        checklist_progress: undefined,
      }
    })

    return NextResponse.json(transformedOpenings)
  } catch (error) {
    console.error('Openings GET error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
