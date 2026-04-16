#!/usr/bin/env node

// Backfill helper: normalize legacy `issue-evidence` storage paths.
//
// PR #277 introduced project+company storage RLS for the issue-evidence
// bucket (migration 043). The new policy expects every object's first
// path segment to be a project UUID. Pre-existing objects that were
// uploaded under the old layouts:
//
//   issue-evidence/<project_id>/<issue_id>/<file>   (voice)
//   issues/<project_id>/<issue_id>/<file>           (attachments)
//
// will fail the (storage.foldername(name))[1]::uuid cast and be silently
// inaccessible. Migration 043 refuses to apply when any such object
// exists; run this script first to rename them to:
//
//   <project_id>/<issue_id>/<file>
//
// What it does:
//   1. Lists every storage.objects row in bucket=issue-evidence whose
//      first path segment is NOT a UUID.
//   2. Computes the normalized path (strips the literal prefix).
//   3. (real run) Downloads each object, re-uploads at the new path,
//      updates the matching public.issue_attachments.storage_path row,
//      then deletes the legacy object. (dry run) Prints would-be
//      renames + counts and exits without touching anything.
//
// Usage:
//   node scripts/migrate-issue-evidence-paths.mjs --dry-run    # safe preview
//   node scripts/migrate-issue-evidence-paths.mjs              # perform migration
//
// Requires .env.local with NEXT_PUBLIC_SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY (uses the service role; bypasses RLS so it
// can read every object regardless of company).

import { createClient } from '@supabase/supabase-js'

const BUCKET = 'issue-evidence'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error(
    'Missing env. Source .env.local (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).',
  )
  process.exit(1)
}

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
})

/**
 * Recursively list every object name under a prefix in the given bucket.
 * Supabase's storage.list returns 100 items per call by default; we
 * page until empty. Folder rows (id == null) get descended into.
 */
async function listAll(prefix = '') {
  const out = []
  const limit = 1000
  let offset = 0
  while (true) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(prefix, { limit, offset, sortBy: { column: 'name', order: 'asc' } })
    if (error) throw error
    if (!data || data.length === 0) break
    for (const entry of data) {
      const fullName = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.id === null) {
        // Folder — recurse.
        out.push(...(await listAll(fullName)))
      } else {
        out.push(fullName)
      }
    }
    if (data.length < limit) break
    offset += data.length
  }
  return out
}

/**
 * Strip the legacy literal prefix. Returns null if the object is
 * already in the new layout (segment 1 is a UUID).
 */
function normalize(name) {
  const segs = name.split('/')
  if (segs.length < 3) return null
  if (UUID_RE.test(segs[0])) return null
  // Old voice layout: issue-evidence/<project>/<issue>/<file...>
  // Old attachments layout: issues/<project>/<issue>/<file...>
  if (segs[0] === 'issue-evidence' || segs[0] === 'issues') {
    return segs.slice(1).join('/')
  }
  // Unknown prefix — leave it alone. Will trip the migration assertion
  // and the operator can decide.
  return null
}

async function main() {
  console.log(`[issue-evidence backfill] mode=${dryRun ? 'dry-run' : 'EXECUTE'}`)

  const all = await listAll('')
  const work = []
  for (const oldName of all) {
    const newName = normalize(oldName)
    if (!newName) continue
    work.push({ oldName, newName })
  }

  console.log(`[issue-evidence backfill] scanned=${all.length} legacy=${work.length}`)
  if (work.length === 0) {
    console.log('[issue-evidence backfill] nothing to do.')
    return
  }

  if (dryRun) {
    for (const { oldName, newName } of work.slice(0, 50)) {
      console.log(`  would-rename  ${oldName}  ->  ${newName}`)
    }
    if (work.length > 50) console.log(`  …and ${work.length - 50} more.`)
    console.log('[issue-evidence backfill] dry-run complete; no changes made.')
    return
  }

  let renamed = 0
  let dbUpdated = 0
  let failed = 0

  for (const { oldName, newName } of work) {
    try {
      // 1. Download legacy.
      const { data: blob, error: dlErr } = await supabase.storage
        .from(BUCKET)
        .download(oldName)
      if (dlErr || !blob) throw dlErr ?? new Error('download returned no data')

      // 2. Upload to new path. upsert:true so reruns are idempotent.
      const buf = await blob.arrayBuffer()
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(newName, buf, { contentType: blob.type || 'application/octet-stream', upsert: true })
      if (upErr) throw upErr

      // 3. Re-point any issue_attachments row that used the old path.
      const { error: rowErr, count } = await supabase
        .from('issue_attachments')
        .update({ storage_path: newName }, { count: 'exact' })
        .eq('storage_path', oldName)
      if (rowErr) throw rowErr
      dbUpdated += count ?? 0

      // 4. Delete legacy object only after the new one is in place.
      const { error: rmErr } = await supabase.storage.from(BUCKET).remove([oldName])
      if (rmErr) throw rmErr

      renamed += 1
      if (renamed % 25 === 0) {
        console.log(`  …${renamed}/${work.length} renamed (${dbUpdated} DB rows updated)`)
      }
    } catch (err) {
      failed += 1
      console.error(`  FAIL  ${oldName}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(
    `[issue-evidence backfill] done. renamed=${renamed} db_rows_updated=${dbUpdated} failed=${failed}`,
  )
  if (failed > 0) process.exit(2)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
