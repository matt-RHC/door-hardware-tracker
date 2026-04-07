import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getSheet } from '@/lib/smartsheet/client'
import { SmartsheetSheet, SmartsheetRow, SmartsheetColumn } from '@/lib/smartsheet/types'

interface DoorRow {
  doorNumber: string
  hwSet: string
  hwHeading: string
  location: string
  status: string
  progress: number
  classification: string
}

interface DashboardSummary {
  totalDoors: number
  averageProgress: number
  statusBreakdown: {
    notStarted: number
    inProgress: number
    complete: number
  }
}

function buildColumnTitleMap(columns: SmartsheetColumn[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const col of columns) {
    map.set(col.title, col.id)
  }
  return map
}

function getCellValue(row: SmartsheetRow, columnId: number | undefined): string {
  if (!columnId) return ''
  const cell = (row.cells ?? []).find(c => c.columnId === columnId)
  return (cell?.displayValue ?? cell?.value ?? '').toString()
}

function getCellNumber(row: SmartsheetRow, columnId: number | undefined): number {
  if (!columnId) return 0
  const cell = (row.cells ?? []).find(c => c.columnId === columnId)
  const raw = cell?.value
  if (typeof raw === 'number') return raw
  const parsed = parseFloat(String(raw ?? '').replace('%', ''))
  return isNaN(parsed) ? 0 : parsed
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId } = await params

    // Verify project membership (any role)
    const { data: membership } = await (supabase as any)
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (!membership) {
      return NextResponse.json({ error: 'Not a project member' }, { status: 403 })
    }

    // Get project's Smartsheet sheet ID
    const { data: project, error: projectError } = await (supabase as any)
      .from('projects')
      .select('smartsheet_sheet_id')
      .eq('id', projectId)
      .single()

    if (projectError || !project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const sheetId = project?.smartsheet_sheet_id
    if (!sheetId) {
      return NextResponse.json({ synced: false })
    }

    if (!process.env.SMARTSHEET_API_KEY) {
      return NextResponse.json(
        { error: 'Smartsheet API key not configured' },
        { status: 500 }
      )
    }

    // Fetch sheet data from Smartsheet
    const sheet: SmartsheetSheet = await getSheet(sheetId)
    const colMap = buildColumnTitleMap(sheet.columns ?? [])

    // Map column titles to IDs
    const doorNumberColId = colMap.get('Door Number')
    const hwSetColId = colMap.get('HW Set')
    const hwHeadingColId = colMap.get('HW Heading')
    const locationColId = colMap.get('Location')
    const statusColId = colMap.get('Overall Status')
    const progressColId = colMap.get('Progress %')
    const classificationColId = colMap.get('Classification')

    // Map rows to door data
    const rows = sheet.rows ?? []
    const doors: DoorRow[] = rows.map((row) => ({
      doorNumber: getCellValue(row, doorNumberColId),
      hwSet: getCellValue(row, hwSetColId),
      hwHeading: getCellValue(row, hwHeadingColId),
      location: getCellValue(row, locationColId),
      status: getCellValue(row, statusColId) || 'Not Started',
      progress: getCellNumber(row, progressColId),
      classification: getCellValue(row, classificationColId) || 'Unclassified',
    })).filter(d => d.doorNumber) // Filter out empty rows

    // Compute summary
    const totalDoors = doors.length
    const averageProgress = totalDoors > 0
      ? Math.round(doors.reduce((sum, d) => sum + d.progress, 0) / totalDoors)
      : 0

    const statusBreakdown = {
      notStarted: doors.filter(d => d.status === 'Not Started').length,
      inProgress: doors.filter(d => d.status === 'In Progress').length,
      complete: doors.filter(d => d.status === 'Complete').length,
    }

    const summary: DashboardSummary = {
      totalDoors,
      averageProgress,
      statusBreakdown,
    }

    return NextResponse.json({
      synced: true,
      lastFetched: new Date().toISOString(),
      permalink: sheet.permalink ?? null,
      summary,
      doors,
    })
  } catch (err) {
    console.error('Dashboard API error:', err)
    return NextResponse.json(
      { error: 'Failed to fetch dashboard data' },
      { status: 500 }
    )
  }
}
