import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase/server'
import {
  createSheetInFolder,
  createFolderInWorkspace,
  listWorkspaceFolders,
  getSheet,
} from '@/lib/smartsheet/client'
import { PROJECT_SHEET_COLUMNS } from '@/lib/smartsheet/columns'
import { SmartsheetColumn } from '@/lib/smartsheet/types'
import { pushSync, buildColumnMap, getColId, WORKSPACE_ID, FOLDER_NAME } from '@/lib/smartsheet/sync-engine'
import { registerWebhook } from '@/lib/smartsheet/webhook'

interface HardwareItemRow {
  id: string
  install_type: 'bench' | 'field' | null
  checklist_progress: Array<{
    received: boolean
    pre_install: boolean
    installed: boolean
    qa_qc: boolean
  }>
}

interface OpeningRow {
  id: string
  door_number: string
  hw_set: string | null
  hw_heading: string | null
  location: string | null
  door_type: string | null
  frame_type: string | null
  fire_rating: string | null
  hand: string | null
  hardware_items: HardwareItemRow[]
}

function computeOpeningStatus(opening: OpeningRow) {
  const items = opening.hardware_items || []
  const totalItems = items.length

  if (totalItems === 0) {
    return {
      classification: 'Unclassified',
      received: '0 / 0',
      preInstallInstalled: '0 / 0',
      qaQc: '0 / 0',
      overallStatus: 'Not Started',
      progressPct: 0,
      totalItems: 0,
    }
  }

  const benchCount = items.filter(i => i.install_type === 'bench').length
  const fieldCount = items.filter(i => i.install_type === 'field').length
  let classification = 'Unclassified'
  if (benchCount > 0 && fieldCount > 0) classification = 'Mixed'
  else if (benchCount > 0) classification = 'Bench'
  else if (fieldCount > 0) classification = 'Field'

  let receivedCount = 0
  let preInstallInstalledCount = 0
  let qaQcCount = 0

  for (const item of items) {
    const progress = item.checklist_progress?.[0]
    if (progress) {
      if (progress.received) receivedCount++
      if (progress.pre_install || progress.installed) preInstallInstalledCount++
      if (progress.qa_qc) qaQcCount++
    }
  }

  let overallStatus = 'Not Started'
  if (qaQcCount === totalItems) overallStatus = 'Complete'
  else if (receivedCount > 0 || preInstallInstalledCount > 0 || qaQcCount > 0) overallStatus = 'In Progress'

  const progressPct = Math.round(
    ((receivedCount * 0.25 + preInstallInstalledCount * 0.5 + qaQcCount * 0.25) / totalItems) * 100
  )

  return {
    classification,
    received: `${receivedCount} / ${totalItems}`,
    preInstallInstalled: `${preInstallInstalledCount} / ${totalItems}`,
    qaQc: `${qaQcCount} / ${totalItems}`,
    overallStatus,
    progressPct,
    totalItems,
  }
}

