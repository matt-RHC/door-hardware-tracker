// Smartsheet REST API client
// Docs: https://developers.smartsheet.com/api/smartsheet/introduction

import { SmartsheetSheet, SmartsheetRow, SmartsheetColumn, SmartsheetCell, SmartsheetWebhook, ColumnDefinition } from './types'

const SMARTSHEET_API_BASE = 'https://api.smartsheet.com/2.0'

// Simple rate limiter: 300 requests per minute
let tokenCount = 300
let lastRefill = Date.now()

async function acquireToken(): Promise<void> {
  const now = Date.now()
  const elapsed = now - lastRefill
  const refill = Math.floor(elapsed / 200) // 5 tokens per second
  if (refill > 0) {
    tokenCount = Math.min(300, tokenCount + refill)
    lastRefill = now
  }
  if (tokenCount <= 0) {
    await new Promise(resolve => setTimeout(resolve, 200))
    return acquireToken()
  }
  tokenCount--
}

function getToken(): string {
  const token = process.env.SMARTSHEET_API_KEY
  if (!token) throw new Error('SMARTSHEET_API_KEY environment variable is not set')
  return token
}

async function smartsheetFetch(path: string, options: RequestInit = {}): Promise<any> {
  await acquireToken()
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

  // DELETE responses may have no body
  const text = await res.text()
  return text ? JSON.parse(text) : {}
}

// ============================================================================
// SHEETS
// ============================================================================

export async function createSheetInFolder(
  folderId: number,
  name: string,
  columns: ColumnDefinition[]
): Promise<SmartsheetSheet> {
  const data = await smartsheetFetch(`/folders/${folderId}/sheets`, {
    method: 'POST',
    body: JSON.stringify({ name, columns }),
  })
  return data.result
}

export async function createSheetInWorkspace(
  workspaceId: number,
  name: string,
  columns: ColumnDefinition[]
): Promise<SmartsheetSheet> {
  const data = await smartsheetFetch(`/workspaces/${workspaceId}/sheets`, {
    method: 'POST',
    body: JSON.stringify({ name, columns }),
  })
  return data.result
}

export async function getSheet(sheetId: number): Promise<SmartsheetSheet> {
  return smartsheetFetch(`/sheets/${sheetId}`)
}

export async function getSheetColumns(sheetId: number): Promise<SmartsheetColumn[]> {
  const data = await smartsheetFetch(`/sheets/${sheetId}/columns`)
  return data.data
}

export async function addRows(
  sheetId: number,
  rows: Array<{ toBottom?: boolean; cells: SmartsheetCell[] }>
): Promise<SmartsheetRow[]> {
  const data = await smartsheetFetch(`/sheets/${sheetId}/rows`, {
    method: 'POST',
    body: JSON.stringify(rows),
  })
  return data.result
}

export async function updateRows(
  sheetId: number,
  rows: Array<{ id: number; cells: SmartsheetCell[] }>
): Promise<SmartsheetRow[]> {
  const data = await smartsheetFetch(`/sheets/${sheetId}/rows`, {
    method: 'PUT',
    body: JSON.stringify(rows),
  })
  return data.result
}

export async function deleteRows(sheetId: number, rowIds: number[]): Promise<void> {
  const ids = rowIds.join(',')
  await smartsheetFetch(`/sheets/${sheetId}/rows?ids=${ids}&ignoreRowsNotFound=true`, {
    method: 'DELETE',
  })
}

// ============================================================================
// FOLDERS & WORKSPACES
// ============================================================================

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

export async function listWorkspaceFolders(workspaceId: number): Promise<Array<{ id: number; name: string }>> {
  const data = await smartsheetFetch(`/workspaces/${workspaceId}`)
  return data.folders || []
}

export async function searchSheets(query: string): Promise<Array<{ objectId: number; text: string }>> {
  const data = await smartsheetFetch(`/search?query=${encodeURIComponent(query)}`)
  return (data.results || []).filter((r: any) => r.objectType === 'sheet')
}

// ============================================================================
// WEBHOOKS
// ============================================================================

export async function createWebhook(
  sheetId: number,
  name: string,
  callbackUrl: string,
  sharedSecret: string
): Promise<SmartsheetWebhook> {
  const data = await smartsheetFetch('/webhooks', {
    method: 'POST',
    body: JSON.stringify({
      name,
      callbackUrl,
      scope: 'sheet',
      scopeObjectId: sheetId,
      version: 1,
      events: ['*.*'],
    }),
  })
  return data.result
}

export async function enableWebhook(webhookId: number): Promise<SmartsheetWebhook> {
  const data = await smartsheetFetch(`/webhooks/${webhookId}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled: true }),
  })
  return data.result
}

export async function deleteWebhook(webhookId: number): Promise<void> {
  await smartsheetFetch(`/webhooks/${webhookId}`, { method: 'DELETE' })
}

export async function listWebhooks(): Promise<SmartsheetWebhook[]> {
  const data = await smartsheetFetch('/webhooks')
  return data.data || []
}
