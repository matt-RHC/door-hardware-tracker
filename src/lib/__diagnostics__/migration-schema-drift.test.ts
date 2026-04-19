/**
 * Schema-drift regression guard.
 *
 * Catches the class of bug behind hotfix PRs #341 and #343:
 *
 *   PR #333 (mig 050) narrowed the `extraction_runs.status` CHECK to 4 values,
 *   dropping 'promoted'. The commit message claimed `merge_extraction` never
 *   wrote 'promoted' — false. Mig 037 (and 034, 025, 021, 016, 013, 012, 010)
 *   all define merge_extraction to write `status = 'promoted'`. An EXCEPTION
 *   handler in the function body swallowed the CHECK violation in prod, so
 *   deploy-time smoke tests passed while every real promotion silently failed.
 *   Hotfix PR #343 (mig 056) had to re-add the value.
 *
 *   PR #339 (mig 054) dropped `openings.notes` without auditing that
 *   merge_extraction (mig 037) still referenced the column. Hotfix PR #341
 *   (mig 055) redefined the function.
 *
 * Common shape: a schema / CHECK constraint change ships without auditing
 * the Postgres functions that depend on the old shape. The TS compiler can't
 * see into .sql files, so the mismatch survives code review and lands in prod.
 *
 * This test parses the migrations directory and cross-validates:
 *
 *   (A) every status value the LATEST merge_extraction writes must be allowed
 *       by the LATEST extraction_runs.status CHECK constraint
 *   (B) the CHECK includes the canonical terminal states the codebase expects
 *
 * It is intentionally narrow — fuzzy cross-migration SQL parsing is fragile,
 * so we pin the specific drift class we've actually been burned by. Add more
 * table/function pairs here as future drift incidents occur.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

/** Load migration files in applied-order (filename is numeric-prefixed). */
function loadMigrations(): Array<{ name: string; body: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort() // lexical sort matches Supabase CLI's application order
    .map(name => ({
      name,
      body: readFileSync(join(MIGRATIONS_DIR, name), 'utf8'),
    }))
}

/**
 * Return the allowed values for `extraction_runs.status` as of the latest
 * migration that touches the CHECK constraint.
 *
 * Postgres CHECK clauses on a status column appear in two shapes across this
 * codebase:
 *   1. `CHECK (status IN ('a', 'b', ...))` — used in early migrations (table
 *      creation and simple CHECKs).
 *   2. `CHECK (status = ANY (ARRAY['a'::text, 'b'::text, ...]))` — used by
 *      later `ALTER TABLE ... ADD CONSTRAINT` migrations (050, 056). The
 *      ARRAY form can span multiple lines, so we extract the bracketed body
 *      and pull out quoted literals.
 *
 * DROP CONSTRAINT lines clear the previous set; the next ADD CONSTRAINT sets
 * the new one. We walk migrations in filename order and the last ADD wins.
 */
function getLatestExtractionRunsStatusCheck(): Set<string> {
  const migs = loadMigrations()
  // Form 1: status IN ('a', 'b')
  const inFormRe = /CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/gi
  // Form 2: status = ANY (ARRAY[...]) — body may span lines.
  const anyFormRe = /CHECK\s*\(\s*status\s*=\s*ANY\s*\(\s*ARRAY\s*\[([\s\S]*?)\]\s*\)/gi
  // Quoted string literal extractor for the ARRAY body.
  const quotedLiteralRe = /'([^']+)'/g

  let latest: Set<string> | null = null
  for (const { body } of migs) {
    // Only inspect migration bodies that mention extraction_runs by name so
    // we don't pick up CHECK clauses on unrelated `status` columns (e.g.
    // deliveries.status, extraction_jobs.status). This is a heuristic; a
    // stricter parser would scope to individual statements.
    if (!/extraction_runs/i.test(body)) continue

    for (const match of body.matchAll(inFormRe)) {
      const values = match[1]
        .split(',')
        .map(v => v.trim().replace(/^'|'$/g, ''))
        .filter(v => v.length > 0)
      latest = new Set(values)
    }
    for (const match of body.matchAll(anyFormRe)) {
      const values: string[] = []
      for (const lit of match[1].matchAll(quotedLiteralRe)) {
        values.push(lit[1])
      }
      if (values.length > 0) latest = new Set(values)
    }
  }
  if (!latest) throw new Error('Could not locate extraction_runs.status CHECK in any migration')
  return latest
}

/**
 * Return the set of status string literals written by the LATEST
 * CREATE OR REPLACE FUNCTION merge_extraction definition. Matches
 * `SET status = 'VALUE'` clauses inside the function body.
 */
function getLatestMergeExtractionStatusWrites(): Set<string> {
  const migs = loadMigrations()
  const fnStartRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+merge_extraction\b/i
  let latestBody: string | null = null
  for (const { body } of migs) {
    if (fnStartRe.test(body)) latestBody = body
  }
  if (!latestBody) throw new Error('Could not locate merge_extraction definition in any migration')
  const writes = new Set<string>()
  // Match `status = 'value'` in SET clauses (case-insensitive, whitespace tolerant).
  const writeRe = /status\s*=\s*'([^']+)'/gi
  for (const match of latestBody.matchAll(writeRe)) {
    writes.add(match[1])
  }
  if (writes.size === 0) throw new Error('merge_extraction definition contains no status writes — parser drift?')
  return writes
}

describe('migration schema-drift guard', () => {
  it('latest extraction_runs.status CHECK allows every value merge_extraction writes', () => {
    const allowed = getLatestExtractionRunsStatusCheck()
    const written = getLatestMergeExtractionStatusWrites()
    const missing = [...written].filter(v => !allowed.has(v))
    expect(missing, `merge_extraction writes these status values, but the latest CHECK forbids them: ${missing.join(', ')}. Either widen the CHECK or update the function. See hotfix PRs #341/#343 for the bug class this test catches.`).toEqual([])
  })

  it('extraction_runs.status CHECK includes the canonical terminal states', () => {
    const allowed = getLatestExtractionRunsStatusCheck()
    // These are the states referenced across the codebase in src/lib/extraction-staging.ts
    // and src/app/api/jobs/[id]/run/route.ts. If a future migration drops any of
    // these, the TS side will still try to write them and fail at runtime.
    const required = ['extracting', 'reviewing', 'completed_with_issues', 'failed', 'promoted']
    const missing = required.filter(v => !allowed.has(v))
    expect(missing, `the latest CHECK dropped these canonical states: ${missing.join(', ')}`).toEqual([])
  })
})
