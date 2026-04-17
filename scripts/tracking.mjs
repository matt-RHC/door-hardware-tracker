#!/usr/bin/env node

// Tracking CLI — read/write tracking_items from a Claude Code session.
//
// Requires .env.local with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
// Run via: npm run tracking -- <command> [options]
//
// Commands:
//   list          Show items (--type plan_item|session|metric_run, --status, --limit)
//   add-item      Add a plan item (--title, --priority, --category, --area, --description)
//   update-item   Update a plan item by ID (first arg = UUID, then --status, --resolved-pr, etc.)
//   add-session   Log a session row (--session-id, --topics, --decisions, --status)
//   add-metric    Log a metric run (--session-id, --pdf, --doors-exp, --doors-ext, etc.)

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  console.error(
    'Missing environment variables. Ensure .env.local contains:\n' +
    '  NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co\n' +
    '  SUPABASE_SERVICE_ROLE_KEY=eyJ...\n\n' +
    'Run with: npm run tracking -- <command>'
  )
  process.exit(1)
}

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ── Arg parsing ──────────────────────────────────────────────
const args = process.argv.slice(2)
const cmd = args[0]

function arg(name) {
  const idx = args.indexOf(`--${name}`)
  if (idx === -1 || idx + 1 >= args.length) return null
  return args[idx + 1]
}

function argInt(name) {
  const v = arg(name)
  if (v === null) return null
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : null
}

function argFloat(name) {
  const v = arg(name)
  if (v === null) return null
  const n = Number.parseFloat(v)
  return Number.isFinite(n) ? n : null
}

// ── Commands ─────────────────────────────────────────────────

async function list() {
  const type = arg('type')
  const status = arg('status')
  const limit = argInt('limit') ?? 200

  let query = supabase
    .from('tracking_items')
    .select('*')
    .order('priority', { ascending: true })
    .order('date_identified', { ascending: false, nullsFirst: false })
    .limit(limit)

  if (type) query = query.eq('record_type', type)
  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) { console.error('Query failed:', error.message); process.exit(1) }

  const items = data ?? []
  if (items.length === 0) {
    console.log(`No items found${type ? ` for type=${type}` : ''}${status ? ` status=${status}` : ''}.`)
    return
  }

  // Group by record_type then by priority
  const groups = {}
  for (const item of items) {
    const rt = item.record_type
    if (!groups[rt]) groups[rt] = []
    groups[rt].push(item)
  }

  for (const [rt, rtItems] of Object.entries(groups)) {
    const label = rt === 'plan_item' ? 'Plan Items' : rt === 'session' ? 'Sessions' : 'Metric Runs'
    console.log(`\n## ${label} — ${rtItems.length} total\n`)

    if (rt === 'plan_item') {
      const byPriority = {}
      for (const item of rtItems) {
        const p = item.priority ?? 'Unset'
        if (!byPriority[p]) byPriority[p] = []
        byPriority[p].push(item)
      }
      for (const [priority, pItems] of Object.entries(byPriority)) {
        console.log(`### ${priority} (${pItems.length})`)
        for (const item of pItems) {
          const pr = item.resolved_pr ? ` PR#${item.resolved_pr}` : ''
          console.log(`- [${item.id.slice(0, 8)}] ${item.title} [${item.area ?? '?'}] (${item.status ?? '?'})${pr}`)
        }
        console.log()
      }
    } else if (rt === 'session') {
      for (const item of rtItems) {
        const refs = (item.session_refs ?? []).join(', ') || item.title
        console.log(`- [${item.id.slice(0, 8)}] ${refs} — ${item.date_identified ?? '?'} — ${item.session_status ?? item.status ?? '?'}`)
        if (item.session_topics) console.log(`  Topics: ${item.session_topics}`)
      }
    } else {
      for (const item of rtItems) {
        const doors = `${item.metric_doors_extracted ?? '?'}/${item.metric_doors_expected ?? '?'}`
        const sets = `${item.metric_sets_extracted ?? '?'}/${item.metric_sets_expected ?? '?'}`
        const acc = item.metric_accuracy_pct !== null ? `${item.metric_accuracy_pct}%` : '?'
        console.log(`- [${item.id.slice(0, 8)}] ${item.title} — doors ${doors}, sets ${sets}, acc ${acc}`)
      }
    }
  }
}

async function addItem() {
  const title = arg('title')
  if (!title) { console.error('--title is required'); process.exit(1) }

  const row = {
    record_type: 'plan_item',
    title,
    status: arg('status') ?? 'Open',
    priority: arg('priority') ?? 'P2 - Medium',
    category: arg('category'),
    area: arg('area'),
    description: arg('description'),
    relevance: 'current',
    date_identified: new Date().toISOString().slice(0, 10),
  }

  const { data, error } = await supabase.from('tracking_items').insert(row).select('id').single()
  if (error) { console.error('Insert failed:', error.message); process.exit(1) }
  console.log(`Added plan item: ${data.id}`)
  console.log(`  Title: ${title}`)
  console.log(`  Priority: ${row.priority}`)
}

