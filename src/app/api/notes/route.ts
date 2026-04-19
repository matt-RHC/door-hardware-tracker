import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { logActivity } from '@/lib/activity-log'
import { ACTIVITY_ACTIONS } from '@/lib/constants/activity-actions'
import type { CreateNoteInput, Note, NoteScope, LeafSide } from '@/lib/types/notes'

const VALID_SCOPES: ReadonlySet<NoteScope> = new Set(['project', 'opening', 'leaf', 'item'])
const VALID_LEAF_SIDES: ReadonlySet<LeafSide> = new Set(['active', 'inactive', 'shared'])
const MAX_TEXT_LENGTH = 10_000

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * Resolve the project_id for a note based on its scope. Server-side
 * derivation prevents a malicious client from spoofing project_id while
 * passing a foreign opening/item id. RLS would also catch this, but
 * surfacing it here gives a cleaner 400 instead of an opaque RLS denial.
 */
async function resolveProjectId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  input: CreateNoteInput,
): Promise<{ projectId: string } | { error: string; status: number }> {
  if (input.scope === 'project') {
    return { projectId: input.project_id }
  }
  if (input.scope === 'opening' || input.scope === 'leaf') {
    const { data, error } = await supabase
      .from('openings')
      .select('project_id')
      .eq('id', input.opening_id)
      .single()
    if (error || !data) {
      return { error: 'Opening not found', status: 404 }
    }
    return { projectId: (data as { project_id: string }).project_id }
  }
  // item scope: hardware_items → openings → project_id
  const { data, error } = await supabase
    .from('hardware_items')
    .select('opening_id, openings!inner(project_id)')
    .eq('id', input.hardware_item_id)
    .single()
  if (error || !data) {
    return { error: 'Hardware item not found', status: 404 }
  }
  const row = data as { opening_id: string; openings: { project_id: string } | { project_id: string }[] }
  const openings = Array.isArray(row.openings) ? row.openings[0] : row.openings
  if (!openings) {
    return { error: 'Hardware item has no parent opening', status: 400 }
  }
  return { projectId: openings.project_id }
}

/**
 * GET /api/notes
 *
 * List notes for a given scope. Required query params:
 *   - project_id (always)
 * Optional filters:
 *   - scope, opening_id, hardware_item_id, leaf_side
 *
 * RLS limits results to projects the user belongs to, so even an
 * unfiltered call by project_id is safe.
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authErr } = await supabase.auth.getUser()
    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const projectId = searchParams.get('project_id')
    if (!projectId) return badRequest('project_id query param required')

    // `notes` was added by migration 051; the generated Database type in
    // src/lib/types/database.ts hasn't been regenerated yet, so the typed
    // client rejects table name. Cast through `any` until types are
    // regenerated against live schema (same pattern as darrin_logs).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = (supabase.from('notes' as never) as any)
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true })

    const scope = searchParams.get('scope')
    if (scope) {
      if (!VALID_SCOPES.has(scope as NoteScope)) return badRequest(`invalid scope: ${scope}`)
      q = q.eq('scope', scope)
    }
    const openingId = searchParams.get('opening_id')
    if (openingId) q = q.eq('opening_id', openingId)
    const hardwareItemId = searchParams.get('hardware_item_id')
    if (hardwareItemId) q = q.eq('hardware_item_id', hardwareItemId)
    const leafSide = searchParams.get('leaf_side')
    if (leafSide) {
      if (!VALID_LEAF_SIDES.has(leafSide as LeafSide)) return badRequest(`invalid leaf_side: ${leafSide}`)
      q = q.eq('leaf_side', leafSide)
    }

    const { data, error } = await q
    if (error) {
      console.error('[notes GET] query failed:', error.message)
      return NextResponse.json({ error: 'Failed to fetch notes' }, { status: 500 })
    }
    return NextResponse.json({ notes: (data ?? []) as Note[] })
  } catch (err) {
    console.error('[notes GET] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/notes
 *
 * Body: CreateNoteInput. project_id is server-derived from the FK so
 * clients can't attach a note to a project they don't belong to.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authErr } = await supabase.auth.getUser()
    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = (await request.json()) as Partial<CreateNoteInput>

    if (!body.scope || !VALID_SCOPES.has(body.scope as NoteScope)) {
      return badRequest('scope is required and must be project|opening|leaf|item')
    }
    const text = body.original_text
    if (typeof text !== 'string' || text.trim().length === 0) {
      return badRequest('original_text is required and must be non-empty')
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return badRequest(`original_text exceeds ${MAX_TEXT_LENGTH} chars`)
    }

    // Per-scope shape validation before resolving project_id.
    const input = body as CreateNoteInput
    if (input.scope === 'project' && !input.project_id) {
      return badRequest('project scope requires project_id')
    }
    if ((input.scope === 'opening' || input.scope === 'leaf') && !input.opening_id) {
      return badRequest(`${input.scope} scope requires opening_id`)
    }
    if (input.scope === 'leaf') {
      if (!input.leaf_side || !VALID_LEAF_SIDES.has(input.leaf_side)) {
        return badRequest('leaf scope requires leaf_side in active|inactive|shared')
      }
    }
    if (input.scope === 'item' && !input.hardware_item_id) {
      return badRequest('item scope requires hardware_item_id')
    }

    const resolved = await resolveProjectId(supabase, input)
    if ('error' in resolved) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status })
    }

    // Build the row. Only set FKs that are valid for this scope; the
    // CHECK constraint enforces this, but constructing a clean payload
    // gives nicer error messages and avoids partial-set bugs.
    const insertRow: Record<string, unknown> = {
      project_id: resolved.projectId,
      scope: input.scope,
      original_text: text.trim(),
      created_by: user.id,
    }
    if (input.scope === 'opening' || input.scope === 'leaf') {
      insertRow.opening_id = input.opening_id
    }
    if (input.scope === 'leaf') {
      insertRow.leaf_side = input.leaf_side
    }
    if (input.scope === 'item') {
      insertRow.hardware_item_id = input.hardware_item_id
      // RLS needs opening_id on the row too — derive from the item.
      const { data: itemRow, error: itemErr } = await supabase
        .from('hardware_items')
        .select('opening_id')
        .eq('id', input.hardware_item_id)
        .single()
      if (itemErr || !itemRow) {
        return NextResponse.json({ error: 'Hardware item not found' }, { status: 404 })
      }
      insertRow.opening_id = (itemRow as { opening_id: string }).opening_id
    }

    // See note above on `notes` table cast.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.from('notes' as never) as any)
      .insert(insertRow)
      .select('*')
      .single()

    if (error) {
      // Could be CHECK constraint, RLS denial, or FK miss. RLS denial
      // returns code 42501 / "new row violates row-level security policy".
      console.error('[notes POST] insert failed:', error.message)
      const isRls = error.message.toLowerCase().includes('row-level security')
      return NextResponse.json(
        { error: isRls ? 'Not a member of this project' : 'Failed to create note' },
        { status: isRls ? 403 : 500 },
      )
    }

    const created = data as Note
    void logActivity({
      projectId: created.project_id,
      userId: user.id,
      action: ACTIVITY_ACTIONS.NOTE_CREATED,
      entityType: 'note',
      entityId: created.id,
      details: { scope: created.scope, opening_id: created.opening_id, hardware_item_id: created.hardware_item_id },
    })

    return NextResponse.json({ note: created }, { status: 201 })
  } catch (err) {
    console.error('[notes POST] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
