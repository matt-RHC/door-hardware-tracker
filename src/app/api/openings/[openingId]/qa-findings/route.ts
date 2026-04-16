import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'

interface QAFindingsRequest {
  item_id: string
  leaf_index?: number
  qa_findings: string[]
  qa_notes?: string | null
}

const VALID_TAGS = new Set([
  'spec_match', 'operation', 'finish', 'fire_rating', 'ada', 'life_safety',
])

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ openingId: string }> }
) {
  try {
    const supabase = await createServerSupabaseClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { openingId } = await params
    const body: QAFindingsRequest = await request.json()
    const { item_id, qa_findings, qa_notes } = body
    const leaf_index = body.leaf_index ?? 1

    if (!item_id) {
      return NextResponse.json({ error: 'Missing item_id' }, { status: 400 })
    }

    // Validate tags
    for (const tag of qa_findings) {
      if (!VALID_TAGS.has(tag)) {
        return NextResponse.json(
          { error: `Invalid QA finding tag: ${tag}` },
          { status: 400 }
        )
      }
    }

    // Verify opening exists and user has access
    const { data: opening, error: openingError } = await supabase
      .from('openings')
      .select('project_id')
      .eq('id', openingId)
      .single()

    if (openingError || !opening) {
      return NextResponse.json({ error: 'Opening not found' }, { status: 404 })
    }

    const { data: member, error: memberError } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', (opening as any).project_id)
      .eq('user_id', user.id)
      .single()

    if (memberError || !member) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const adminSupabase = createAdminSupabaseClient()
    const now = new Date().toISOString()

    // Build update payload
    const updatePayload: Record<string, any> = {
      qa_findings,
      qa_notes: qa_notes ?? null,
    }

    // Auto-resolve: if findings are empty and notes are cleared, mark resolved
    if (qa_findings.length === 0 && !qa_notes) {
      updatePayload.qa_resolved_at = now
      updatePayload.qa_resolved_by = user.id
    } else {
      // Has findings — clear resolution
      updatePayload.qa_resolved_at = null
      updatePayload.qa_resolved_by = null
    }

    const { data: result, error: updateError } = await (adminSupabase as any)
      .from('checklist_progress')
      .update(updatePayload)
      .eq('opening_id', openingId)
      .eq('item_id', item_id)
      .eq('leaf_index', leaf_index)
      .select()
      .single()

    if (updateError) {
      console.error('Error updating QA findings:', updateError)
      return NextResponse.json(
        { error: 'Failed to update QA findings' },
        { status: 500 }
      )
    }

    return NextResponse.json(result)
  } catch (error) {
    console.error('QA findings PATCH error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
