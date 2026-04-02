import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase/server'
import { createSheetInWorkspace, getSheet } from '@/lib/smartsheet/client'
import { PORTFOLIO_SHEET_COLUMNS } from '@/lib/smartsheet/columns'
import { pushSync, buildColumnMap, getColId, WORKSPACE_ID } from '@/lib/smartsheet/sync-engine'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!process.env.SMARTSHEET_API_KEY) {
      return NextResponse.json({ error: 'Smartsheet API key not configured' }, { status: 500 })
    }

    const adminSupabase = createAdminSupabaseClient()

    // Get portfolio config
    const { data: portfolioConfig } = await (adminSupabase as any)
      .from('smartsheet_portfolio')
      .select('*')
      .limit(1)
      .single()

    // Get all projects that have been synced to Smartsheet (have a smartsheet_sheet_id)
    const { data: projects } = await (adminSupabase as any)
      .from('projects')
      .select('*')
      .not('smartsheet_sheet_id', 'is', null)
      .order('name', { ascending: true })

    if (!projects || projects.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No synced projects to aggregate',
      })
    }

    // Aggregate stats for each project
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://trackdoorhardware.app'
    const projectRows: Array<{ project: any; openingCount: number; completionPct: number; openIssues: number; pendingDeliveries: number }> = []

    for (const project of projects) {
      // Get opening count
      const { count: openingCount } = await (adminSupabase as any)
        .from('openings')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', project.id)

      // Get checklist stats
      const { data: progress } = await (adminSupabase as any)
        .from('checklist_progress')
        .select('checked')
        .in('opening_id', (
          await (adminSupabase as any)
            .from('openings')
            .select('id')
            .eq('project_id', project.id)
        ).data?.map((o: any) => o.id) || [])

      const totalChecked = progress?.filter((p: any) => p.checked).length || 0
      const totalProgress = progress?.length || 0
      const completionPct = totalProgress > 0 ? Math.round((totalChecked / totalProgress) * 100) : 0

      // Get open issues count
      const { count: openIssues } = await (adminSupabase as any)
        .from('issues')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', project.id)
        .in('status', ['open', 'in_progress'])

      // Get pending deliveries count
      const { count: pendingDeliveries } = await (adminSupabase as any)
        .from('deliveries')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', project.id)
        .in('status', ['pending', 'in_transit', 'delayed'])

      projectRows.push({
        project,
        openingCount: openingCount || 0,
        completionPct,
        openIssues: openIssues || 0,
        pendingDeliveries: pendingDeliveries || 0,
      })
    }

    let sheetId = portfolioConfig?.smartsheet_sheet_id as number | null
    let sheetPermalink: string
    const sheetName = 'Door Hardware Portfolio'

    const buildPortfolioCells = (row: typeof projectRows[0], colMap: Map<string, number>) => [
      { columnId: getColId(colMap, 'Project Name'), value: row.project.name },
      { columnId: getColId(colMap, 'Job Number'), value: row.project.job_number || '' },
      { columnId: getColId(colMap, 'General Contractor'), value: row.project.general_contractor || '' },
      { columnId: getColId(colMap, 'Architect'), value: row.project.architect || '' },
      { columnId: getColId(colMap, 'Total Openings'), value: row.openingCount },
      { columnId: getColId(colMap, 'Completion %'), value: `${row.completionPct}%` },
      { columnId: getColId(colMap, 'Status'), value: capitalize(row.project.status || 'active') },
      { columnId: getColId(colMap, 'Open Issues'), value: row.openIssues },
      { columnId: getColId(colMap, 'Pending Deliveries'), value: row.pendingDeliveries },
      { columnId: getColId(colMap, 'Last Synced'), value: row.project.smartsheet_last_synced ? row.project.smartsheet_last_synced.split('T')[0] : '' },
      { columnId: getColId(colMap, 'Sheet Link'), value: row.project.smartsheet_sheet_id ? `https://app.smartsheet.com/sheets/${row.project.smartsheet_sheet_id}` : '' },
    ]

    if (!sheetId) {
      // Create portfolio sheet at workspace root
      const newSheet = await createSheetInWorkspace(WORKSPACE_ID, sheetName, [...PORTFOLIO_SHEET_COLUMNS])
      sheetId = newSheet.id
      sheetPermalink = newSheet.permalink

      // Store config
      if (portfolioConfig) {
        await (adminSupabase as any)
          .from('smartsheet_portfolio')
          .update({ smartsheet_sheet_id: sheetId, last_synced: new Date().toISOString() })
          .eq('id', portfolioConfig.id)
      } else {
        await (adminSupabase as any)
          .from('smartsheet_portfolio')
          .insert({ smartsheet_sheet_id: sheetId, last_synced: new Date().toISOString() })
      }

      const colMap = buildColumnMap(newSheet.columns)
      const localRows = projectRows.map(row => ({
        localId: row.project.id,
        primaryKey: row.project.name,
        cells: buildPortfolioCells(row, colMap),
      }))

      const result = await pushSync({
        sheetId,
        projectId: 'portfolio',
        sheetType: 'portfolio',
        localRows,
        columns: newSheet.columns,
      })

      return NextResponse.json({
        success: true,
        created: true,
        sheetId,
        permalink: sheetPermalink,
        projectsSynced: projectRows.length,
      })
    } else {
      const sheet = await getSheet(sheetId)
      const colMap = buildColumnMap(sheet.columns)

      const localRows = projectRows.map(row => ({
        localId: row.project.id,
        primaryKey: row.project.name,
        cells: buildPortfolioCells(row, colMap),
      }))

      await pushSync({
        sheetId,
        projectId: 'portfolio',
        sheetType: 'portfolio',
        localRows,
        columns: sheet.columns,
      })

      await (adminSupabase as any)
        .from('smartsheet_portfolio')
        .update({ last_synced: new Date().toISOString() })
        .eq('smartsheet_sheet_id', sheetId)

      sheetPermalink = `https://app.smartsheet.com/sheets/${sheetId}`

      return NextResponse.json({
        success: true,
        created: false,
        sheetId,
        permalink: sheetPermalink,
        projectsSynced: projectRows.length,
      })
    }
  } catch (error) {
    console.error('Portfolio sync error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Sync failed' },
      { status: 500 }
    )
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
