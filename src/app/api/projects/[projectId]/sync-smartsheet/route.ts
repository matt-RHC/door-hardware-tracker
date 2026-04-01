import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase/server'
import {
  createSheetInFolder,
  createFolderInWorkspace,
  listWorkspaceFolders,
  getSheet,
  addRows,
  updateRows,
  deleteRows,
  PROJECT_SHEET_COLUMNS,
  SmartsheetColumn,
} from '@/lib/smartsheet'

// Smartsheet workspace ID for "Modular Business OS"
const WORKSPACE_ID = 5453896878450564
const FOLDER_NAME = 'Door Hardware QR'

interface ChecklistRow {
  received: boolean
  pre_install: boolean
  installed: boolean
  qa_qc: boolean
}

interface HardwareItemRow {
  id: string
  install_type: 'bench' | 'field' | null
  checklist_progress: ChecklistRow[]
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

  // Classification
  const benchCount = items.filter(i => i.install_type === 'bench').length
  const fieldCount = items.filter(i => i.install_type === 'field').length
  let classification = 'Unclassified'
  if (benchCount > 0 && fieldCount > 0) classification = 'Mixed'
  else if (benchCount > 0) classification = 'Bench'
  else if (fieldCount > 0) classification = 'Field'

  // Workflow counts
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

  // Overall status
  let overallStatus = 'Not Started'
  if (qaQcCount === totalItems) overallStatus = 'Complete'
  else if (receivedCount > 0 || preInstallInstalledCount > 0 || qaQcCount > 0) overallStatus = 'In Progress'

