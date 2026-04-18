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

    const adminSupabase = createAdminSupabaseClient()

    let inviteeId: string | null = null
    const PAGE_SIZE = 500
    const MAX_PAGES = 20

    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data: { users }, error: lookupError } = await adminSupabase.auth.admin.listUsers({
        perPage: PAGE_SIZE,
        page,
      })

      if (lookupError) {
        console.error('Error looking up user by email:', lookupError)
        return NextResponse.json(
          { error: 'Failed to look up user' },
          { status: 500 }
        )
      }

      const match = (users ?? []).find(u => u.email?.toLowerCase() === email.toLowerCase())
      if (match) {
        inviteeId = match.id
        break
      }

      if (!users || users.length < PAGE_SIZE) break
    }

    if (!inviteeId) {
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
