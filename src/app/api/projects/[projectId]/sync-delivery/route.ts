import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase/server'
import { createSheetInFolder, getSheet, listWorkspaceFolders, createFolderInWorkspace } from '@/lib/smartsheet/client'
import { DELIVERY_SHEET_COLUMNS } from '@/lib/smartsheet/columns'
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

    const { data: deliveries } = await (adminSupabase as any)
      .from('deliveries')
      .select('*')
      .eq('project_id', projectId)
      .order('expected_date', { ascending: true })

    if (!deliveries || deliveries.length === 0) {
      return NextResponse.json({ success: true, message: 'No deliveries to sync' })
    }

    let sheetId = project.smartsheet_delivery_sheet_id as number | null
    let sheetPermalink: string
    const sheetName = `Delivery Tracker - ${project.name}${project.job_number ? ` (${project.job_number})` : ''}`

    const buildDeliveryCells = (d: any, colMap: Map<string, number>) => [
      { columnId: getColId(colMap, 'PO Number'), value: d.po_number || d.id.slice(0, 8) },
      { columnId: getColId(colMap, 'Vendor'), value: d.vendor || '' },
      { columnId: getColId(colMap, 'Description'), value: d.description || '' },
      { columnId: getColId(colMap, 'Items'), value: d.items_summary || '' },
      { columnId: getColId(colMap, 'Quantity'), value: d.quantity || '' },
      { columnId: getColId(colMap, 'Expected Date'), value: d.expected_date || '' },
      { columnId: getColId(colMap, 'Actual Date'), value: d.actual_date || '' },
      { columnId: getColId(colMap, 'Status'), value: capitalize(d.status.replace('_', ' ')) },
      { columnId: getColId(colMap, 'Tracking Number'), value: d.tracking_number || '' },
      { columnId: getColId(colMap, 'Notes'), value: d.notes || '' },
    ]

    if (!sheetId) {
      const folderId = await getOrCreateFolder(WORKSPACE_ID, FOLDER_NAME)
      const newSheet = await createSheetInFolder(folderId, sheetName, [...DELIVERY_SHEET_COLUMNS])
      sheetId = newSheet.id
      sheetPermalink = newSheet.permalink

      await (adminSupabase as any)
        .from('projects')
        .update({ smartsheet_delivery_sheet_id: sheetId })
        .eq('id', projectId)

      const colMap = buildColumnMap(newSheet.columns)
      const localRows = deliveries.map((d: any) => ({
        localId: d.id,
        primaryKey: d.po_number || d.id.slice(0, 8),
        cells: buildDeliveryCells(d, colMap),
      }))

      await pushSync({
        sheetId,
        projectId,
        sheetType: 'delivery',
        localRows,
        columns: newSheet.columns,
      })

      try {
        if (process.env.SMARTSHEET_WEBHOOK_URL) {
          await registerWebhook({ sheetId, projectId, sheetType: 'delivery', sheetName })
        }
      } catch {}

      return NextResponse.json({ success: true, created: true, sheetId, permalink: sheetPermalink })
    } else {
      const sheet = await getSheet(sheetId)
      const colMap = buildColumnMap(sheet.columns)

      const localRows = deliveries.map((d: any) => ({
        localId: d.id,
        primaryKey: d.po_number || d.id.slice(0, 8),
        cells: buildDeliveryCells(d, colMap),
      }))

      await pushSync({
        sheetId,
        projectId,
        sheetType: 'delivery',
        localRows,
        columns: sheet.columns,
      })

      sheetPermalink = `https://app.smartsheet.com/sheets/${sheetId}`
      return NextResponse.json({ success: true, created: false, sheetId, permalink: sheetPermalink })
    }
  } catch (error) {
    console.error('Delivery sync error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Sync failed' },
      { status: 500 }
    )
  }
}

function capitalize(s: string): string {
  return s.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}
