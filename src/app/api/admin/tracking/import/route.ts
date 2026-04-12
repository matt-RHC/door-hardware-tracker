// POST /api/admin/tracking/import
//
// Milestone 1 of the Smartsheet-replacement project. Pulls the three
// cross-session tracking sheets (Project Plan / Session Log / Metrics Log)
// from Smartsheet via the existing stable client (not MCP) and upserts them
// into the `tracking_items` table.
//
// Query params:
//   ?dryRun=1       — compute the upsert payload but do not write
//   ?type=plan_item — limit to a single record type (plan_item|session|metric_run)
//
// See /root/.claude/plans/mutable-dazzling-tide.md for context.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase/server'
import { getSheet } from '@/lib/smartsheet/client'
import type { SmartsheetRow, SmartsheetSheet } from '@/lib/smartsheet/types'
import {
  TRACKING_SHEET_IDS,
  TrackingRecordType,
  requireTrackingAdmin,
} from '@/lib/tracking/constants'
import type { TrackingItemInsert } from '@/lib/types/database'

export const runtime = 'nodejs'
export const maxDuration = 300

type CellLookup = (columnTitle: string) => string | null

/** Build a per-row lookup by column title. Case-insensitive, trims whitespace. */
function makeCellLookup(sheet: SmartsheetSheet, row: SmartsheetRow): CellLookup {
  const titleToColId = new Map<string, number>()
  for (const col of sheet.columns ?? []) {
    titleToColId.set(col.title.trim().toLowerCase(), col.id)
  }
  const cellsByColId = new Map<number, { value: unknown; displayValue?: string }>()
  for (const cell of row.cells ?? []) {
    cellsByColId.set(cell.columnId, { value: cell.value, displayValue: cell.displayValue })
  }
  return (columnTitle: string) => {
    const colId = titleToColId.get(columnTitle.trim().toLowerCase())
    if (colId === undefined) return null
    const cell = cellsByColId.get(colId)
    if (!cell) return null
    // Prefer displayValue (user-facing rendering) when present, else raw value.
    const raw = cell.displayValue ?? cell.value
    if (raw === null || raw === undefined || raw === '') return null
    return String(raw)
  }
}

/** Parse "S-057, S-058, S-074" → ['S-057','S-058','S-074']. */
function parseSessionRefs(value: string | null): string[] | null {
  if (!value) return null
  const refs = value
    .split(/[,;\s]+/)
    .map(s => s.trim())
    .filter(s => /^S-\d+$/i.test(s))
    .map(s => s.toUpperCase())
  return refs.length > 0 ? refs : null
}

/** Parse a loose date value into ISO YYYY-MM-DD, or null. */
function parseDate(value: string | null): string | null {
  if (!value) return null
  // Smartsheet returns ABSTRACTDATETIME as ISO already, DATE as YYYY-MM-DD.
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim())
  return match ? match[1] : null
}

