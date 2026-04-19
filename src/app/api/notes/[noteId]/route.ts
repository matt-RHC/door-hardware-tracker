import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { logActivity } from '@/lib/activity-log'
import { ACTIVITY_ACTIONS } from '@/lib/constants/activity-actions'
import type { Note, NoteDisplayMode, UpdateNoteInput } from '@/lib/types/notes'

const VALID_DISPLAY_MODES: ReadonlySet<NoteDisplayMode> = new Set(['original', 'ai'])
const MAX_TEXT_LENGTH = 10_000

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * PATCH /api/notes/[noteId]
 *
 * Edit a note's text or display mode. The user must be a project member —
 * RLS enforces; we surface a clean 403 if it denies.
 *
 * v1 only `original_text` is exercised by the UI. `ai_text` and
 * `display_mode` are accepted but unused until v2 ships per-note AI cleanup.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ noteId: string }> },
) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authErr } = await supabase.auth.getUser()
    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { noteId } = await params
    const body = (await request.json()) as UpdateNoteInput

    const updates: Record<string, unknown> = {}
    if (body.original_text !== undefined) {
      if (typeof body.original_text !== 'string' || body.original_text.trim().length === 0) {
        return badRequest('original_text must be a non-empty string')
      }
      if (body.original_text.length > MAX_TEXT_LENGTH) {
        return badRequest(`original_text exceeds ${MAX_TEXT_LENGTH} chars`)
      }
      updates.original_text = body.original_text.trim()
    }
    if (body.ai_text !== undefined) {
      // Accept null to clear, or a non-empty string.
      if (body.ai_text !== null && (typeof body.ai_text !== 'string' || body.ai_text.length > MAX_TEXT_LENGTH)) {
        return badRequest('ai_text must be null or a string under the length cap')
      }
      updates.ai_text = body.ai_text
    }
    if (body.display_mode !== undefined) {
      if (!VALID_DISPLAY_MODES.has(body.display_mode)) {
        return badRequest('display_mode must be original or ai')
      }
      updates.display_mode = body.display_mode
    }

    if (Object.keys(updates).length === 0) {
      return badRequest('no editable fields supplied')
    }

    // Guard: display_mode='ai' requires ai_text to be present (in this PATCH
    // or already on the row). Without this an empty 'ai' render slips through.
    // v2 will add a CHECK constraint at the table level when AI ships; for
    // v1 the API guard is sufficient and avoids an extra round-trip in the
    // common path. See migration 051 + PR #336.
    if (updates.display_mode === 'ai') {
      const incomingAiText = updates.ai_text as string | null | undefined
      if (typeof incomingAiText !== 'string' || incomingAiText.length === 0) {
        // Need to check the persisted row — only block if THIS patch isn't
        // setting ai_text AND the row doesn't already have it.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: existing, error: readErr } = await (supabase.from('notes' as never) as any)
          .select('ai_text')
          .eq('id', noteId)
          .single()
        if (readErr) {
          if (readErr.code === 'PGRST116') {
            return NextResponse.json({ error: 'Note not found' }, { status: 404 })
          }
          console.error('[notes PATCH] ai_text precheck failed:', readErr.message)
          return NextResponse.json({ error: 'Failed to update note' }, { status: 500 })
        }
        const persistedAiText = (existing as { ai_text: string | null }).ai_text
        const incomingClearsAi = incomingAiText === null
        if (incomingClearsAi || !persistedAiText) {
          return badRequest("display_mode='ai' requires ai_text to be set")
        }
      }
    }

    // `notes` table cast — same pattern as darrin_logs until types are regenerated.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.from('notes' as never) as any)
      .update(updates)
      .eq('id', noteId)
      .select('*')
      .single()

    if (error) {
      // PGRST116 = "no rows" (could be wrong id OR RLS-filtered)
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Note not found' }, { status: 404 })
      }
      console.error('[notes PATCH] update failed:', error.message)
      return NextResponse.json({ error: 'Failed to update note' }, { status: 500 })
    }

    const updated = data as Note
    void logActivity({
      projectId: updated.project_id,
      userId: user.id,
      action: ACTIVITY_ACTIONS.NOTE_UPDATED,
      entityType: 'note',
      entityId: updated.id,
      details: { fields: Object.keys(updates) },
    })

    return NextResponse.json({ note: updated })
  } catch (err) {
    console.error('[notes PATCH] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/notes/[noteId]
 *
 * Hard delete. Trigger fires and marks parent summary stale.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ noteId: string }> },
) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authErr } = await supabase.auth.getUser()
    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { noteId } = await params

    // Read first so we can log the project_id + scope for audit.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing, error: readErr } = await (supabase.from('notes' as never) as any)
      .select('project_id, scope, opening_id, hardware_item_id')
      .eq('id', noteId)
      .single()

    if (readErr) {
      if (readErr.code === 'PGRST116') {
        return NextResponse.json({ error: 'Note not found' }, { status: 404 })
      }
      console.error('[notes DELETE] read failed:', readErr.message)
      return NextResponse.json({ error: 'Failed to read note' }, { status: 500 })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: delErr } = await (supabase.from('notes' as never) as any).delete().eq('id', noteId)
    if (delErr) {
      console.error('[notes DELETE] delete failed:', delErr.message)
      return NextResponse.json({ error: 'Failed to delete note' }, { status: 500 })
    }

    const row = existing as { project_id: string; scope: string; opening_id: string | null; hardware_item_id: string | null }
    void logActivity({
      projectId: row.project_id,
      userId: user.id,
      action: ACTIVITY_ACTIONS.NOTE_DELETED,
      entityType: 'note',
      entityId: noteId,
      details: { scope: row.scope, opening_id: row.opening_id, hardware_item_id: row.hardware_item_id },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[notes DELETE] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