async function updateItem() {
  const id = args[1]
  if (!id) { console.error('Usage: update-item <uuid> --status Done [--resolved-pr N]'); process.exit(1) }

  const updates = {}
  const statusVal = arg('status')
  const resolvedPr = argInt('resolved-pr')
  const resolvedCommit = arg('resolved-commit')
  const relevance = arg('relevance')
  const notes = arg('notes')

  if (statusVal) updates.status = statusVal
  if (resolvedPr !== null) updates.resolved_pr = resolvedPr
  if (resolvedCommit) updates.resolved_commit = resolvedCommit
  if (relevance) updates.relevance = relevance
  if (notes) updates.notes = notes
  if (statusVal === 'Done' && !updates.date_resolved) {
    updates.date_resolved = new Date().toISOString().slice(0, 10)
  }
  updates.last_verified_at = new Date().toISOString()

  if (Object.keys(updates).length <= 1) {
    console.error('No update fields provided. Use --status, --resolved-pr, --relevance, --notes.')
    process.exit(1)
  }

  const { error } = await supabase.from('tracking_items').update(updates).eq('id', id)
  if (error) { console.error('Update failed:', error.message); process.exit(1) }
  console.log(`Updated ${id}:`, JSON.stringify(updates, null, 2))
}

async function addSession() {
  const sessionId = arg('session-id')
  if (!sessionId) { console.error('--session-id is required (e.g. S-087)'); process.exit(1) }

  const row = {
    record_type: 'session',
    title: sessionId,
    status: arg('status') ?? 'complete',
    session_refs: [sessionId.toUpperCase()],
    session_topics: arg('topics'),
    session_decisions: arg('decisions'),
    session_status: arg('status') ?? 'complete',
    notes: arg('notes'),
    date_identified: new Date().toISOString().slice(0, 10),
    relevance: 'current',
  }

  const { data, error } = await supabase.from('tracking_items').insert(row).select('id').single()
  if (error) { console.error('Insert failed:', error.message); process.exit(1) }
  console.log(`Logged session: ${data.id}`)
  console.log(`  Session: ${sessionId}`)
  console.log(`  Topics: ${row.session_topics ?? '(none)'}`)
}

async function addMetric() {
  const sessionId = arg('session-id')
  const pdf = arg('pdf')
  if (!sessionId || !pdf) {
    console.error('--session-id and --pdf are required')
    process.exit(1)
  }

  const row = {
    record_type: 'metric_run',
    title: `${sessionId} — ${pdf}`,
    session_refs: [sessionId.toUpperCase()],
    metric_pdf_name: pdf,
    metric_doors_expected: argInt('doors-exp'),
    metric_doors_extracted: argInt('doors-ext'),
    metric_sets_expected: argInt('sets-exp'),
    metric_sets_extracted: argInt('sets-ext'),
    metric_accuracy_pct: argFloat('accuracy'),
    metric_duration_ms: argInt('duration'),
    metric_build_commit: arg('commit'),
    notes: arg('notes'),
    date_identified: new Date().toISOString().slice(0, 10),
    relevance: 'current',
  }

  const { data, error } = await supabase.from('tracking_items').insert(row).select('id').single()
  if (error) { console.error('Insert failed:', error.message); process.exit(1) }
  console.log(`Logged metric run: ${data.id}`)
  console.log(`  ${sessionId} — ${pdf}`)
  console.log(`  Doors: ${row.metric_doors_extracted ?? '?'}/${row.metric_doors_expected ?? '?'}`)
}

// ── Dispatch ─────────────────────────────────────────────────

switch (cmd) {
  case 'list':          await list(); break
  case 'add-item':      await addItem(); break
  case 'update-item':   await updateItem(); break
  case 'add-session':   await addSession(); break
  case 'add-metric':    await addMetric(); break
  default:
    console.error(
      'Usage: npm run tracking -- <command> [options]\n\n' +
      'Commands:\n' +
      '  list          Show items (--type, --status, --limit)\n' +
      '  add-item      Add plan item (--title, --priority, --category, --area, --description)\n' +
      '  update-item   Update item (UUID --status --resolved-pr --relevance --notes)\n' +
      '  add-session   Log session (--session-id --topics --decisions --status)\n' +
      '  add-metric    Log metric run (--session-id --pdf --doors-exp --doors-ext ...)\n'
    )
    process.exit(cmd ? 1 : 0)
}
