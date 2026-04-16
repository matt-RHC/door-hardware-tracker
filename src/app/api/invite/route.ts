import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'

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

    // Look up the invited user by email using admin client
    const adminSupabase = createAdminSupabaseClient()
    const { data: invitedUsers, error: lookupError } = await adminSupabase
      .auth.admin.listUsers()

    if (lookupError) {
      console.error('Error looking up users:', lookupError)
      return NextResponse.json(
        { error: 'Failed to look up user' },
        { status: 500 }
      )
    }

    const invitedUser = invitedUsers.users.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase()
    )

    if (!invitedUser) {
      return NextResponse.json(
        { error: 'No user found with that email address' },
        { status: 404 }
      )
    }

    // Prevent inviting yourself
    if (invitedUser.id === user.id) {
      return NextResponse.json(
        { error: 'You are already a member of this project' },
        { status: 400 }
      )
    }

    // Check if user is already a member
    const { data: existingMember } = await adminSupabase
      .from('project_members')
      .select('id')
      .eq('project_id', projectId)
      .eq('user_id', invitedUser.id)
      .single()

    if (existingMember) {
      return NextResponse.json(
        { error: 'User is already a member of this project' },
        { status: 409 }
      )
    }

    // Add the invited user to project_members
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: projectMemberRecord, error: addError } = await (adminSupabase as any)
      .from('project_members')
      .insert([
        {
          project_id: projectId,
          user_id: invitedUser.id,
          role: 'member',
        },
      ])
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
