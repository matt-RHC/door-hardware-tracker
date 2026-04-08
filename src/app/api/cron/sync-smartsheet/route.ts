import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabaseClient } from '@/lib/supabase/server'
import {
  getSheet,
  createSheetInFolder,
  listWorkspaceFolders,
  createFolderInWorkspace,
} from '@/lib/smartsheet/client'
import { PROJECT_SHEET_COLUMNS } from '@/lib/smartsheet/columns'
import { pushSync, buildColumnMap, getColId, WORKSPACE_ID, FOLDER_NAME } from '@/lib/smartsheet/sync-engine'
import type { HardwareItemRow, OpeningRow } from '@/lib/types/database'

export const maxDuration = 300

// Vercel cron secret protects this endpoint
function verifyCronAuth(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return false
  return authHeader === `Bearer ${cronSecret}`
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

// GET handler — called by Vercel cron
export async function GET(request: NextRequest) {
  // Verify cron secret
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!process.env.SMARTSHEET_API_KEY) {
    return NextResponse.json({ error: 'Smartsheet API key not configured' }, { status: 500 })
  }

  const adminSupabase = createAdminSupabaseClient()
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://trackdoorhardware.app'
  const results: Array<{ projectId: string; name: string; success: boolean; error?: string; rowsSynced?: number }> = []

  try {
    // Get all projects that have a smartsheet_sheet_id (already synced at least once)
    const { data: projects, error: projectsError } = await (adminSupabase as any)
      .from('projects')
      .select('id, name, job_number, smartsheet_sheet_id')
      .not('smartsheet_sheet_id', 'is', null)

    if (projectsError) {
      return NextResponse.json({ error: 'Failed to fetch projects' }, { status: 500 })
    }

    if (!projects || projects.length === 0) {
      return NextResponse.json({ message: 'No projects with Smartsheet sync enabled', results: [] })
    }

    for (const project of projects) {
      try {
        const sheetId = project.smartsheet_sheet_id as number

        // Get openings with hardware items and checklist progress
        const { data: openings, error: openingsError } = await (adminSupabase as any)
          .from('openings')
          .select(`
            id, door_number, hw_set, hw_heading, location, door_type,
            frame_type, fire_rating, hand,
            hardware_items(id, install_type, checklist_progress(received, pre_install, installed, qa_qc))
          `)
          .eq('project_id', project.id)
          .order('door_number', { ascending: true })

        if (openingsError) {
          results.push({ projectId: project.id, name: project.name, success: false, error: openingsError.message })
          continue
        }

        const sheet = await getSheet(sheetId)
        const colMap = buildColumnMap(sheet.columns)

        const localRows = (openings as OpeningRow[]).map(opening => ({
          localId: opening.id,
          primaryKey: opening.door_number,
          cells: buildOpeningCells(opening, colMap, appUrl, project.id),
        }))

        const syncResult = await pushSync({
          sheetId,
          projectId: project.id,
          sheetType: 'project',
          localRows,
          columns: sheet.columns,
        })

        // Update last synced
        await (adminSupabase as any)
          .from('projects')
          .update({ smartsheet_last_synced: new Date().toISOString() })
          .eq('id', project.id)

        results.push({
          projectId: project.id,
          name: project.name,
          success: true,
          rowsSynced: openings?.length || 0,
        })

        console.debug(`Cron sync: ${project.name} — ${syncResult.rowsAdded} added, ${syncResult.rowsUpdated} updated, ${syncResult.rowsDeleted} deleted`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`Cron sync failed for ${project.name}:`, message)
        results.push({ projectId: project.id, name: project.name, success: false, error: message })
      }
    }

    return NextResponse.json({
      success: true,
      projectsSynced: results.filter(r => r.success).length,
      projectsFailed: results.filter(r => !r.success).length,
      results,
    })
  } catch (error) {
    console.error('Cron sync-smartsheet error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Cron sync failed' },
      { status: 500 }
    )
  }
}
