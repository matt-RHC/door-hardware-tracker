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

    // Verify user has admin access to project (only admins can invite)
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

    if ((projectMember as { role: string }).role !== 'admin') {
      return NextResponse.json(
        { error: 'Only project admins can invite members' },
        { status: 403 }
      )
    }

    // Look up invitee by email using the admin client (auth.admin.listUsers
    // is not available on the client SDK, so we query profiles or use the
    // admin API). Use the admin client to find the user by email.
    const adminSupabase = createAdminSupabaseClient()
    const { data: { users }, error: lookupError } = await adminSupabase.auth.admin.listUsers({
      perPage: 1,
      page: 1,
    })

    // Filter by email since listUsers doesn't support email filter directly
    // Use getUserByEmail via the admin API
    let inviteeId: string | null = null
    // Prefer the direct lookup method
    const matchedUsers = (users ?? []).filter(u => u.email === email.toLowerCase())
    if (matchedUsers.length > 0) {
      inviteeId = matchedUsers[0].id
    }

    if (lookupError || !inviteeId) {
      return NextResponse.json(
        { error: 'No user found with that email. They must sign up first.' },
        { status: 404 }
      )
    }

    // Check if invitee is already a member
    const { data: existingMember } = await adminSupabase
      .from('project_members')
      .select('id')
      .eq('project_id', projectId)
      .eq('user_id', inviteeId)
      .maybeSingle()

    if (existingMember) {
      return NextResponse.json(
        { error: 'User is already a member of this project' },
        { status: 409 }
      )
    }

    // Add invitee to project_members
    const { data: projectMemberRecord, error: addError } = await (adminSupabase as any)
      .from('project_members')
      .insert({
        project_id: projectId,
        user_id: inviteeId,
        role: 'member',
      })
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
