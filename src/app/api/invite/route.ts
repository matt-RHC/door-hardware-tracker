import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

interface InviteRequest {
  projectId: string
  email: string
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()

    // Check authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body: InviteRequest = await request.json()
    const { projectId, email } = body

    if (!projectId || !email) {
      return NextResponse.json(
        { error: 'Missing projectId or email' },
        { status: 400 }
      )
    }

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

    // Add to project_members
    // Note: In a real application, you would send an email invitation
    const { data: projectMemberRecord, error: addError } = await supabase
      .from('project_members')
      .insert([
        {
          project_id: projectId,
          user_id: user.id, // For now, just associate with current user
          role: 'member',
        } as any,
      ] as any)
      .select()
      .single()

    if (addError) {
      console.error('Error adding project member:', addError)
      return NextResponse.json(
        { error: 'Failed to add project member' },
        { status: 500 }
      )
    }

    return NextResponse.json(projectMemberRecord, { status: 201 })
  } catch (error) {
    console.error('Invite POST error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
