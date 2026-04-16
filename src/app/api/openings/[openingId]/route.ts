import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { OPENING_DETAIL_SELECT } from '@/lib/supabase-selects'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ openingId: string }> }
) {
  try {
    const supabase = await createServerSupabaseClient()

    // Check authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { openingId } = await params

    // Get opening with hardware items and checklist progress
    const { data: opening, error: openingError } = await supabase
      .from('openings')
      .select(OPENING_DETAIL_SELECT)
      .eq('id', openingId)
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

    return NextResponse.json(opening)
  } catch (error) {
    console.error('Opening GET error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
