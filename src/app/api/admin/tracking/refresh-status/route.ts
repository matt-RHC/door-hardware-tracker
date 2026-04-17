// POST /api/admin/tracking/refresh-status
//
// Walks local git history to resolve PR references in tracking_items.notes,
// then writes `resolved_pr`, `resolved_commit`, and promotes `status` to Done
// for any plan_item whose referenced PR has been merged.
//
// This route only runs on local dev (it shells out to `git`, which is not
// available in the Vercel build image). It is a maintenance tool, not part of
// the production request path.
//
// Query params:
//   ?dryRun=1  — compute updates but do not write

import { NextRequest, NextResponse } from 'next/server'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import { requireTrackingAdmin } from '@/lib/tracking/constants'
import type { TrackingItem } from '@/lib/types/database'

export const runtime = 'nodejs'
export const maxDuration = 300

const execFileAsync = promisify(execFile)

/**
 * Extract distinct PR numbers referenced in free text. Matches:
 *   PR #42 / PR 42 / #42 / PR-42 / Fixed PR #42 / FIXED PR 42
 * Does NOT match bare digits in unrelated contexts — the `PR` or `#` sigil
 * must be present.
 */
function extractPrNumbers(text: string | null): number[] {
  if (!text) return []
  const pattern = /(?:PR[\s:-]*#?|#)(\d{1,5})/gi
  const seen = new Set<number>()
  for (const match of text.matchAll(pattern)) {
    const n = Number.parseInt(match[1], 10)
    if (Number.isFinite(n) && n > 0 && n < 100000) {
      seen.add(n)
    }
  }
  return [...seen].sort((a, b) => a - b)
}

interface MergedPrInfo {
  pr: number
  commit: string
}

/**
 * Build a map of PR number → merge commit SHA by walking the local git log.
 * GitHub merge commits have messages like:
 *   "Merge pull request #42 from branch/name"
 * Squash-merge commits have trailing "(#42)" in the subject.
 */
async function loadMergedPrs(): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--all', '--format=%H%x09%s', '-n', '5000'],
      { maxBuffer: 32 * 1024 * 1024 },
    )
    const mergeRx = /Merge pull request #(\d+)/
    const squashRx = /\(#(\d+)\)\s*$/
    for (const line of stdout.split('\n')) {
      const tab = line.indexOf('\t')
      if (tab === -1) continue
      const sha = line.slice(0, tab)
      const subject = line.slice(tab + 1)
      const merge = mergeRx.exec(subject)
      if (merge) {
        const pr = Number.parseInt(merge[1], 10)
        if (!map.has(pr)) map.set(pr, sha)
        continue
      }
      const squash = squashRx.exec(subject)
      if (squash) {
        const pr = Number.parseInt(squash[1], 10)
        if (!map.has(pr)) map.set(pr, sha)
      }
    }
  } catch (err) {
    throw new Error(
      `git log failed — this endpoint only works in a local checkout with .git present. Underlying: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  return map
}

interface ItemUpdate {
  id: string
  title: string
  prs_referenced: number[]
  prs_merged: MergedPrInfo[]
  will_set_status_done: boolean
}

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const auth = await requireTrackingAdmin(supabase)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const url = new URL(request.url)
  const dryRun = url.searchParams.get('dryRun') === '1'

  let mergedPrs: Map<number, string>
  try {
    mergedPrs = await loadMergedPrs()
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }

  const admin = createAdminSupabaseClient()
  const { data: planItems, error: readError } = await admin
    .from('tracking_items')
    .select('*')
    .eq('record_type', 'plan_item')

  if (readError) {
    return NextResponse.json({ error: readError.message }, { status: 500 })
  }

  const updates: ItemUpdate[] = []
  for (const itemRow of (planItems ?? []) as TrackingItem[]) {
    // Search both notes and description. Most PR refs are in notes, but a few
    // historical plan rows put the PR in the description field.
    const combinedText = [itemRow.notes, itemRow.description].filter(Boolean).join('\n')
    const referencedPrs = extractPrNumbers(combinedText)
    if (referencedPrs.length === 0) continue

    const mergedForItem: MergedPrInfo[] = []
    for (const pr of referencedPrs) {
      const commit = mergedPrs.get(pr)
      if (commit) mergedForItem.push({ pr, commit })
    }
    if (mergedForItem.length === 0) continue

    const willSetDone = itemRow.status !== 'Done'
    updates.push({
      id: itemRow.id,
      title: itemRow.title,
      prs_referenced: referencedPrs,
      prs_merged: mergedForItem,
      will_set_status_done: willSetDone,
    })
  }

  if (!dryRun) {
    const nowIso = new Date().toISOString()
    for (const update of updates) {
      const highest = update.prs_merged.reduce(
        (a, b) => (a.pr >= b.pr ? a : b),
        update.prs_merged[0],
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (admin as any)
        .from('tracking_items')
        .update({
          resolved_pr: highest.pr,
          resolved_commit: highest.commit,
          status: update.will_set_status_done ? 'Done' : undefined,
          last_verified_at: nowIso,
          code_evidence: {
            prs_referenced: update.prs_referenced,
            prs_merged: update.prs_merged,
            refreshed_at: nowIso,
          },
        })
        .eq('id', update.id)
      if (error) {
        return NextResponse.json(
          {
            error: `Failed to update tracking_item ${update.id}: ${error.message}`,
            updates_applied_before_error: updates.indexOf(update),
          },
          { status: 500 },
        )
      }
    }
  }

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    merged_prs_in_git: mergedPrs.size,
    plan_items_scanned: planItems?.length ?? 0,
    plan_items_with_pr_refs: updates.length,
    plan_items_promoted_to_done: updates.filter(u => u.will_set_status_done).length,
    updates,
  })
}
