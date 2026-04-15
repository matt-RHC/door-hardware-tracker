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

    // Verify user has access to project
    const { data: member, error: memberError } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (memberError || !member) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // Fetch all checklist_progress rows with unresolved QA findings for this project
    // Join with openings and hardware_items
    const { data: rows, error: fetchError } = await supabase
      .from('checklist_progress')
      .select(`
        id,
        opening_id,
        item_id,
        leaf_index,
        qa_findings,
        qa_notes,
        qa_qc,
        qa_resolved_at,
        qa_resolved_by,
        openings!inner (
          id,
          door_number,
          location,
          project_id
        ),
        hardware_items!inner (
          id,
          name,
          manufacturer,
          model,
          finish
        )
      `)
      .eq('openings.project_id', projectId)
      .not('qa_findings', 'eq', '{}')
      .is('qa_resolved_at', null)
      .order('opening_id')

    if (fetchError) {
      console.error('Error fetching punch list:', fetchError)
      return NextResponse.json(
        { error: 'Failed to fetch punch list' },
        { status: 500 }
      )
    }

    // Flatten the joined data
    const items = (rows ?? []).map((row: any) => ({
      id: row.id,
      opening_id: row.opening_id,
      item_id: row.item_id,
      leaf_index: row.leaf_index,
      door_number: row.openings?.door_number ?? '',
      location: row.openings?.location ?? null,
      item_name: row.hardware_items?.name ?? '',
      manufacturer: row.hardware_items?.manufacturer ?? null,
      model: row.hardware_items?.model ?? null,
      finish: row.hardware_items?.finish ?? null,
      qa_findings: row.qa_findings ?? [],
      qa_notes: row.qa_notes ?? null,
      qa_qc: row.qa_qc ?? false,
    }))

    return NextResponse.json(items)
  } catch (error) {
    console.error('Punch list GET error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
