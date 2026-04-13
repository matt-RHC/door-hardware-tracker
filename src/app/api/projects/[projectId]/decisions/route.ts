import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

/**
 * GET /api/projects/[projectId]/decisions
 *
 * Load all extraction decisions for a project.
 * Used on re-import to skip already-answered questions.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId } = await params

    const { data, error } = await supabase
      .from('extraction_decisions')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ decisions: data ?? [] })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/projects/[projectId]/decisions
 *
 * Save extraction decisions (batch).
 * Called when user completes the Punchy review phase.
 *
 * Body: { decisions: Array<{
 *   decision_type, item_category?, set_id?, item_name?,
 *   question_text?, answer, resolved_value?, applied_count?
 * }> }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId } = await params

    // Verify project membership (PR #141 intent — the authz block had
    // been nested inside the auth-failure branch, making it unreachable
    // AND using projectId before declaration. Fixed: membership check
    // runs after auth passes and after projectId is resolved.)
    const { data: membership } = await supabase
      .from('project_members')
      .select('id')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!membership) {
      return NextResponse.json({ error: 'Not a project member' }, { status: 403 })
    }

    const body = await request.json()
    const decisions = body.decisions as Array<{
      decision_type: string
      item_category?: string
      set_id?: string
      item_name?: string
      question_text?: string
      answer: string
      resolved_value?: Record<string, unknown>
      applied_count?: number
    }>

    if (!decisions || decisions.length === 0) {
      return NextResponse.json({ error: 'No decisions provided' }, { status: 400 })
    }

    const rows = decisions.map(d => ({
      project_id: projectId,
      decision_type: d.decision_type,
      item_category: d.item_category ?? null,
      set_id: d.set_id ?? null,
      item_name: d.item_name ?? null,
      question_text: d.question_text ?? null,
      answer: d.answer,
      resolved_value: d.resolved_value ?? null,
      applied_count: d.applied_count ?? 0,
      created_by: user.id,
    }))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.from('extraction_decisions') as any)
      .insert(rows)
      .select('id')

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ saved: data?.length ?? 0 })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
