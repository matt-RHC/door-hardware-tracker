// Smartsheet REST API utility for door hardware tracker
// Docs: https://developers.smartsheet.com/api/smartsheet/introduction

const SMARTSHEET_API_BASE = 'https://api.smartsheet.com/2.0'

function getToken(): string {
  const token = process.env.SMARTSHEET_API_TOKEN
  if (!token) throw new Error('SMARTSHEET_API_TOKEN environment variable is not set')
  return token
}

async function smartsheetFetch(path: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(`${SMARTSHEET_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Smartsheet API error ${res.status}: ${body}`)
  }

  return res.json()
}

// Column definitions for a door hardware project sheet
export const PROJECT_SHEET_COLUMNS = [
  { title: 'Door Number', type: 'TEXT_NUMBER', primary: true },
  { title: 'HW Set', type: 'TEXT_NUMBER' },
  { title: 'Location', type: 'TEXT_NUMBER' },
  { title: 'Door Type', type: 'TEXT_NUMBER' },
  { title: 'Frame Type', type: 'TEXT_NUMBER' },
  { title: 'Fire Rating', type: 'TEXT_NUMBER' },
  { title: 'Hand', type: 'TEXT_NUMBER' },
  { title: 'Classification', type: 'PICKLIST', options: ['Bench', 'Field', 'Mixed', 'Unclassified'] },
  { title: 'Received', type: 'TEXT_NUMBER' },
  { title: 'Pre-Install / Installed', type: 'TEXT_NUMBER' },
  { title: 'QA/QC', type: 'TEXT_NUMBER' },
  { title: 'Overall Status', type: 'PICKLIST', options: ['Not Started', 'In Progress', 'Complete'] },
  { title: 'Progress %', type: 'TEXT_NUMBER' },
  { title: 'Total Items', type: 'TEXT_NUMBER' },
  { title: 'App Link', type: 'TEXT_NUMBER' },
] as const

export interface SmartsheetColumn {
  id: number
  title: string
  type: string
  primary?: boolean
}

export interface SmartsheetSheet {
  id: number
  name: string
  permalink: string
  columns: SmartsheetColumn[]
}

export interface SmartsheetRow {
  id: number
  cells: Array<{ columnId: number; value: any; displayValue?: string }>
}

// Create a new sheet in a specific folder
export async function createSheetInFolder(
  folderId: number,
  name: string,
  columns: Array<{ title: string; type: string; primary?: boolean; options?: readonly string[] | string[] }>
): Promise<SmartsheetSheet> {
  const data = await smartsheetFetch(`/folders/${folderId}/sheets`, {
    method: 'POST',
    body: JSON.stringify({ name, columns }),
  })
  return data.result
}

// Create a new sheet in a workspace
export async function createSheetInWorkspace(
  workspaceId: number,
  name: string,
  columns: Array<{ title: string; type: string; primary?: boolean; options?: readonly string[] | string[] }>
): Promise<SmartsheetSheet> {
  const data = await smartsheetFetch(`/workspaces/${workspaceId}/sheets`, {
    method: 'POST',
    body: JSON.stringify({ name, columns }),
  })
  return data.result
}

// Create a folder in a workspace
export async function createFolderInWorkspace(
  workspaceId: number,
  name: string
): Promise<{ id: number; name: string }> {
  const data = await smartsheetFetch(`/workspaces/${workspaceId}/folders`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
  return data.result
}

// Get sheet with columns and rows
export async function getSheet(sheetId: number): Promise<{ columns: SmartsheetColumn[]; rows: SmartsheetRow[] }> {
  const data = await smartsheetFetch(`/sheets/${sheetId}`)
  return { columns: data.columns, rows: data.rows || [] }
}

// Get sheet columns only
export async function getSheetColumns(sheetId: number): Promise<SmartsheetColumn[]> {
  const data = await smartsheetFetch(`/sheets/${sheetId}/columns`)
  return data.data
}

// Add rows to a sheet
export async function addRows(
  sheetId: number,
  rows: Array<{ toBottom?: boolean; cells: Array<{ columnId: number; value: any }> }>
): Promise<SmartsheetRow[]> {
  const data = await smartsheetFetch(`/sheets/${sheetId}/rows`, {
    method: 'POST',
    body: JSON.stringify(rows),
  })
  return data.result
}

// Update existing rows
export async function updateRows(
  sheetId: number,
  rows: Array<{ id: number; cells: Array<{ columnId: number; value: any }> }>
): Promise<SmartsheetRow[]> {
  const data = await smartsheetFetch(`/sheets/${sheetId}/rows`, {
    method: 'PUT',
    body: JSON.stringify(rows),
  })
  return data.result
}

// Delete rows
export async function deleteRows(sheetId: number, rowIds: number[]): Promise<void> {
  const ids = rowIds.join(',')
  await smartsheetFetch(`/sheets/${sheetId}/rows?ids=${ids}&ignoreRowsNotFound=true`, {
    method: 'DELETE',
  })
}

// List folders in a workspace
export async function listWorkspaceFolders(workspaceId: number): Promise<Array<{ id: number; name: string }>> {
  const data = await smartsheetFetch(`/workspaces/${workspaceId}`)
  return data.folders || []
}

// Search for sheets by name
export async function searchSheets(query: string): Promise<Array<{ objectId: number; text: string }>> {
  const data = await smartsheetFetch(`/search?query=${encodeURIComponent(query)}`)
  return (data.results || []).filter((r: any) => r.objectType === 'sheet')
}
