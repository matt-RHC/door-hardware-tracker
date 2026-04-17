import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'

type ProjectRow = {
  id: string
  name: string
  job_number: string | null
  general_contractor: string | null
  architect: string | null
  address: string | null
}

type OpeningRow = {
  id: string
  project_id: string
  hardware_items: Array<{ id: string }>
  checklist_progress: Array<{ checked: boolean }>
}

type ProjectStats = {
  project_id: string
  name: string
  job_number: string | null
  general_contractor: string | null
  architect: string | null
  address: string | null
  openings_total: number
  openings_complete: number
  openings_incomplete: number
  items_total: number
  items_checked: number
  completion_pct: number
}

export async function GET() {
  try {
    const supabase = await createServerSupabaseClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: memberships, error: membershipsError } = await supabase
      .from('project_members')
      .select('project_id')
      .eq('user_id', user.id)

    if (membershipsError) {
      console.error('Portfolio stats: membership query failed', membershipsError)
      return NextResponse.json({ error: 'Failed to fetch memberships' }, { status: 500 })
    }

    const membershipRows = (memberships ?? []) as Array<{ project_id: string }>
    const projectIds = membershipRows.map((m) => m.project_id)

    if (projectIds.length === 0) {
      return NextResponse.json({
        projects: [],
        totals: {
          projects: 0,
          openings: 0,
          openings_complete: 0,
          items_total: 0,
          items_checked: 0,
          completion_pct: 0,
        },
      })
    }

    const admin = createAdminSupabaseClient()

    const { data: projectsRaw, error: projectsError } = await admin
      .from('projects')
      .select('id, name, job_number, general_contractor, architect, address')
      .in('id', projectIds)
      .order('name', { ascending: true })

    if (projectsError) {
      console.error('Portfolio stats: projects query failed', projectsError)
      return NextResponse.json({ error: 'Failed to fetch projects' }, { status: 500 })
    }

    const projects = (projectsRaw ?? []) as unknown as ProjectRow[]

    const { data: openingsRaw, error: openingsError } = await admin
      .from('openings')
      .select(`
        id,
        project_id,
        hardware_items(id),
        checklist_progress(checked)
      `)
      .in('project_id', projectIds)

    if (openingsError) {
      console.error('Portfolio stats: openings query failed', openingsError)
      return NextResponse.json({ error: 'Failed to fetch openings' }, { status: 500 })
    }

    const openings = (openingsRaw ?? []) as unknown as OpeningRow[]

    const byProject = new Map<string, ProjectStats>()
    for (const p of projects) {
      byProject.set(p.id, {
        project_id: p.id,
        name: p.name,
        job_number: p.job_number,
        general_contractor: p.general_contractor,
        architect: p.architect,
        address: p.address,
        openings_total: 0,
        openings_complete: 0,
        openings_incomplete: 0,
        items_total: 0,
        items_checked: 0,
        completion_pct: 0,
      })
    }

    for (const opening of openings) {
      const stats = byProject.get(opening.project_id)
      if (!stats) continue

      const itemCount = opening.hardware_items?.length ?? 0
      const checkedCount = (opening.checklist_progress ?? []).filter((c) => c.checked).length

      stats.openings_total += 1
      stats.items_total += itemCount
      stats.items_checked += checkedCount

      if (itemCount > 0 && checkedCount >= itemCount) {
        stats.openings_complete += 1
      } else {
        stats.openings_incomplete += 1
      }
    }

    for (const stats of byProject.values()) {
      stats.completion_pct =
        stats.openings_total > 0
          ? Math.round((stats.openings_complete / stats.openings_total) * 100)
          : 0
    }

    const projectStats = Array.from(byProject.values())

    const totalsOpenings = projectStats.reduce((s, p) => s + p.openings_total, 0)
    const totalsComplete = projectStats.reduce((s, p) => s + p.openings_complete, 0)
    const totalsItems = projectStats.reduce((s, p) => s + p.items_total, 0)
    const totalsChecked = projectStats.reduce((s, p) => s + p.items_checked, 0)

    return NextResponse.json({
      projects: projectStats,
      totals: {
        projects: projectStats.length,
        openings: totalsOpenings,
        openings_complete: totalsComplete,
        items_total: totalsItems,
        items_checked: totalsChecked,
        completion_pct:
          totalsOpenings > 0 ? Math.round((totalsComplete / totalsOpenings) * 100) : 0,
      },
    })
  } catch (error) {
    console.error('Portfolio stats GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
