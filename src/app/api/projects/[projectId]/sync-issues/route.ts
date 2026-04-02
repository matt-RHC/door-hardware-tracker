import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase/server'
import { createSheetInFolder, getSheet, listWorkspaceFolders, createFolderInWorkspace } from '@/lib/smartsheet/client'
import { ISSUES_SHEET_COLUMNS } from '@/lib/smartsheet/columns'
import { pushSync, buildColumnMap, getColId, WORKSPACE_ID, FOLDER_NAME } from '@/lib/smartsheet/sync-engine'
import { registerWebhook } from '@/lib/smartsheet/webhook'

async function getOrCreateFolder(workspaceId: number, folderName: string): Promise<number> {
  const folders = await listWorkspaceFolders(workspaceId)
  const existing = folders.find(f => f.name === folderName)
  if (existing) return existing.id
  const created = await createFolderInWorkspace(workspaceId, folderName)
  return created.id
}

export async function POST(
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

    if (!process.env.SMARTSHEET_API_KEY) {
      return NextResponse.json({ error: 'Smartsheet API key not configured' }, { status: 500 })
    }

    const adminSupabase = createAdminSupabaseClient()

    const { data: project } = await (adminSupabase as any)
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single()

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Get all issues
    const { data: issues } = await (adminSupabase as any)
      .from('issues')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true })

    if (!issues || issues.length === 0) {
      return NextResponse.json({ success: true, message: 'No issues to sync' })
    }

    let sheetId = project.smartsheet_issues_sheet_id as number | null
    let sheetPermalink: string
    const sheetName = `Issues - ${project.name}${project.job_number ? ` (${project.job_number})` : ''}`

    const buildIssueCells = (issue: any, colMap: Map<string, number>) => [
      { columnId: getColId(colMap, 'Issue ID'), value: issue.issue_id_short || issue.id.slice(0, 8) },
      { columnId: getColId(colMap, 'Door Number'), value: issue.door_number || '' },
      { columnId: getColId(colMap, 'Hardware Item'), value: issue.hardware_item_name || '' },
      { columnId: getColId(colMap, 'Description'), value: issue.description || '' },
      { columnId: getColId(colMap, 'Severity'), value: capitalize(issue.severity) },
      { columnId: getColId(colMap, 'Status'), value: capitalize(issue.status.replace('_', ' ')) },
      { columnId: getColId(colMap, 'Assigned To'), value: issue.assigned_to || '' },
      { columnId: getColId(colMap, 'Reported By'), value: issue.reported_by || '' },
      { columnId: getColId(colMap, 'Date Reported'), value: issue.date_reported ? issue.date_reported.split('T')[0] : '' },
      { columnId: getColId(colMap, 'Date Resolved'), value: issue.date_resolved ? issue.date_resolved.split('T')[0] : '' },
      { columnId: getColId(colMap, 'Notes'), value: issue.notes || '' },
    ]

    if (!sheetId) {
      const folderId = await getOrCreateFolder(WORKSPACE_ID, FOLDER_NAME)
      const newSheet = await createSheetInFolder(folderId, sheetName, [...ISSUES_SHEET_COLUMNS])
      sheetId = newSheet.id
      sheetPermalink = newSheet.permalink

      await (adminSupabase as any)
        .from('projects')
        .update({ smartsheet_issues_sheet_id: sheetId })
        .eq('id', projectId)

      const colMap = buildColumnMap(newSheet.columns)
      const localRows = issues.map((issue: any) => ({
        localId: issue.id,
        primaryKey: issue.issue_id_short || issue.id.slice(0, 8),
        cells: buildIssueCells(issue, colMap),
      }))

      await pushSync({
        sheetId,
        projectId,
        sheetType: 'issues',
        localRows,
        columns: newSheet.columns,
      })

      // Register webhook for two-way sync
      try {
        if (process.env.SMARTSHEET_WEBHOOK_URL) {
          await registerWebhook({ sheetId, projectId, sheetType: 'issues', sheetName })
        }
      } catch {}

      return NextResponse.json({ success: true, created: true, sheetId, permalink: sheetPermalink })
    } else {
      const sheet = await getSheet(sheetId)
      const colMap = buildColumnMap(sheet.columns)

      const localRows = issues.map((issue: any) => ({
        localId: issue.id,
        primaryKey: issue.issue_id_short || issue.id.slice(0, 8),
        cells: buildIssueCells(issue, colMap),
      }))

      await pushSync({
        sheetId,
        projectId,
        sheetType: 'issues',
        localRows,
        columns: sheet.columns,
      })

      sheetPermalink = `https://app.smartsheet.com/sheets/${sheetId}`
      return NextResponse.json({ success: true, created: false, sheetId, permalink: sheetPermalink })
    }
  } catch (error) {
    console.error('Issues sync error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Sync failed' },
      { status: 500 }
    )
  }
}

function capitalize(s: string): string {
  return s.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}
