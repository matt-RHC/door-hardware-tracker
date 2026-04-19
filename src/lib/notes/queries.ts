/**
 * Query helpers for the punch-notes feature.
 *
 * Centralizes the join shapes used by:
 *   - GET /api/notes (list endpoint)
 *   - /project/[id]/punch-notes page (server-side fetch)
 *   - /api/projects/[id]/punch-notes/summarize (AI prompt assembly)
 *   - /api/projects/[id]/punch-notes/export-pdf (PDF rendering)
 *
 * Keep all four call sites in sync by routing through these helpers
 * rather than duplicating Supabase query strings.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Note } from '@/lib/types/notes'

export interface ProjectNotesBundle {
  /** Every note in the project, in created_at ASC order. The caller is
   *  responsible for grouping by scope/opening/leaf/item for display. */
  notes: Note[]
  /** Door numbers keyed by opening_id, for rendering "Door 110-02C" style
   *  labels without a second round-trip. NULL when an opening row has no
   *  door_number (shouldn't happen but defended against). */
  doorNumbers: Record<string, string | null>
  /** Item names keyed by hardware_item_id, for rendering "Hinges" labels
   *  on item-scope notes without a second round-trip. */
  itemNames: Record<string, string | null>
}

/**
 * Fetch every note in a project plus the minimal metadata needed to render
 * them (door numbers and item names). Uses a single Supabase round-trip.
 *
 * RLS enforces project membership — pass a user-scoped Supabase client (NOT
 * the admin client) when calling from a route that must respect membership.
 */
export async function fetchProjectNotes(
  supabase: SupabaseClient,
  projectId: string,
): Promise<ProjectNotesBundle> {
  // `notes` table cast — generated DB types haven't been regenerated since
  // migration 051. Same pattern as darrin_logs. Remove when types regen.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: notesRows, error: notesErr } = await (supabase.from('notes' as never) as any)
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })

  if (notesErr) throw new Error(`Failed to fetch notes: ${notesErr.message}`)

  const notes = (notesRows ?? []) as Note[]

  // Collect the FK ids we need labels for.
  const openingIds = Array.from(
    new Set(notes.map(n => n.opening_id).filter((x): x is string => !!x)),
  )
  const itemIds = Array.from(
    new Set(notes.map(n => n.hardware_item_id).filter((x): x is string => !!x)),
  )

  // Two parallel lookups — usually small sets, no pagination needed.
  const [openingsRes, itemsRes] = await Promise.all([
    openingIds.length > 0
      ? supabase
          .from('openings')
          .select('id, door_number')
          .in('id', openingIds)
      : Promise.resolve({ data: [], error: null }),
    itemIds.length > 0
      ? supabase
          .from('hardware_items')
          .select('id, name')
          .in('id', itemIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (openingsRes.error) {
    throw new Error(`Failed to fetch opening labels: ${openingsRes.error.message}`)
  }
  if (itemsRes.error) {
    throw new Error(`Failed to fetch item labels: ${itemsRes.error.message}`)
  }

  const doorNumbers: Record<string, string | null> = {}
  for (const o of (openingsRes.data ?? []) as Array<{ id: string; door_number: string | null }>) {
    doorNumbers[o.id] = o.door_number ?? null
  }

  const itemNames: Record<string, string | null> = {}
  for (const i of (itemsRes.data ?? []) as Array<{ id: string; name: string | null }>) {
    itemNames[i.id] = i.name ?? null
  }

  return { notes, doorNumbers, itemNames }
}
