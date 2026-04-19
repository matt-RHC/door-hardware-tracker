/**
 * Column-reference drift guard.
 *
 * Sister test to migration-schema-drift.test.ts. Where that one pins the
 * status-value-vs-CHECK drift class, this one pins the column-reference
 * drift class — the one behind hotfix PR #341:
 *
 *   PR #339 (mig 054) dropped `openings.notes`. But `merge_extraction`
 *   (last redefined in mig 037) still wrote `notes = v_staging.notes` in
 *   two UPDATEs and listed `notes` in an INSERT. Postgres doesn't validate
 *   function bodies at definition time — the references only fail at
 *   call time. And the catch-all EXCEPTION handler (since removed in
 *   mig 059) converted the column-not-exist error into generic failure
 *   JSON, so Sentry never saw it. Every real promotion silently failed
 *   until the end-to-end probe found it. Hotfix PR #341 redefined the
 *   function (mig 055).
 *
 * v1 scope: audit merge_extraction + write_staging_data only. Parse the
 * latest CREATE OR REPLACE FUNCTION body for each, extract every
 * `INSERT INTO <table> (col, col, ...)` column list and every
 * `UPDATE <table> SET col = ..., col = ...` assignment LHS, then
 * cross-check each (table, column) against the latest resolved column
 * state of that table (walking migrations in order, applying CREATE
 * TABLE / ADD COLUMN / DROP COLUMN / RENAME COLUMN).
 *
 * Intentionally narrow:
 *   - Only auto-audits INSERT and UPDATE column LHS. SELECT/WHERE column
 *     refs are harder (require alias resolution) and weren't the bug
 *     class we got burned by.
 *   - Skips dynamic SQL (EXECUTE '...') since it can't be statically
 *     analyzed.
 *   - Skips quoted identifiers — this codebase doesn't use them in RPCs.
 *   - Skips ALTER TABLE ... RENAME TO (table rename) — we don't do those.
 *   - String literals in VALUES / WHERE / CHECK are values, not columns —
 *     this test only flags column *references*, matching the actual bug
 *     class. Value-vs-CHECK drift is covered by migration-schema-drift.
 *
 * Add more functions to FUNCTIONS_TO_AUDIT as future drift occurs.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

const FUNCTIONS_TO_AUDIT = ['merge_extraction', 'write_staging_data'] as const

// Keywords that can appear at the start of a CREATE TABLE column-list line
// but do not introduce a column (constraint/continuation lines).
const NON_COLUMN_LINE_STARTS = new Set([
  'CHECK',
  'CONSTRAINT',
  'PRIMARY',
  'FOREIGN',
  'UNIQUE',
  'REFERENCES',
  'ON',
  'EXCLUDE',
  'LIKE',
])

type Migration = { name: string; body: string }

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(name => ({ name, body: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }))
}

function matchParen(s: string, openIdx: number): number {
  if (s[openIdx] !== '(') return -1
  let depth = 1
  for (let i = openIdx + 1; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function stripLineComments(s: string): string {
  return s
    .split('\n')
    .map(line => {
      const idx = line.indexOf('--')
      return idx >= 0 ? line.slice(0, idx) : line
    })
    .join('\n')
}

// Build a RegExp that matches a SQL statement prefix + a specific identifier.
// We compose from explicit string fragments rather than a template literal with
// `\s` escapes because the vite/oxc parser has historically had trouble with
// template literals that mix `\s` sequences and `${...}` interpolations.
function reFor(prefix: string, ident: string, suffix: string, flags: string): RegExp {
  return new RegExp(prefix + ident + suffix, flags)
}

function getLatestTableColumns(table: string): Set<string> {
  const cols = new Set<string>()
  let seen = false

  const createPrefix = 'CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?'
  const createSuffix = '\\s*\\('
  // Single regex that grabs the WHOLE ALTER TABLE <table> ... ; block. This
  // handles the compound form mig 029 uses:
  //   ALTER TABLE hardware_items
  //     ADD COLUMN IF NOT EXISTS qty_total      INTEGER,
  //     ADD COLUMN IF NOT EXISTS qty_door_count INTEGER,
  //     ADD COLUMN IF NOT EXISTS qty_source     TEXT;
  // where only the first column would match a naive "ALTER TABLE <table>
  // ADD COLUMN <col>" pattern. We extract the clauses (everything between
  // the table name and the terminating `;`) and then scan that region for
  // all ADD/DROP/RENAME COLUMN operations.
  const alterPrefix = 'ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?'
  const alterSuffix = '\\s+([\\s\\S]*?);'

  for (const { body } of loadMigrations()) {
    const clean = stripLineComments(body)

    // CREATE TABLE <table> ( ... )
    const createRe = reFor(createPrefix, table, createSuffix, 'gi')
    for (const m of clean.matchAll(createRe)) {
      seen = true
      const openIdx = m.index! + m[0].length - 1
      const closeIdx = matchParen(clean, openIdx)
      if (closeIdx < 0) continue
      const colList = clean.slice(openIdx + 1, closeIdx)
      for (const rawLine of colList.split('\n')) {
        const line = rawLine.trim()
        if (!line) continue
        const firstWordMatch = /^(\w+)/.exec(line)
        if (!firstWordMatch) continue
        const firstWord = firstWordMatch[1].toUpperCase()
        if (NON_COLUMN_LINE_STARTS.has(firstWord)) continue
        cols.add(firstWordMatch[1])
      }
    }

    // ALTER TABLE <table> ... ; — extract the whole block, then scan inside
    // for every ADD / DROP / RENAME COLUMN clause. This correctly handles
    // both the single-clause and comma-separated compound-clause forms.
    const alterRe = reFor(alterPrefix, table, alterSuffix, 'gi')
    for (const m of clean.matchAll(alterRe)) {
      const clauses = m[1]
      for (const ac of clauses.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)) {
        seen = true
        cols.add(ac[1])
      }
      for (const dc of clauses.matchAll(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(\w+)/gi)) {
        cols.delete(dc[1])
      }
      for (const rc of clauses.matchAll(/RENAME\s+COLUMN\s+(\w+)\s+TO\s+(\w+)/gi)) {
        if (cols.has(rc[1])) {
          cols.delete(rc[1])
          cols.add(rc[2])
        }
      }
    }
  }

  if (!seen) {
    throw new Error('Table ' + table + ' is never created or altered in any migration — parser drift or bad table name?')
  }
  return cols
}

function getLatestFunctionBody(name: string): string | null {
  let latest: string | null = null
  const startPrefix = 'CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?'
  const startSuffix = '\\b'
  for (const { body } of loadMigrations()) {
    const startRe = reFor(startPrefix, name, startSuffix, 'gi')
    for (const m of body.matchAll(startRe)) {
      const tail = body.slice(m.index!)
      const dollarMatch = /AS\s+(\$\w*\$)/.exec(tail)
      if (!dollarMatch) continue
      const tag = dollarMatch[1]
      const bodyStart = dollarMatch.index! + dollarMatch[0].length
      const bodyEnd = tail.indexOf(tag, bodyStart + tag.length)
      if (bodyEnd < 0) continue
      latest = tail.slice(bodyStart, bodyEnd)
    }
  }
  return latest
}

type ColumnRef = {
  table: string
  column: string
  kind: 'insert' | 'update'
}

function extractColumnRefs(fnBody: string): ColumnRef[] {
  const clean = stripLineComments(fnBody)
  const refs: ColumnRef[] = []

  // INSERT INTO <table> ( cols )
  const insertRe = /INSERT\s+INTO\s+(\w+)\s*\(/gi
  for (const m of clean.matchAll(insertRe)) {
    const table = m[1]
    const openIdx = m.index! + m[0].length - 1
    const closeIdx = matchParen(clean, openIdx)
    if (closeIdx < 0) continue
    const colList = clean.slice(openIdx + 1, closeIdx)
    for (const rawCol of colList.split(',')) {
      const col = rawCol.trim()
      if (/^\w+$/.test(col)) refs.push({ table, column: col, kind: 'insert' })
    }
  }

  // UPDATE <table> SET <assignments> (terminated by WHERE or ;)
  const updateRe = /UPDATE\s+(\w+)\s+SET\s+([\s\S]*?)(?:\s+WHERE\b|\s*;)/gi
  for (const m of clean.matchAll(updateRe)) {
    const table = m[1]
    const setClause = m[2]
    const assignRe = /(?:^|,)\s*(\w+)\s*=(?!=)/g
    for (const am of setClause.matchAll(assignRe)) {
      refs.push({ table, column: am[1], kind: 'update' })
    }
  }

  return refs
}

describe('migration column-drift guard', () => {
  for (const fnName of FUNCTIONS_TO_AUDIT) {
    it('every (table, column) referenced by ' + fnName + ' exists in the latest schema', () => {
      const body = getLatestFunctionBody(fnName)
      expect(body, fnName + ' must be defined in at least one migration').not.toBeNull()

      const refs = extractColumnRefs(body!)
      expect(refs.length, fnName + ' extraction produced zero column refs — parser drift?').toBeGreaterThan(0)

      const byTable = new Map<string, ColumnRef[]>()
      for (const ref of refs) {
        const list = byTable.get(ref.table) ?? []
        list.push(ref)
        byTable.set(ref.table, list)
      }

      const problems: string[] = []
      for (const [table, tableRefs] of byTable) {
        const cols = getLatestTableColumns(table)
        const missing = tableRefs.filter(r => !cols.has(r.column))
        for (const m of missing) {
          problems.push(fnName + ' ' + m.kind.toUpperCase() + 's ' + table + '.' + m.column + ' but that column does not exist in the latest schema')
        }
      }

      expect(
        problems,
        'Column-drift detected in ' + fnName + ':\n  - ' + problems.join('\n  - ') + '\n\n' +
          'This is the bug class from hotfix PR #341. Redefine the function (CREATE OR REPLACE) ' +
          'to stop referencing the dropped/renamed column, OR restore the column if the drop was premature.',
      ).toEqual([])
    })
  }

  it('parser extracts a non-trivial set of refs from merge_extraction', () => {
    const body = getLatestFunctionBody('merge_extraction')
    expect(body).not.toBeNull()
    const refs = extractColumnRefs(body!)
    expect(refs.length).toBeGreaterThan(20)
    const tables = new Set(refs.map(r => r.table))
    expect(tables.has('openings')).toBe(true)
    expect(tables.has('hardware_items')).toBe(true)
    expect(tables.has('extraction_runs')).toBe(true)
  })

  // Regression simulation: prove the parser WOULD have caught the PR #341
  // bug class. If mig 055's redefinition had never landed and merge_extraction
  // still carried the three `notes` references, the audit would flag
  // openings.notes (the dropped column from mig 054) three times.
  //
  // We don't patch the migrations dir for this check — we run extractColumnRefs
  // against a synthetic function body that matches the PR #341 shape and
  // then verify the missing-column detector does the right thing against
  // the REAL latest column set.
  it('drift detector would have caught the PR #341 notes-drift', () => {
    const pr341Shape = [
      'BEGIN',
      "  UPDATE openings SET hw_set = 'x', notes = 'y' WHERE id = '123';",
      "  UPDATE openings SET location = 'x', notes = 'y' WHERE id = '123';",
      "  INSERT INTO openings (project_id, door_number, notes) VALUES ('p', 'd', 'n');",
      'END',
    ].join('\n')
    const refs = extractColumnRefs(pr341Shape)
    const openingsCols = getLatestTableColumns('openings')
    const notesRefs = refs.filter(r => r.table === 'openings' && r.column === 'notes')
    expect(notesRefs.length).toBe(3)
    expect(openingsCols.has('notes')).toBe(false)
  })
})
