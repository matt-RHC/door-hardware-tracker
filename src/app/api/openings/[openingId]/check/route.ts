import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase/server'
import { v4 as uuidv4 } from 'uuid'

type WorkflowStep = 'received' | 'pre_install' | 'installed' | 'qa_qc' | 'checked'

interface CheckItemRequest {
  item_id: string
  leaf_index?: number  // 1 = Leaf 1 / single door, 2 = Leaf 2 (pair doors)
  checked?: boolean  // legacy support
  step?: WorkflowStep
  value?: boolean
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
    const { item_id } = body

    if (!item_id) {
      return NextResponse.json(
        { error: 'Missing item_id' },
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

    const adminSupabase = createAdminSupabaseClient()
    const now = new Date().toISOString()

    // Determine what to update
    let step: WorkflowStep = body.step || 'checked'
    let value: boolean = body.value !== undefined ? body.value : (body.checked !== undefined ? body.checked : true)

    // Build update payload based on step
    const updatePayload: Record<string, any> = {
      opening_id: openingId,
      item_id,
      leaf_index: body.leaf_index ?? 1,
    }

    if (step === 'checked') {
      // Legacy mode: toggle the old checked field
      updatePayload.checked = value
      updatePayload.checked_by = value ? user.id : null
      updatePayload.checked_at = value ? now : null
    } else if (step === 'received') {
      updatePayload.received = value
      updatePayload.received_by = value ? user.id : null
      updatePayload.received_at = value ? now : null
    } else if (step === 'pre_install') {
      updatePayload.pre_install = value
      updatePayload.pre_install_by = value ? user.id : null
      updatePayload.pre_install_at = value ? now : null
    } else if (step === 'installed') {
      updatePayload.installed = value
      updatePayload.installed_by = value ? user.id : null
      updatePayload.installed_at = value ? now : null
    } else if (step === 'qa_qc') {
      updatePayload.qa_qc = value
      updatePayload.qa_qc_by = value ? user.id : null
      updatePayload.qa_qc_at = value ? now : null
    }

    // Upsert checklist progress
    const { data: result, error: upsertError } = await (adminSupabase as any)
      .from('checklist_progress')
      .upsert(
        [{
          id: uuidv4(),
          ...updatePayload,
        }],
        {
          onConflict: 'opening_id,item_id,leaf_index',
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
