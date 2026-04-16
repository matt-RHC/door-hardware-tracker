import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId } = await params

    const { data: membership } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const { data, error } = await (supabase as any)
      .from('openings_blocked_v')
      .select('*')
      .eq('project_id', projectId)

    if (error) {
      console.error('Blocked openings GET error:', error)
      return NextResponse.json({ error: 'Failed to fetch blocked openings' }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (error) {
    console.error('Blocked openings GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
