/**
 * POST /api/projects/[projectId]/punch-notes/summarize
 *
 * Regenerates the project-level punch-notes summary. Two-phase:
 *
 *   Phase A — refresh stale opening summaries
 *     For each opening that has notes AND (no summary yet OR summary is
 *     marked stale), regenerate via summarizeOpeningNotes(). This is what
 *     makes the project rollup synthesizable from a manageable input — we
 *     can't realistically pass thousands of raw notes in one prompt, but
 *     we can pass dozens of opening-level summaries.
 *
 *   Phase B — assemble project summary
 *     Pass all current opening summaries (now fresh) plus the project-scope
 *     notes through summarizeProjectPunchNotes(). Move existing project
 *     summary into _previous slot, write new one, clear stale.
 *
 * Concurrency: same 5-second debounce as the per-opening route.
 *
 * Errors in Phase A are non-fatal — if one opening's summarization fails,
 * we log and continue with whatever opening summaries we already have. The
 * whole project summary failing for one bad opening would be a bad UX.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { logActivity } from '@/lib/activity-log'
import { ACTIVITY_ACTIONS } from '@/lib/constants/activity-actions'
import {
  summarizeOpeningNotes,
  summarizeProjectPunchNotes,
} from '@/lib/ai/notes-summarizer'
import { classifyDarrinInfrastructureError } from '@/lib/parse-pdf-helpers'
import { fetchProjectNotes } from '@/lib/notes/queries'
import type { Note } from '@/lib/types/notes'

const DEBOUNCE_MS = 5_000

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authErr } = await supabase.auth.getUser()
    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId } = await params

    // Read project + current summary state in one round-trip.
    const { data: projectState, error: projErr } = await supabase
      .from('projects')
      .select('name, punch_notes_ai_summary, punch_notes_ai_summary_previous, punch_notes_ai_summary_at, punch_notes_ai_summary_stale')
      .eq('id', projectId)
      .single()

    if (projErr) {
      if (projErr.code === 'PGRST116') {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 })
      }
      console.error('[projects/punch-notes/summarize] project read failed:', projErr.message)
      return NextResponse.json({ error: 'Failed to read project' }, { status: 500 })
    }

    // Debounce against rapid double-fires.
    if (projectState.punch_notes_ai_summary && projectState.punch_notes_ai_summary_at) {
      const ageMs = Date.now() - new Date(projectState.punch_notes_ai_summary_at).getTime()
      if (ageMs < DEBOUNCE_MS) {
        return NextResponse.json({
          summary: projectState.punch_notes_ai_summary,
          debounced: true,
          stale: projectState.punch_notes_ai_summary_stale,
        })
      }
    }

    // Pull every note in the project (one round-trip + label lookups).
    const bundle = await fetchProjectNotes(supabase, projectId)
    if (bundle.notes.length === 0) {
      // No notes anywhere → no summary. Clear any existing and exit.
      await supabase
        .from('projects')
        .update({
          punch_notes_ai_summary: null,
          punch_notes_ai_summary_previous: projectState.punch_notes_ai_summary,
          punch_notes_ai_summary_at: new Date().toISOString(),
          punch_notes_ai_summary_stale: false,
        })
        .eq('id', projectId)
      return NextResponse.json({
        summary: '',
        previous: projectState.punch_notes_ai_summary,
        generated_at: new Date().toISOString(),
        empty: true,
      })
    }

    // ── Phase A: refresh stale opening summaries ───────────────────────
    //
    // Find every opening with at least one item/leaf/opening-scope note,
    // pull its current summary state, regenerate where stale or missing.

    // Group notes by opening; project-scope notes (no opening_id) go to
    // the project rollup at the end.
    const openingScopeNotes: Map<string, Note[]> = new Map()
    const projectScopeNotes: Note[] = []
    for (const n of bundle.notes) {
      if (n.scope === 'project') {
        projectScopeNotes.push(n)
      } else if (n.opening_id) {
        const arr = openingScopeNotes.get(n.opening_id) ?? []
        arr.push(n)
        openingScopeNotes.set(n.opening_id, arr)
      }
    }

    const openingIds = Array.from(openingScopeNotes.keys())
    let openingSummaries: Array<{ door_number: string; summary: string }> = []

    if (openingIds.length > 0) {
      const { data: openingRows, error: openingErr } = await supabase
        .from('openings')
        .select('id, door_number, notes_ai_summary, notes_ai_summary_stale')
        .in('id', openingIds)

      if (openingErr) {
        console.error('[projects/punch-notes/summarize] openings read failed:', openingErr.message)
        return NextResponse.json({ error: 'Failed to read opening summaries' }, { status: 500 })
      }
      const byId = new Map((openingRows ?? []).map(r => [r.id, r]))

      // Sequential regeneration to keep token usage observable and avoid
      // hammering Anthropic with parallel requests during a single
      // promotion. For projects with hundreds of stale summaries this
      // could be slow — fine for v1, can parallelize later if needed.
      for (const openingId of openingIds) {
        const row = byId.get(openingId)
        if (!row) continue

        const needsRegen = !row.notes_ai_summary || row.notes_ai_summary_stale === true
        if (!needsRegen) {
          // notes_ai_summary is non-null here per the !needsRegen check above.
          openingSummaries.push({ door_number: row.door_number, summary: row.notes_ai_summary! })
          continue
        }

        const notesForOpening = openingScopeNotes.get(openingId) ?? []
        try {
          const result = await summarizeOpeningNotes(
            row.door_number,
            notesForOpening,
            bundle.itemNames,
          )
          // Persist the refreshed opening summary.
          await supabase
            .from('openings')
            .update({
              notes_ai_summary: result.summary,
              notes_ai_summary_previous: row.notes_ai_summary,
              notes_ai_summary_at: new Date().toISOString(),
              notes_ai_summary_stale: false,
            })
            .eq('id', openingId)
          openingSummaries.push({ door_number: row.door_number, summary: result.summary })
        } catch (err) {
          // Per the design comment above: don't fail the whole project
          // summary because one opening's regen failed. Log + skip.
          const message = err instanceof Error ? err.message : String(err)
          console.error(
            `[projects/punch-notes/summarize] opening ${row.door_number} regen failed:`,
            message,
          )
          // If we have a stale-but-non-null prior, use it; otherwise skip.
          if (row.notes_ai_summary) {
            openingSummaries.push({ door_number: row.door_number, summary: row.notes_ai_summary })
          }
        }
      }

      // Natural sort by door_number so the prompt has a stable ordering
      // across runs (matches the page UI's natural sort).
      const collator = new Intl.Collator(undefined, { numeric: true })
      openingSummaries = openingSummaries.sort((a, b) => collator.compare(a.door_number, b.door_number))
    }

    // ── Phase B: assemble project summary ─────────────────────────────
    let result
    try {
      result = await summarizeProjectPunchNotes(
        projectState.name,
        openingSummaries,
        projectScopeNotes,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const category = classifyDarrinInfrastructureError(message)
      console.error(
        `[projects/punch-notes/summarize] project summarizer failed (${category ?? 'unknown'}):`,
        message,
      )
      return NextResponse.json(
        {
          error: friendlyInfraError(category) ?? 'Failed to generate project summary',
          category,
        },
        { status: category ? 503 : 500 },
      )
    }

    // Persist project-level summary: previous ← current, current ← new.
    const { error: updateErr } = await supabase
      .from('projects')
      .update({
        punch_notes_ai_summary: result.summary,
        punch_notes_ai_summary_previous: projectState.punch_notes_ai_summary,
        punch_notes_ai_summary_at: new Date().toISOString(),
        punch_notes_ai_summary_stale: false,
      })
      .eq('id', projectId)

    if (updateErr) {
      console.error('[projects/punch-notes/summarize] update failed:', updateErr.message)
      return NextResponse.json({ error: 'Failed to save summary' }, { status: 500 })
    }

    void logActivity({
      projectId,
      userId: user.id,
      action: ACTIVITY_ACTIONS.PUNCH_NOTES_SUMMARIZED,
      entityType: 'project',
      entityId: projectId,
      details: {
        scope: 'project',
        openings_summarized: openingSummaries.length,
        project_scope_notes: projectScopeNotes.length,
        input_tokens: result.tokenUsage.input_tokens,
        output_tokens: result.tokenUsage.output_tokens,
      },
    })

    return NextResponse.json({
      summary: result.summary,
      previous: projectState.punch_notes_ai_summary,
      generated_at: new Date().toISOString(),
      openings_summarized: openingSummaries.length,
      project_scope_notes: projectScopeNotes.length,
      token_usage: result.tokenUsage,
    })
  } catch (err) {
    console.error('[projects/punch-notes/summarize] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

function friendlyInfraError(category: string | null): string | null {
  switch (category) {
    case 'credit_balance':
      return 'AI summarization is temporarily unavailable (billing). The team has been notified.'
    case 'rate_limit':
      return 'AI summarization is rate-limited right now. Please try again in a minute.'
    case 'context_length':
      return 'There are too many notes in this project for a single summary. Try summarizing individual openings first.'
    case 'auth':
      return 'AI summarization is temporarily unavailable (auth). The team has been notified.'
    default:
      return null
  }
}