  // Progress — weighted: received=25%, installed=50%, qa_qc=100%
  const progressPct = totalItems > 0
    ? Math.round(((receivedCount * 0.25 + preInstallInstalledCount * 0.5 + qaQcCount * 0.25) / totalItems) * 100)
    : 0

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

function buildRowCells(
  opening: OpeningRow,
  columns: SmartsheetColumn[],
  appUrl: string,
  projectId: string
) {
  const status = computeOpeningStatus(opening)
  const colMap = new Map(columns.map(c => [c.title, c.id]))

  const getColId = (title: string) => {
    const id = colMap.get(title)
    if (!id) throw new Error(`Column "${title}" not found in Smartsheet`)
    return id
  }

  return [
    { columnId: getColId('Door Number'), value: opening.door_number },
    { columnId: getColId('HW Set'), value: opening.hw_set || '' },
    { columnId: getColId('Location'), value: opening.location || '' },
    { columnId: getColId('Door Type'), value: opening.door_type || '' },
    { columnId: getColId('Frame Type'), value: opening.frame_type || '' },
    { columnId: getColId('Fire Rating'), value: opening.fire_rating || '' },
    { columnId: getColId('Hand'), value: opening.hand || '' },
    { columnId: getColId('Classification'), value: status.classification },
    { columnId: getColId('Received'), value: status.received },
    { columnId: getColId('Pre-Install / Installed'), value: status.preInstallInstalled },
    { columnId: getColId('QA/QC'), value: status.qaQc },
    { columnId: getColId('Overall Status'), value: status.overallStatus },
    { columnId: getColId('Progress %'), value: `${status.progressPct}%` },
    { columnId: getColId('Total Items'), value: status.totalItems },
    { columnId: getColId('App Link'), value: `${appUrl}/project/${projectId}/door/${opening.id}` },
  ]
}

async function getOrCreateFolder(workspaceId: number): Promise<number> {
  const folders = await listWorkspaceFolders(workspaceId)
  const existing = folders.find(f => f.name === FOLDER_NAME)
  if (existing) return existing.id

  const created = await createFolderInWorkspace(workspaceId, FOLDER_NAME)
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
    const { data: membership } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single() as { data: { role: string } | null }

    if (!membership || membership.role !== 'admin') {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    // Check if Smartsheet API token is configured
    if (!process.env.SMARTSHEET_API_TOKEN) {
      return NextResponse.json(
        { error: 'Smartsheet API token not configured. Add SMARTSHEET_API_TOKEN to environment variables.' },
        { status: 500 }
      )
    }

    const adminSupabase = createAdminSupabaseClient()

    // Get project info
    const { data: project, error: projectError } = await adminSupabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single() as any

    if (projectError || !project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Get all openings with hardware items and checklist progress
    const { data: openings, error: openingsError } = await adminSupabase
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
      .order('door_number', { ascending: true }) as { data: OpeningRow[] | null; error: any }

    if (openingsError) {
      console.error('Smartsheet sync - fetch openings error:', openingsError)
      return NextResponse.json({ error: 'Failed to fetch project data' }, { status: 500 })
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://door-hardware-tracker.vercel.app'
    const sheetName = `${project.name}${project.job_number ? ` (${project.job_number})` : ''}`
    let sheetId = project.smartsheet_sheet_id as number | null
    let sheetPermalink: string = ''

    if (!sheetId) {
      // Create new sheet in the Door Hardware QR folder
      const folderId = await getOrCreateFolder(WORKSPACE_ID)
      const newSheet = await createSheetInFolder(folderId, sheetName, [...PROJECT_SHEET_COLUMNS])
      sheetId = newSheet.id
      sheetPermalink = newSheet.permalink

      // Store sheet ID in project
      await (adminSupabase
        .from('projects') as any)
        .update({
          smartsheet_sheet_id: sheetId,
          smartsheet_last_synced: new Date().toISOString(),
        })
        .eq('id', projectId)

      // Add all openings as new rows
      if (openings && openings.length > 0) {
        const columns = newSheet.columns
        const rowBatches = []

        // Smartsheet has a 500 row limit per API call
        for (let i = 0; i < openings.length; i += 500) {
          const batch = openings.slice(i, i + 500)
          rowBatches.push(batch)
        }

        for (const batch of rowBatches) {
          const rows = batch.map(opening => ({
            toBottom: true,
            cells: buildRowCells(opening, columns, appUrl, projectId),
          }))
          await addRows(sheetId, rows)
        }
      }

      return NextResponse.json({
        success: true,
        created: true,
        sheetId,
        permalink: sheetPermalink,
        rowsSynced: openings?.length || 0,
      })
    } else {
      // Update existing sheet — fetch current rows and reconcile
      const sheet = await getSheet(sheetId)
      const columns = sheet.columns
      const existingRows = sheet.rows

      // Build a map of existing rows by door number (primary column)
      const primaryCol = columns.find(c => c.primary)
      if (!primaryCol) throw new Error('No primary column found')

      const existingByDoor = new Map<string, number>() // door_number -> row_id
      for (const row of existingRows) {
        const doorCell = row.cells.find(c => c.columnId === primaryCol.id)
        if (doorCell?.value) {
          existingByDoor.set(String(doorCell.value), row.id)
        }
      }

      const rowsToUpdate: Array<{ id: number; cells: Array<{ columnId: number; value: any }> }> = []
      const rowsToAdd: Array<{ toBottom: boolean; cells: Array<{ columnId: number; value: any }> }> = []
      const matchedRowIds = new Set<number>()

      for (const opening of (openings || [])) {
        const existingRowId = existingByDoor.get(opening.door_number)
        const cells = buildRowCells(opening, columns, appUrl, projectId)

        if (existingRowId) {
          rowsToUpdate.push({ id: existingRowId, cells })
          matchedRowIds.add(existingRowId)
        } else {
          rowsToAdd.push({ toBottom: true, cells })
        }
      }

      // Rows in Smartsheet that no longer exist in the app — delete them
      const rowsToDelete = existingRows
        .filter(r => !matchedRowIds.has(r.id))
        .map(r => r.id)

      // Execute updates in batches
      if (rowsToUpdate.length > 0) {
        for (let i = 0; i < rowsToUpdate.length; i += 500) {
          await updateRows(sheetId, rowsToUpdate.slice(i, i + 500))
        }
      }

      if (rowsToAdd.length > 0) {
        for (let i = 0; i < rowsToAdd.length; i += 500) {
          await addRows(sheetId, rowsToAdd.slice(i, i + 500))
        }
      }

      if (rowsToDelete.length > 0) {
        for (let i = 0; i < rowsToDelete.length; i += 500) {
          await deleteRows(sheetId, rowsToDelete.slice(i, i + 500))
        }
      }

      // Update last synced timestamp
      await (adminSupabase
        .from('projects') as any)
        .update({ smartsheet_last_synced: new Date().toISOString() })
        .eq('id', projectId)

      sheetPermalink = `https://app.smartsheet.com/sheets/${sheetId}`

      return NextResponse.json({
        success: true,
        created: false,
        sheetId,
        permalink: sheetPermalink,
        rowsSynced: openings?.length || 0,
        rowsUpdated: rowsToUpdate.length,
        rowsAdded: rowsToAdd.length,
        rowsDeleted: rowsToDelete.length,
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