function buildOpeningCells(
  opening: OpeningRow,
  colMap: Map<string, number>,
  appUrl: string,
  projectId: string
) {
  const status = computeOpeningStatus(opening)
  return [
    { columnId: getColId(colMap, 'Door Number'), value: opening.door_number },
    { columnId: getColId(colMap, 'HW Set'), value: opening.hw_set || '' },
    { columnId: getColId(colMap, 'HW Heading'), value: opening.hw_heading || '' },
    { columnId: getColId(colMap, 'Location'), value: opening.location || '' },
    { columnId: getColId(colMap, 'Door Type'), value: opening.door_type || '' },
    { columnId: getColId(colMap, 'Frame Type'), value: opening.frame_type || '' },
    { columnId: getColId(colMap, 'Fire Rating'), value: opening.fire_rating || '' },
    { columnId: getColId(colMap, 'Hand'), value: opening.hand || '' },
    { columnId: getColId(colMap, 'Classification'), value: status.classification },
    { columnId: getColId(colMap, 'Received'), value: status.received },
    { columnId: getColId(colMap, 'Pre-Install / Installed'), value: status.preInstallInstalled },
    { columnId: getColId(colMap, 'QA/QC'), value: status.qaQc },
    { columnId: getColId(colMap, 'Overall Status'), value: status.overallStatus },
    { columnId: getColId(colMap, 'Progress %'), value: `${status.progressPct}%` },
    { columnId: getColId(colMap, 'Total Items'), value: status.totalItems },
    { columnId: getColId(colMap, 'App Link'), value: `${appUrl}/project/${projectId}/door/${opening.id}` },
  ]
}

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

    // Verify admin access
    const { data: membership } = await (supabase as any)
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (!membership || membership.role !== 'admin') {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    if (!process.env.SMARTSHEET_API_KEY) {
      return NextResponse.json(
        { error: 'Smartsheet API key not configured' },
        { status: 500 }
      )
    }

    const adminSupabase = createAdminSupabaseClient()

    // Get project info
    const { data: project, error: projectError } = await (adminSupabase as any)
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single()

    if (projectError || !project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Get all openings with hardware items and checklist progress
    const { data: openings, error: openingsError } = await (adminSupabase as any)
      .from('openings')
      .select(`
        id,
        door_number,
        hw_set,
        hw_heading,
        location,
        door_type,
        frame_type,
        fire_rating,
        hand,
        hardware_items(
          id,
          install_type,
          checklist_progress(received, pre_install, installed, qa_qc)
        )
      `)
      .eq('project_id', projectId)
      .order('door_number', { ascending: true })

    if (openingsError) {
      console.error('Smartsheet sync - fetch openings error:', openingsError)
      return NextResponse.json({ error: 'Failed to fetch project data' }, { status: 500 })
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://trackdoorhardware.app'
    const sheetName = `${project.name}${project.job_number ? ` (${project.job_number})` : ''}`
    let sheetId = project.smartsheet_sheet_id as number | null
    let sheetPermalink: string

    if (!sheetId) {
      // Get or create the "Door Hardware QR" folder in the workspace
      const parentFolderId = await getOrCreateFolder(WORKSPACE_ID, FOLDER_NAME)

      const newSheet = await createSheetInFolder(parentFolderId, sheetName, [...PROJECT_SHEET_COLUMNS])
      sheetId = newSheet.id
      sheetPermalink = newSheet.permalink

      // Store IDs
      await (adminSupabase as any)
        .from('projects')
        .update({
          smartsheet_sheet_id: sheetId,
          smartsheet_folder_id: parentFolderId,
          smartsheet_last_synced: new Date().toISOString(),
        })
        .eq('id', projectId)

      // Build rows and push
      const colMap = buildColumnMap(newSheet.columns)
      const localRows = (openings as OpeningRow[]).map(opening => ({
        localId: opening.id,
        primaryKey: opening.door_number,
        cells: buildOpeningCells(opening, colMap, appUrl, projectId),
      }))

      const result = await pushSync({
        sheetId,
        projectId,
        sheetType: 'project',
        localRows,
        columns: newSheet.columns,
      })

      // Register webhook for two-way sync
      try {
        if (process.env.SMARTSHEET_WEBHOOK_URL) {
          const { webhookId } = await registerWebhook({
            sheetId,
            projectId,
            sheetType: 'project',
            sheetName: sheetName,
          })
          await (adminSupabase as any)
            .from('projects')
            .update({ smartsheet_webhook_id: webhookId })
            .eq('id', projectId)
        }
      } catch (webhookErr) {
        console.error('Webhook registration failed (non-blocking):', webhookErr)
      }

      return NextResponse.json({
        success: true,
        created: true,
        sheetId,
        permalink: sheetPermalink,
        rowsSynced: openings?.length || 0,
        ...result,
      })
    } else {
      // Update existing sheet
      const sheet = await getSheet(sheetId)
      const colMap = buildColumnMap(sheet.columns)

      const localRows = (openings as OpeningRow[]).map(opening => ({
        localId: opening.id,
        primaryKey: opening.door_number,
        cells: buildOpeningCells(opening, colMap, appUrl, projectId),
      }))

      const result = await pushSync({
        sheetId,
        projectId,
        sheetType: 'project',
        localRows,
        columns: sheet.columns,
      })

      // Update last synced
      await (adminSupabase as any)
        .from('projects')
        .update({ smartsheet_last_synced: new Date().toISOString() })
        .eq('id', projectId)

      sheetPermalink = `https://app.smartsheet.com/sheets/${sheetId}`

      return NextResponse.json({
        success: true,
        created: false,
        sheetId,
        permalink: sheetPermalink,
        rowsSynced: openings?.length || 0,
        ...result,
      })
    }
  } catch (error) {
    console.error('Smartsheet sync error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Sync failed' },
      { status: 500 }
    )
  }
}
