#!/usr/bin/env -S tsx
/**
 * Audit / backfill tool for extraction-invariants.
 *
 * Runs `validateExtractionRun` over every promoted extraction in a project
 * (or across all projects) and prints a grouped report. Designed to be
 * usable in three places:
 *
 *   1. CI — exit 1 if any blockers are found, 0 otherwise
 *   2. Cron — hit all promoted runs, flag regressions into Sentry
 *   3. Local — one-off sanity check after a suspected bad extraction
 *
 * Usage:
 *   tsx scripts/audit-extraction-invariants.ts --project <project_id>
 *   tsx scripts/audit-extraction-invariants.ts --all
 *   tsx scripts/audit-extraction-invariants.ts --project <id> --json
 *
 * Requires .env.local with:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (service role; bypasses RLS for the scan)
 */

import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/lib/types/database'
import {
  validateExtractionRun,
  type InvariantReport,
  type InvariantViolation,
} from '../src/lib/extraction-invariants'

// ── Env wiring ──────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    'Missing env vars. Ensure .env.local contains:\n' +
      '  NEXT_PUBLIC_SUPABASE_URL=...\n' +
      '  SUPABASE_SERVICE_ROLE_KEY=...\n',
  )
  process.exit(2)
}

const supabase = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ── Arg parsing ─────────────────────────────────────────────────────────────

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag)
  if (idx === -1 || idx + 1 >= process.argv.length) return null
  return process.argv[idx + 1] ?? null
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag)
}

const projectIdArg = argValue('--project')
const scanAll = hasFlag('--all')
const jsonOutput = hasFlag('--json')
const verbose = hasFlag('--verbose') || hasFlag('-v')

if (!projectIdArg && !scanAll) {
  console.error('Specify --project <uuid> or --all.')
  process.exit(2)
}

// ── Named constants ─────────────────────────────────────────────────────────

const PROMOTED_STATUS = 'promoted'
const RUN_FETCH_LIMIT = 5000  // hard cap to keep one invocation bounded

// ── Query helpers (explicit columns only — per Senior Dev Expectations) ────

async function listPromotedRuns(projectId?: string): Promise<
  Array<{ id: string; project_id: string; promoted_at: string | null }>
> {
  const query = supabase
    .from('extraction_runs')
    .select('id, project_id, promoted_at')
    .eq('status', PROMOTED_STATUS)
    .order('promoted_at', { ascending: false })
    .limit(RUN_FETCH_LIMIT)

  const { data, error } = projectId ? await query.eq('project_id', projectId) : await query

  if (error) {
    throw new Error(`Failed to list promoted runs: ${error.message}`)
  }
  return data ?? []
}

async function projectName(projectId: string): Promise<string> {
  const { data, error } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .maybeSingle()
  if (error || !data) return projectId
  return `${data.name} (${projectId})`
}

// ── Report formatting ───────────────────────────────────────────────────────

function groupViolationsByRule(
  reports: ReadonlyArray<InvariantReport>,
): Map<string, InvariantViolation[]> {
  const grouped = new Map<string, InvariantViolation[]>()
  for (const r of reports) {
    for (const v of r.violations) {
      const bucket = grouped.get(v.rule) ?? []
      bucket.push(v)
      grouped.set(v.rule, bucket)
    }
  }
  return grouped
}

function printHumanReport(
  reports: ReadonlyArray<InvariantReport>,
  elapsedMs: number,
): void {
  const totalBlockers = reports.reduce((s, r) => s + r.blockers, 0)
  const totalWarnings = reports.reduce((s, r) => s + r.warnings, 0)
  const totalOpenings = reports.reduce((s, r) => s + r.checkedOpenings, 0)
  const totalItems = reports.reduce((s, r) => s + r.checkedItems, 0)

  console.log('═══════════════════════════════════════════════')
  console.log('  Extraction Invariants Audit Report')
  console.log('═══════════════════════════════════════════════')
  console.log(`Runs scanned:         ${reports.length}`)
  console.log(`Openings audited:     ${totalOpenings}`)
  console.log(`Hardware items:       ${totalItems}`)
  console.log(`Elapsed:              ${(elapsedMs / 1000).toFixed(1)}s`)
  console.log('')
  console.log(`Total blockers:       ${totalBlockers}`)
  console.log(`Total warnings:       ${totalWarnings}`)
  console.log('')

  const grouped = groupViolationsByRule(reports)
  if (grouped.size === 0) {
    console.log('No violations found. All promoted runs satisfy the invariants.')
    return
  }

  // Sort rules so blockers come first, then by violation count descending.
  const severityRank = (rule: string): number => {
    const sample = grouped.get(rule)?.[0]
    return sample?.severity === 'blocker' ? 0 : 1
  }
  const sortedRules = Array.from(grouped.keys()).sort((a, b) => {
    const sev = severityRank(a) - severityRank(b)
    if (sev !== 0) return sev
    return (grouped.get(b)?.length ?? 0) - (grouped.get(a)?.length ?? 0)
  })

  for (const rule of sortedRules) {
    const violations = grouped.get(rule) ?? []
    const severity = violations[0]?.severity ?? 'warning'
    console.log('───────────────────────────────────────────────')
    console.log(`Rule: ${rule}  [${severity}]  count=${violations.length}`)
    console.log('───────────────────────────────────────────────')
    const toShow = verbose ? violations : violations.slice(0, 10)
    for (const v of toShow) {
      console.log(`  • door=${v.door_number ?? '?'} opening=${v.opening_id ?? '?'}`)
      console.log(`    ${v.details}`)
    }
    if (!verbose && violations.length > toShow.length) {
      console.log(`  … ${violations.length - toShow.length} more (pass --verbose to show all)`)
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = Date.now()

  const runs = await listPromotedRuns(projectIdArg ?? undefined)
  if (runs.length === 0) {
    console.log(projectIdArg
      ? `No promoted runs found for project ${await projectName(projectIdArg)}.`
      : 'No promoted runs found across any project.')
    process.exit(0)
  }

  if (!jsonOutput) {
    const scope = projectIdArg ? await projectName(projectIdArg) : 'ALL projects'
    console.log(`Auditing ${runs.length} promoted run(s) in ${scope}…`)
  }

  const reports: InvariantReport[] = []
  for (const run of runs) {
    try {
      const report = await validateExtractionRun(run.id, supabase)
      reports.push(report)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`  [!] run=${run.id} failed: ${message}`)
    }
  }

  const elapsedMs = Date.now() - startedAt

  if (jsonOutput) {
    process.stdout.write(JSON.stringify({ reports, elapsedMs }, null, 2) + '\n')
  } else {
    printHumanReport(reports, elapsedMs)
  }

  const totalBlockers = reports.reduce((s, r) => s + r.blockers, 0)
  process.exit(totalBlockers > 0 ? 1 : 0)
}

main().catch(err => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err)
  console.error('Fatal error during audit:\n', message)
  process.exit(2)
})
