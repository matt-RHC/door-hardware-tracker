/**
 * Punch-notes feature types — corresponds to the `notes` table created in
 * migration 051.
 *
 * Notes are scoped to one of four levels (project / opening / leaf / item),
 * with a CHECK constraint enforcing the right combination of FK columns
 * for each scope. The discriminated union `Note` mirrors that constraint
 * at the type level so callers can't construct invalid shapes.
 */

export type NoteScope = 'project' | 'opening' | 'leaf' | 'item'

export type LeafSide = 'active' | 'inactive' | 'shared'

/** v1 always 'original'. Reserved for v2 when AI cleans individual notes. */
export type NoteDisplayMode = 'original' | 'ai'

interface NoteBase {
  id: string
  project_id: string
  original_text: string
  ai_text: string | null
  display_mode: NoteDisplayMode
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface ProjectNote extends NoteBase {
  scope: 'project'
  opening_id: null
  hardware_item_id: null
  leaf_side: null
}

export interface OpeningNote extends NoteBase {
  scope: 'opening'
  opening_id: string
  hardware_item_id: null
  leaf_side: null
}

export interface LeafNote extends NoteBase {
  scope: 'leaf'
  opening_id: string
  hardware_item_id: null
  leaf_side: LeafSide
}

export interface ItemNote extends NoteBase {
  scope: 'item'
  opening_id: string
  hardware_item_id: string
  leaf_side: null
}

export type Note = ProjectNote | OpeningNote | LeafNote | ItemNote

/** Shape accepted by POST /api/notes. The server fills in IDs, timestamps,
 *  created_by, and project_id (for non-project scopes, derived from FK). */
export type CreateNoteInput =
  | { scope: 'project'; project_id: string; original_text: string }
  | { scope: 'opening'; opening_id: string; original_text: string }
  | {
      scope: 'leaf'
      opening_id: string
      leaf_side: LeafSide
      original_text: string
    }
  | { scope: 'item'; hardware_item_id: string; original_text: string }

/** Shape accepted by PATCH /api/notes/[id]. v1 supports text + display_mode. */
export interface UpdateNoteInput {
  original_text?: string
  ai_text?: string | null
  display_mode?: NoteDisplayMode
}
