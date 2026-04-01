import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase/server'

interface CreateProjectRequest {
  name: string
  job_number?: string
  general_contractor?: string
  architect?: string
  address?: string
  submittal_date?: string
}

export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()

    // Check authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Get projects where user is a member
    const { data: memberships, error: membershipsError } = await supabase
      .from('project_members')
      .select('project_id')
      .eq('user_id', user.id)

    if (membershipsError) {
      console.error('Error fetching memberships:', membershipsError)
      return NextResponse.json(
        { error: 'Failed to fetch projects' },
        { status: 500 }
      )
    }

    const projectIds = (memberships || []).map((m: any) => m.project_id)

    if (projectIds.length === 0) {
      return NextResponse.json([])
    }

    const { data: projects, error: projectsError } = await supabase
      .from('projects')
      .select(`
        id,
        name,
        job_number,
        general_contractor,
        architect,
        address,
        submittal_date,
        created_at
      `)
      .in('id', projectIds)

    if (projectsError) {
      console.error('Error fetching projects:', projectsError)
      return NextResponse.json(
        { error: 'Failed to fetch projects' },
        { status: 500 }
      )
    }

    return NextResponse.json(projects)
  } catch (error) {
    console.error('Projects GET error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()

    // Check authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body: CreateProjectRequest = await request.json()
    const { name, job_number, general_contractor, architect, address, submittal_date } = body

    if (!name) {
      return NextResponse.json(
        { error: 'Project name is required' },
        { status: 400 }
      )
    }

    // Create project
    const { data: project, error: projectError } = await (supabase as any)
      .from('projects')
      .insert([{
        name,
        job_number: job_number || null,
        general_contractor: general_contractor || null,
        architect: architect || null,
        address: address || null,
        submittal_date: submittal_date || null,
        created_by: user.id,
      }] as any)
      .select()
      .single()

    if (projectError) {
      console.error('Error creating project:', projectError)
      return NextResponse.json(
        { error: 'Failed to create project' },
        { status: 500 }
      )
    }

    // Add current user as admin (use admin client to bypass RLS chicken-and-egg:
    // the project_members INSERT policy requires an existing admin, but this IS the first member)
    const adminSupabase = createAdminSupabaseClient()
    const { error: memberError } = await (adminSupabase as any)
      .from('project_members')
      .insert([{
        project_id: (project as any).id,
        user_id: user.id,
        role: 'admin',
      }] as any)

    if (memberError) {
      console.error('Error adding user to project:', memberError)
      return NextResponse.json(
        { error: 'Failed to add user to project' },
        { status: 500 }
      )
    }

    return NextResponse.json(project, { status: 201 })
  } catch (error) {
    console.error('Projects POST error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
