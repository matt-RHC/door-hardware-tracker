import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase/server'
import { createSheetInFolder, getSheet } from '@/lib/smartsheet/client'
import { SUBMITTAL_SHEET_COLUMNS } from '@/lib/smartsheet/columns'
import { pushSync, buildColumnMap, getColId, WORKSPACE_ID, FOLDER_NAME } from '@/lib/smartsheet/sync-engine'
import { registerWebhook } from '@/lib/smartsheet/webhook'
import { listWorkspaceFolders, createFolderInWorkspace } from '@/lib/smartsheet/client'

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

    // Get project info
    const { data: project } = await (adminSupabase as any)
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single()

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Get openings grouped by hw_set with hardware item summaries
    const { data: openings } = await (adminSupabase as any)
      .from('openings')
      .select(`
        id,
        hw_set,
        hw_heading,
        hardware_items(
          name,
          qty,
          manufacturer,
          model
        )
      `)
      .eq('project_id', projectId)
      .order('hw_set', { ascending: true })

    if (!openings || openings.length === 0) {
      return NextResponse.json({ error: 'No openings to track' }, { status: 400 })
    }

    // Group by hw_set
    const hwSetGroups = new Map<string, {
      hwSet: string
      hwHeading: string
      openingCount: number
      hardwareSummary: string
      totalQty: number
    }>()

    for (const opening of openings as any[]) {
      const key = opening.hw_set || 'Unknown'
      const existing = hwSetGroups.get(key)
      const items = opening.hardware_items || []
      const itemNames = [...new Set(items.map((i: any) => i.name))].join(', ')
      const itemQty = items.reduce((sum: number, i: any) => sum + (i.qty || 1), 0)

      if (existing) {
        existing.openingCount++
        existing.totalQty += itemQty
        // Merge unique hardware items
        const existingItems = new Set(existing.hardwareSummary.split(', '))
        items.forEach((i: any) => existingItems.add(i.name))
        existing.hardwareSummary = [...existingItems].join(', ')
      } else {
        hwSetGroups.set(key, {
          hwSet: key,
          hwHeading: opening.hw_heading || '',
          openingCount: 1,
          hardwareSummary: itemNames,
          totalQty: itemQty,
        })
      }
    }

    let sheetId = project.smartsheet_submittal_sheet_id as number | null
    let sheetPermalink: string

    const sheetName = `Submittal Tracker - ${project.name}${project.job_number ? ` (${project.job_number})` : ''}`

    if (!sheetId) {
      // Create new submittal sheet
      const folderId = await getOrCreateFolder(WORKSPACE_ID, FOLDER_NAME)
      const newSheet = await createSheetInFolder(folderId, sheetName, [...SUBMITTAL_SHEET_COLUMNS])
      sheetId = newSheet.id
      sheetPermalink = newSheet.permalink

      await (adminSupabase as any)
        .from('projects')
        .update({ smartsheet_submittal_sheet_id: sheetId })
        .eq('id', projectId)

      const colMap = buildColumnMap(newSheet.columns)
      const localRows = [...hwSetGroups.values()].map(group => ({
        localId: `submittal-${group.hwSet}`,
        primaryKey: group.hwSet,
        cells: [
          { columnId: getColId(colMap, 'HW Set'), value: group.hwSet },
          { columnId: getColId(colMap, 'HW Heading'), value: group.hwHeading },
          { columnId: getColId(colMap, 'Total Openings'), value: group.openingCount },
          { columnId: getColId(colMap, 'Hardware Summary'), value: group.hardwareSummary },
          { columnId: getColId(colMap, 'Total Qty'), value: group.totalQty },
          { columnId: getColId(colMap, 'Submittal Status'), value: 'Not Submitted' },
          { columnId: getColId(colMap, 'Notes'), value: '' },
        ],
      }))

      await pushSync({
        sheetId,
        projectId,
        sheetType: 'submittal',
        localRows,
        columns: newSheet.columns,
      })

      // Register webhook
      try {
        if (process.env.SMARTSHEET_WEBHOOK_URL) {
          await registerWebhook({
            sheetId,
            projectId,
            sheetType: 'submittal',
            sheetName,
          })
        }
      } catch {}

      return NextResponse.json({
        success: true,
        created: true,
        sheetId,
        permalink: sheetPermalink,
        hwSets: hwSetGroups.size,
      })
    } else {
      // Update existing
      const sheet = await getSheet(sheetId)
      const colMap = buildColumnMap(sheet.columns)

      const localRows = [...hwSetGroups.values()].map(group => ({
        localId: `submittal-${group.hwSet}`,
        primaryKey: group.hwSet,
        cells: [
          { columnId: getColId(colMap, 'HW Set'), value: group.hwSet },
          { columnId: getColId(colMap, 'HW Heading'), value: group.hwHeading },
          { columnId: getColId(colMap, 'Total Openings'), value: group.openingCount },
          { columnId: getColId(colMap, 'Hardware Summary'), value: group.hardwareSummary },
          { columnId: getColId(colMap, 'Total Qty'), value: group.totalQty },
        ],
      }))

      await pushSync({
        sheetId,
        projectId,
        sheetType: 'submittal',
        localRows,
        columns: sheet.columns,
      })

      sheetPermalink = `https://app.smartsheet.com/sheets/${sheetId}`
      return NextResponse.json({
        success: true,
        created: false,
        sheetId,
        permalink: sheetPermalink,
        hwSets: hwSetGroups.size,
      })
    }
  } catch (error) {
    console.error('Submittal sync error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Sync failed' },
      { status: 500 }
    )
  }
}
