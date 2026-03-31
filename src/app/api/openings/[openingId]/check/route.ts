import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { v4 as uuidv4 } from 'uuid'

interface CheckItemRequest {
  item_id: string
  checked: boolean
}

export async function POST(
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
    const body: CheckItemRequest = await request.json()
    const { item_id, checked } = body

    if (!item_id || checked === undefined) {
      return NextResponse.json(
        { error: 'Missing item_id or checked field' },
        { status: 400 }
      )
    }

    // Verify opening exists and user has access
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

    // Get user email for checked_by
    const { data: { user: userData } } = await supabase.auth.getUser()
    const checkedBy = userData?.email || 'unknown'

    // Upsert checklist progress
    const { data: result, error: upsertError } = await (supabase as any)
      .from('checklist_progress')
      .upsert(
        [{
          id: uuidv4(),
          opening_id: openingId,
          item_id,
          checked,
          checked_by: checked ? checkedBy : null,
          checked_at: checked ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        }],
        {
          onConflict: 'opening_id,item_id',
        }
      )
      .select()
      .single()

    if (upsertError) {
      console.error('Error upserting checklist progress:', upsertError)
      return NextResponse.json(
        { error: 'Failed to update checklist' },
        { status: 500 }
      )
    }

    return NextResponse.json(result)
  } catch (error) {
    console.error('Check item POST error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
