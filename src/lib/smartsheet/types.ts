// Smartsheet API types

export type SheetType = 'project' | 'submittal' | 'delivery' | 'issues' | 'portfolio'

export interface SmartsheetColumn {
  id: number
  title: string
  type: string
  primary?: boolean
  options?: string[]
}

export interface SmartsheetCell {
  columnId: number
  value: any
  displayValue?: string
}

export interface SmartsheetRow {
  id: number
  rowNumber?: number
  cells: SmartsheetCell[]
  modifiedAt?: string
}

export interface SmartsheetSheet {
  id: number
  name: string
  permalink: string
  version?: number
  columns: SmartsheetColumn[]
  rows?: SmartsheetRow[]
}

export interface SmartsheetWebhook {
  id: number
  name: string
  callbackUrl: string
  scope: string
  scopeObjectId: number
  status: 'ENABLED' | 'DISABLED' | 'NEW_NOT_VERIFIED'
  version: number
  sharedSecret?: string
}

export interface WebhookEvent {
  objectType: 'cell' | 'row' | 'column' | 'sheet'
  eventType: 'created' | 'updated' | 'deleted'
  rowId?: number
  columnId?: number
  userId?: number
  timestamp: string
}

export interface WebhookCallbackPayload {
  nonce: string
  timestamp: string
  webhookId: number
  scope: string
  scopeObjectId: number
  events: WebhookEvent[]
}

export interface ColumnDefinition {
  title: string
  type: string
  primary?: boolean
  options?: string[]
}

export interface SyncResult {
  success: boolean
  sheetId: number
  permalink: string
  created: boolean
  rowsSynced: number
  rowsAdded: number
  rowsUpdated: number
  rowsDeleted: number
}