function parseInteger(value: string | null): number | null {
  if (!value) return null
  const trimmed = value.replace(/[^\d-]/g, '')
  if (!trimmed) return null
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function parseNumeric(value: string | null): number | null {
  if (!value) return null
  const parsed = Number.parseFloat(value.replace(/[^\d.-]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

/** Transform a Project Plan row (4722023373688708) into TrackingItemInsert. */
function transformPlanItem(sheet: SmartsheetSheet, row: SmartsheetRow): TrackingItemInsert | null {
  const get = makeCellLookup(sheet, row)
  const title = get('Item')
  if (!title) return null
  return {
    record_type: 'plan_item',
    source_sheet_id: sheet.id,
    source_row_id: row.id,
    source_imported_at: new Date().toISOString(),
    title,
    status: get('Status'),
    category: get('Category'),
    priority: get('Priority'),
    area: get('Area'),
    description: get('Description'),
    notes: get('Root Cause / Notes'),
    session_refs: parseSessionRefs(get('Session Ref')),
    date_identified: parseDate(get('Date Identified')),
    date_resolved: parseDate(get('Date Resolved')),
    due_date: parseDate(get('Due Date')),
    relevance: 'unknown',
  }
}

/**
 * Transform a Session Log row. Column names are not fully known yet —
 * per CLAUDE.md "Session Log" hint: topics, decisions, tasks, status, session ID.
 * This transform is defensive: it reads the likely columns and falls through.
 */
function transformSession(sheet: SmartsheetSheet, row: SmartsheetRow): TrackingItemInsert | null {
  const get = makeCellLookup(sheet, row)
  // Primary column could be "Session", "Session ID", "ID", "Topic", or similar.
  // Fall through candidates until we find a title.
  const title =
    get('Session') ??
    get('Session ID') ??
    get('ID') ??
    get('Topic') ??
    get('Title') ??
    get('Session Ref') ??
    null
  if (!title) return null
  const sessionId = get('Session ID') ?? get('Session') ?? null
  return {
    record_type: 'session',
    source_sheet_id: sheet.id,
    source_row_id: row.id,
    source_imported_at: new Date().toISOString(),
    title,
    status: get('Status'),
    date_identified: parseDate(get('Date') ?? get('Session Date') ?? get('Started')),
    date_resolved: parseDate(get('Ended') ?? get('End Date')),
    session_refs: sessionId ? parseSessionRefs(sessionId) : null,
    session_topics: get('Topics') ?? get('Topic'),
    session_decisions: get('Decisions') ?? get('Decision'),
    session_status: get('Status') ?? get('Session Status'),
    notes: get('Notes') ?? get('Summary') ?? get('Tasks'),
    relevance: 'unknown',
  }
}

/**
 * Transform a Metrics Log row. Per CLAUDE.md hint: session ID, PDF name,
 * expected vs extracted doors/sets, accuracy %, pipeline duration, build commit, notes.
 */
function transformMetric(sheet: SmartsheetSheet, row: SmartsheetRow): TrackingItemInsert | null {
  const get = makeCellLookup(sheet, row)
  const pdfName = get('PDF Name') ?? get('PDF') ?? get('File')
  const sessionId = get('Session ID') ?? get('Session')
  const title = pdfName && sessionId ? `${sessionId} — ${pdfName}` : (pdfName ?? sessionId ?? null)
  if (!title) return null
  return {
    record_type: 'metric_run',
    source_sheet_id: sheet.id,
    source_row_id: row.id,
    source_imported_at: new Date().toISOString(),
    title,
    date_identified: parseDate(get('Date') ?? get('Run Date') ?? get('Timestamp')),
    session_refs: sessionId ? parseSessionRefs(sessionId) : null,
    metric_pdf_name: pdfName,
    metric_doors_expected: parseInteger(get('Expected Doors') ?? get('Doors Expected')),
    metric_doors_extracted: parseInteger(get('Extracted Doors') ?? get('Doors Extracted')),
    metric_sets_expected: parseInteger(get('Expected Sets') ?? get('Sets Expected')),
    metric_sets_extracted: parseInteger(get('Extracted Sets') ?? get('Sets Extracted')),
    metric_accuracy_pct: parseNumeric(get('Accuracy %') ?? get('Accuracy')),
    metric_duration_ms: parseInteger(get('Duration (ms)') ?? get('Duration')),
    metric_build_commit: get('Build Commit') ?? get('Commit'),
    notes: get('Notes') ?? get('Summary'),
    relevance: 'unknown',
  }
}

function transformFor(recordType: TrackingRecordType) {
  switch (recordType) {
    case 'plan_item':
      return transformPlanItem
    case 'session':
      return transformSession
    case 'metric_run':
      return transformMetric
  }
}

interface ImportSummary {
  record_type: TrackingRecordType
  sheet_id: number
  rows_seen: number
  rows_imported: number
  rows_skipped: number
  error: string | null
}

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const auth = await requireTrackingAdmin(supabase)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const url = new URL(request.url)
  const dryRun = url.searchParams.get('dryRun') === '1'
  const typeFilter = url.searchParams.get('type') as TrackingRecordType | null

  if (!process.env.SMARTSHEET_API_KEY) {
    return NextResponse.json(
      { error: 'SMARTSHEET_API_KEY is not set in the server environment' },
      { status: 500 },
    )
  }

  const admin = createAdminSupabaseClient()
  const summaries: ImportSummary[] = []

  const recordTypes: TrackingRecordType[] = typeFilter
    ? [typeFilter]
    : (['plan_item', 'session', 'metric_run'] as TrackingRecordType[])

  for (const recordType of recordTypes) {
    const sheetId = TRACKING_SHEET_IDS[recordType]
    const summary: ImportSummary = {
      record_type: recordType,
      sheet_id: sheetId,
      rows_seen: 0,
      rows_imported: 0,
      rows_skipped: 0,
      error: null,
    }
    summaries.push(summary)

    let sheet: SmartsheetSheet
    try {
      sheet = await getSheet(sheetId)
    } catch (err) {
      summary.error = err instanceof Error ? err.message : String(err)
      continue
    }

    const transform = transformFor(recordType)
    const inserts: TrackingItemInsert[] = []
    for (const row of sheet.rows ?? []) {
      summary.rows_seen += 1
      const payload = transform(sheet, row)
      if (!payload) {
        summary.rows_skipped += 1
        continue
      }
      inserts.push(payload)
    }

    if (dryRun || inserts.length === 0) {
      summary.rows_imported = inserts.length
      continue
    }

    // Upsert on (source_sheet_id, source_row_id). onConflict uses the partial
    // unique index we created in migration 011. Batch in chunks of 200.
    // The `as any` cast matches the existing project pattern in sync-engine.ts
    // and openings/check/route.ts — Supabase's generated upsert types struggle
    // with discriminated unions and nullable column expansions.
    const BATCH_SIZE = 200
    for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
      const batch = inserts.slice(i, i + BATCH_SIZE)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (admin as any)
        .from('tracking_items')
        .upsert(batch, { onConflict: 'source_sheet_id,source_row_id' })
      if (error) {
        summary.error = error.message
        break
      }
      summary.rows_imported += batch.length
    }
  }

  return NextResponse.json({
    ok: summaries.every(s => s.error === null),
    dry_run: dryRun,
    summaries,
  })
}
