import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'

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

    const { data: projectMember, error: memberError } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (memberError || !projectMember) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const adminSupabase = createAdminSupabaseClient()

    // --- Stage counts ---
    // First fetch active opening IDs, then use the array in .in()
    // (Supabase JS client .in() expects an array, not a query builder)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: activeOpeningRows } = await (adminSupabase as any)
      .from('openings')
      .select('id')
      .eq('project_id', projectId)
      .eq('is_active', true)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activeOpeningIds = ((activeOpeningRows as any[]) ?? []).map((o: { id: string }) => o.id)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let stageRows: any[] | null = null
    if (activeOpeningIds.length > 0) {
      const { data } = await (adminSupabase as any)
        .from('hardware_items')
        .select('stage, opening_id')
        .in('opening_id', activeOpeningIds)
      stageRows = data
    }

    const stageCounts: Record<string, number> = {
      ordered: 0, shipped: 0, received: 0, installed: 0, qa_passed: 0,
    }
    if (stageRows) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const row of stageRows as any[]) {
        const s = row.stage ?? 'ordered'
        if (s in stageCounts) stageCounts[s]++
      }
    }

    // --- Openings with floor/zone (active only) ---
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: openings } = await (adminSupabase as any)
      .from('openings')
      .select('id, floor_number, zone_name')
      .eq('project_id', projectId)
      .eq('is_active', true)

    // --- Checklist progress for this project ---
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const openingIds = ((openings as any[]) ?? []).map((o: { id: string }) => o.id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let progressRows: any[] = []
    if (openingIds.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (adminSupabase as any)
        .from('checklist_progress')
        .select('opening_id, checked, received, installed, qa_qc')
        .in('opening_id', openingIds)
      progressRows = (data ?? []) as typeof progressRows
    }

    // Build lookup: opening_id → { total, completed }
    const progressByOpening: Record<string, { total: number; completed: number }> = {}
    for (const row of progressRows) {
      if (!progressByOpening[row.opening_id]) {
        progressByOpening[row.opening_id] = { total: 0, completed: 0 }
      }
      progressByOpening[row.opening_id].total++
      if (row.qa_qc || row.installed) progressByOpening[row.opening_id].completed++
    }

    // --- Floor progress ---
    const floorMap: Record<string, { total: number; completed: number }> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const o of (openings as any[]) ?? []) {
      const floor = o.floor_number != null ? String(o.floor_number) : 'Unassigned'
      if (!floorMap[floor]) floorMap[floor] = { total: 0, completed: 0 }
      const p = progressByOpening[o.id]
      if (p) {
        floorMap[floor].total += p.total
        floorMap[floor].completed += p.completed
      }
    }
    const floorProgress = Object.entries(floorMap)
      .map(([floor, { total, completed }]) => ({
        floor,
        total,
        completed,
        remaining: total - completed,
        pct: total > 0 ? Math.round((completed / total) * 100) : 0,
      }))
      .sort((a, b) => (a.floor === 'Unassigned' ? 1 : b.floor === 'Unassigned' ? -1 : Number(a.floor) - Number(b.floor)))

    // --- Zone summary ---
    const zoneMap: Record<string, { total: number; completed: number }> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const o of (openings as any[]) ?? []) {
      const zone = o.zone_name ?? 'Unassigned'
      if (!zoneMap[zone]) zoneMap[zone] = { total: 0, completed: 0 }
      const p = progressByOpening[o.id]
      if (p) {
        zoneMap[zone].total += p.total
        zoneMap[zone].completed += p.completed
      }
    }
    const zoneSummary = Object.entries(zoneMap)
      .map(([zone, { total, completed }]) => ({
        zone,
        total,
        completed,
        pct: total > 0 ? Math.round((completed / total) * 100) : 0,
      }))
      .sort((a, b) => a.zone.localeCompare(b.zone))

    // --- Timeline: daily progress over last 30 days ---
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: activityRows } = await (adminSupabase as any)
      .from('activity_log')
      .select('action, created_at')
      .eq('project_id', projectId)
      .in('action', ['item_installed', 'item_qa_passed'])
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: true })

    const dailyCounts: Record<string, number> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of (activityRows as any[]) ?? []) {
      const day = row.created_at?.slice(0, 10)
      if (day) dailyCounts[day] = (dailyCounts[day] ?? 0) + 1
    }

    // Fill in all 30 days
    const timeline: { date: string; count: number; cumulative: number }[] = []
    let cumulative = 0
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
      const key = d.toISOString().slice(0, 10)
      const count = dailyCounts[key] ?? 0
      cumulative += count
      timeline.push({ date: key, count, cumulative })
    }

    // --- Totals ---
    // Note: progressRows / stageRows / totalItems count per-leaf rows on
    // pair doors (split-placement items emit one row per leaf — see
    // PAIR_LEAF_PLACEMENT in hardware-taxonomy.ts and the
    // projects/[id]/summary route for the full rationale).
    const totalItems = progressRows.length
    const completedItems = progressRows.filter(
      (r: { qa_qc: boolean; installed: boolean }) => r.qa_qc || r.installed
    ).length

    // Blocked items count (from openings_blocked_v if it exists)
    let blockedItems = 0
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: blockedData } = await (adminSupabase as any)
        .from('openings_blocked_v')
        .select('opening_id', { count: 'exact' })
        .eq('project_id', projectId)
      blockedItems = blockedData?.length ?? 0
    } catch {
      // View may not exist yet
    }

    return NextResponse.json({
      stageCounts,
      floorProgress,
      zoneSummary,
      timeline,
      totalItems,
      completedItems,
      blockedItems,
    })
  } catch (error) {
    console.error('Dashboard GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
