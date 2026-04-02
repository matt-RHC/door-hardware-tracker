// Generic two-way sync engine for Smartsheet integration

import { createAdminSupabaseClient } from '@/lib/supabase/server'
import { getSheet, addRows, updateRows, deleteRows } from './client'
import { SmartsheetColumn, SmartsheetCell, SmartsheetRow } from './types'
import crypto from 'crypto'

const WORKSPACE_ID = 5453896878450564
const FOLDER_NAME = 'Door Hardware QR'

export { WORKSPACE_ID, FOLDER_NAME }

export interface RowMapping {
  localId: string
  primaryKey: string
  cells: SmartsheetCell[]
}

// Compute a hash of cell values for change detection
export function computeHash(cells: SmartsheetCell[]): string {
  const values = cells.map(c => `${c.columnId}:${c.value ?? ''}`).join('|')
  return crypto.createHash('md5').update(values).digest('hex')
}

// Build a column map: title -> id
export function buildColumnMap(columns: SmartsheetColumn[]): Map<string, number> {
  return new Map(columns.map(c => [c.title, c.id]))
}

// Get column ID by title, throws if not found
export function getColId(colMap: Map<string, number>, title: string): number {
  const id = colMap.get(title)
  if (!id) throw new Error(`Column "${title}" not found in Smartsheet`)
  return id
}

// Reconcile local data with Smartsheet (push direction)
export async function pushSync(params: {
  sheetId: number
  projectId: string
  sheetType: string
  localRows: RowMapping[]
  columns: SmartsheetColumn[]
}): Promise<{
  rowsAdded: number
  rowsUpdated: number
  rowsDeleted: number
}> {
  const { sheetId, projectId, sheetType, localRows, columns } = params
  const adminSupabase = createAdminSupabaseClient()

  // Get current Smartsheet data
  const sheet = await getSheet(sheetId)
  const existingRows = sheet.rows || []

  // Find primary column
  const primaryCol = columns.find(c => c.primary)
  if (!primaryCol) throw new Error('No primary column found')

  // Build map of existing rows by primary key value
  const existingByKey = new Map<string, SmartsheetRow>()
  for (const row of existingRows) {
    const cell = row.cells.find(c => c.columnId === primaryCol.id)
    if (cell?.value != null) {
      existingByKey.set(String(cell.value), row)
    }
  }

  const toAdd: Array<{ toBottom: boolean; cells: SmartsheetCell[] }> = []
  const toUpdate: Array<{ id: number; cells: SmartsheetCell[] }> = []
  const matchedRowIds = new Set<number>()

  for (const local of localRows) {
    const existing = existingByKey.get(local.primaryKey)
    if (existing) {
      toUpdate.push({ id: existing.id, cells: local.cells })
      matchedRowIds.add(existing.id)
    } else {
      toAdd.push({ toBottom: true, cells: local.cells })
    }
  }

  // Rows in Smartsheet not in local data — delete them
  const toDelete = existingRows
    .filter(r => !matchedRowIds.has(r.id))
    .map(r => r.id)

  // Execute in batches of 500
  const addedRows: SmartsheetRow[] = []
  if (toUpdate.length > 0) {
    for (let i = 0; i < toUpdate.length; i += 500) {
      await updateRows(sheetId, toUpdate.slice(i, i + 500))
    }
  }
  if (toAdd.length > 0) {
    for (let i = 0; i < toAdd.length; i += 500) {
      const result = await addRows(sheetId, toAdd.slice(i, i + 500))
      addedRows.push(...(result || []))
    }
  }
  if (toDelete.length > 0) {
    for (let i = 0; i < toDelete.length; i += 500) {
      await deleteRows(sheetId, toDelete.slice(i, i + 500))
    }
  }

  // Update row mappings
  // First, refresh the sheet to get accurate row IDs
  const refreshedSheet = await getSheet(sheetId)
  const refreshedRows = refreshedSheet.rows || []

  for (const local of localRows) {
    const ssRow = refreshedRows.find(r => {
      const cell = r.cells.find(c => c.columnId === primaryCol.id)
      return cell && String(cell.value) === local.primaryKey
    })
    if (!ssRow) continue

    const hash = computeHash(local.cells)
    await (adminSupabase as any)
      .from('smartsheet_row_map')
      .upsert({
        project_id: projectId,
        sheet_type: sheetType,
        smartsheet_sheet_id: sheetId,
        smartsheet_row_id: ssRow.id,
        local_record_id: local.localId,
        local_table: sheetType === 'project' ? 'openings' : sheetType === 'issues' ? 'issues' : sheetType === 'delivery' ? 'deliveries' : 'openings',
        last_synced_at: new Date().toISOString(),
        sync_hash: hash,
      }, { onConflict: 'sheet_type,local_record_id' })
  }

  return {
    rowsAdded: toAdd.length,
    rowsUpdated: toUpdate.length,
    rowsDeleted: toDelete.length,
  }
}

// Pull changes from Smartsheet for specified rows (called by webhook handler)
export async function pullSync(params: {
  sheetId: number
  projectId: string
  sheetType: string
  changedRowIds: number[]
  columns: SmartsheetColumn[]
  applyChanges: (rowId: number, values: Record<string, any>, localRecordId: string | null) => Promise<void>
}): Promise<{ rowsProcessed: number }> {
  const { sheetId, projectId, sheetType, changedRowIds, columns, applyChanges } = params
  const adminSupabase = createAdminSupabaseClient()

  // Get the full sheet data
  const sheet = await getSheet(sheetId)
  const rows = sheet.rows || []

  const colMap = buildColumnMap(columns)
  let processed = 0

  for (const rowId of changedRowIds) {
    const row = rows.find(r => r.id === rowId)
    if (!row) continue

    // Look up the local mapping
    const { data: mapping } = await (adminSupabase as any)
      .from('smartsheet_row_map')
      .select('local_record_id, sync_hash')
      .eq('smartsheet_sheet_id', sheetId)
      .eq('smartsheet_row_id', rowId)
      .single()

    // Convert row cells to a key-value map
    const values: Record<string, any> = {}
    for (const cell of row.cells) {
      const col = columns.find(c => c.id === cell.columnId)
      if (col) {
        values[col.title] = cell.value
      }
    }

    await applyChanges(rowId, values, mapping?.local_record_id || null)
    processed++
  }

  return { rowsProcessed: processed }
}
