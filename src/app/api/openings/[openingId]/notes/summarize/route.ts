/**
 * POST /api/openings/[openingId]/notes/summarize
 *
 * Regenerates the AI summary for a single opening:
 *   1. Fetch every note bound to this opening (item + leaf + opening scope).
 *   2. Call summarizeOpeningNotes() against Anthropic.
 *   3. Move the existing notes_ai_summary into notes_ai_summary_previous,
 *      write the new value, stamp notes_ai_summary_at, clear the stale flag.
 *   4. Log a PUNCH_NOTES_SUMMARIZED activity entry.
 *
 * Concurrency: a 5-second debounce on notes_ai_summary_at protects against
 * two users hitting "Regenerate" simultaneously and double-spending tokens.
 * If the summary was just refreshed within the window, returns the existing
 * one with a 'debounced' flag rather than regenerating.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { logActivity } from '@/lib/activity-log'
import { ACTIVITY_ACTIONS } from '@/lib/constants/activity-actions'
import { summarizeOpeningNotes } from '@/lib/ai/notes-summarizer'
import { classifyDarrinInfrastructureError } from '@/lib/parse-pdf-helpers'
import type { Note } from '@/lib/types/notes'

const DEBOUNCE_MS = 5_000

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ openingId: string }> },
) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authErr } = await supabase.auth.getUser()
    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { openingId } = await params

    // Read opening + current summary state. RLS gates membership.
    const { data: opening, error: openingErr } = await supabase
      .from('openings')
      .select('id, project_id, door_number')
      .eq('id', openingId)
      .single()

    if (openingErr || !opening) {
      return NextResponse.json({ error: 'Opening not found' }, { status: 404 })
    }
    const openingRow = opening as { id: string; project_id: string; door_number: string }

    // notes_ai_summary columns were added by migration 051; database.ts isn't
    // regenerated for them. Same `as never as any` pattern used elsewhere.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: summaryRow, error: summaryErr } = await (supabase.from('openings' as never) as any)
      .select('notes_ai_summary, notes_ai_summary_previous, notes_ai_summary_at, notes_ai_summary_stale')
      .eq('id', openingId)
      .single()

    if (summaryErr) {
      console.error('[openings/notes/summarize] summary read failed:', summaryErr.message)
      return NextResponse.json({ error: 'Failed to read existing summary' }, { status: 500 })
    }
    const summaryState = summaryRow as {
      notes_ai_summary: string | null
      notes_ai_summary_previous: string | null
      notes_ai_summary_at: string | null
      notes_ai_summary_stale: boolean | null
    }

    // Debounce: if a summary was written within the last DEBOUNCE_MS, return
    // it as-is rather than spending tokens to regenerate. Two foremen hitting
    // Regenerate at the same time should not double-charge the project.
    if (summaryState.notes_ai_summary && summaryState.notes_ai_summary_at) {
      const ageMs = Date.now() - new Date(summaryState.notes_ai_summary_at).getTime()
      if (ageMs < DEBOUNCE_MS) {
        return NextResponse.json({
          summary: summaryState.notes_ai_summary,
          debounced: true,
          stale: summaryState.notes_ai_summary_stale ?? false,
        })
      }
    }

    // Fetch every note bound to this opening. opening_id filter covers item
    // (which carries opening_id), leaf (also carries opening_id), and
    // opening (the row itself) scopes — exactly what the summarizer wants.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: notesRows, error: notesErr } = await (supabase.from('notes' as never) as any)
      .select('*')
      .eq('opening_id', openingId)
      .order('created_at', { ascending: true })

    if (notesErr) {
      console.error('[openings/notes/summarize] notes fetch failed:', notesErr.message)
      return NextResponse.json({ error: 'Failed to fetch notes' }, { status: 500 })
    }
    const notes = (notesRows ?? []) as Note[]

    // Resolve item names for the prompt builder. Single round-trip; only
    // item-scope notes contribute ids.
    const itemIds = Array.from(
      new Set(notes
        .filter(n => n.scope === 'item' && n.hardware_item_id)
        .map(n => n.hardware_item_id as string),
      ),
    )
    const itemNames: Record<string, string | null> = {}
    if (itemIds.length > 0) {
      const { data: itemsRows, error: itemsErr } = await supabase
        .from('hardware_items')
        .select('id, name')
        .in('id', itemIds)
      if (itemsErr) {
        console.error('[openings/notes/summarize] items fetch failed:', itemsErr.message)
        return NextResponse.json({ error: 'Failed to resolve item labels' }, { status: 500 })
      }
      for (const i of (itemsRows ?? []) as Array<{ id: string; name: string | null }>) {
        itemNames[i.id] = i.name ?? null
      }
    }

    // Call the summarizer. Throws on infra errors (already captured to Sentry
    // inside the summarizer); we surface a friendly message keyed on the
    // category if we recognize it.
    let result
    try {
      result = await summarizeOpeningNotes(openingRow.door_number, notes, itemNames)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const category = classifyDarrinInfrastructureError(message)
      console.error(`[openings/notes/summarize] summarizer failed (${category ?? 'unknown'}):`, message)
      return NextResponse.json(
        {
          error: friendlyInfraError(category) ?? 'Failed to generate summary',
          category,
        },
        { status: category ? 503 : 500 },
      )
    }

    // Persist: previous ← current, current ← new, timestamp + clear stale.
    // Single UPDATE so the swap is atomic.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: updateErr } = await (supabase.from('openings' as never) as any)
      .update({
        notes_ai_summary: result.summary,
        notes_ai_summary_previous: summaryState.notes_ai_summary,
        notes_ai_summary_at: new Date().toISOString(),
        notes_ai_summary_stale: false,
      })
      .eq('id', openingId)

    if (updateErr) {
      console.error('[openings/notes/summarize] update failed:', updateErr.message)
      return NextResponse.json({ error: 'Failed to save summary' }, { status: 500 })
    }

    void logActivity({
      projectId: openingRow.project_id,
      userId: user.id,
      action: ACTIVITY_ACTIONS.PUNCH_NOTES_SUMMARIZED,
      entityType: 'opening',
      entityId: openingId,
      details: {
        scope: 'opening',
        notes_counted: notes.length,
        input_tokens: result.tokenUsage.input_tokens,
        output_tokens: result.tokenUsage.output_tokens,
      },
    })

    return NextResponse.json({
      summary: result.summary,
      previous: summaryState.notes_ai_summary,
      generated_at: new Date().toISOString(),
      token_usage: result.tokenUsage,
    })
  } catch (err) {
    console.error('[openings/notes/summarize] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/** Map an infra category to a user-facing message. Null → use default. */
function friendlyInfraError(category: string | null): string | null {
  switch (category) {
    case 'credit_balance':
      return 'AI summarization is temporarily unavailable (billing). The team has been notified.'
    case 'rate_limit':
      return 'AI summarization is rate-limited right now. Please try again in a minute.'
    case 'context_length':
      return 'There are too many notes on this opening for a single summary. Consider trimming or splitting before regenerating.'
    case 'auth':
      return 'AI summarization is temporarily unavailable (auth). The team has been notified.'
    default:
      return null
  }
}
