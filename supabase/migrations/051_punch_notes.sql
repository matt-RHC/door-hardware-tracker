-- Migration 051: Punch-notes feature foundation
--
-- Adds a single `notes` table that holds user-written notes attached to one
-- of four scopes: project, opening, leaf (per-leaf grouping within an
-- opening), or item (specific hardware_items row). Each scope has explicit
-- nullable FK columns; a CHECK constraint enforces which combinations are
-- valid for each scope.
--
-- Why structured-polymorphic instead of per-entity tables: queries that
-- "give me every note in this project, grouped by opening/leaf/item" become
-- a single SELECT instead of UNION across 3-4 tables. RLS stays trivial
-- because `project_id` is always populated.
--
-- Also adds AI-summary columns + revert support to `openings` and
-- `projects`. The `*_previous` columns let users revert if a regeneration
-- produces worse output. The `*_stale` flag is set automatically by a
-- trigger when child notes change, so the UI can show an "(out of date)"
-- badge without app-side bookkeeping.
--
-- The `ai_text` and `display_mode` columns on `notes` ship now even though
-- v1 doesn't use them — v2 will add per-note AI cleanup, and shipping the
-- columns now means no follow-up migration. Documented in column comments
-- so future readers don't think they're dead code.

BEGIN;

-- ── Notes table ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  opening_id UUID REFERENCES openings(id) ON DELETE CASCADE,
  hardware_item_id UUID REFERENCES hardware_items(id) ON DELETE CASCADE,
  leaf_side TEXT,
  scope TEXT NOT NULL,
  original_text TEXT NOT NULL,
  ai_text TEXT,
  display_mode TEXT NOT NULL DEFAULT 'original',
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notes_scope_check
    CHECK (scope IN ('project','opening','leaf','item')),
  CONSTRAINT notes_leaf_side_check
    CHECK (leaf_side IS NULL OR leaf_side IN ('active','inactive','shared')),
  CONSTRAINT notes_display_mode_check
    CHECK (display_mode IN ('original','ai')),
  -- Scope/FK consistency: each scope dictates which FKs must be set.
  CONSTRAINT notes_scope_fk_consistency CHECK (
    (scope = 'project'  AND opening_id IS NULL          AND hardware_item_id IS NULL AND leaf_side IS NULL) OR
    (scope = 'opening'  AND opening_id IS NOT NULL      AND hardware_item_id IS NULL AND leaf_side IS NULL) OR
    (scope = 'leaf'     AND opening_id IS NOT NULL      AND hardware_item_id IS NULL AND leaf_side IS NOT NULL) OR
    (scope = 'item'     AND hardware_item_id IS NOT NULL AND opening_id IS NOT NULL  AND leaf_side IS NULL)
  )
);

COMMENT ON TABLE notes IS
  'User-written notes attached to one of four scopes (project, opening, leaf, item). '
  'Each scope dictates which FK columns must be set — enforced by notes_scope_fk_consistency. '
  'project_id is always populated for clean RLS. See migration 051.';

COMMENT ON COLUMN notes.original_text IS
  'The user''s original note text. Never modified after insert (only patched via explicit PATCH).';

COMMENT ON COLUMN notes.ai_text IS
  'v1 unused — reserved for v2 per-note AI cleanup. NULL until that feature ships.';

COMMENT ON COLUMN notes.display_mode IS
  'v1 always ''original''. Reserved for v2 toggle between original/ai_text on a per-note basis.';

-- ── Indexes ───────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS notes_project_idx
  ON notes (project_id);

-- Composite for the common punch-list assembly query
-- ("all notes in project X, grouped by scope and opening").
CREATE INDEX IF NOT EXISTS notes_lookup_idx
  ON notes (project_id, scope, opening_id);

-- Partial index — only item-scope rows have hardware_item_id set.
CREATE INDEX IF NOT EXISTS notes_hw_item_idx
  ON notes (hardware_item_id)
  WHERE hardware_item_id IS NOT NULL;

-- ── RLS ───────────────────────────────────────────────────────────────

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

-- Mirrors the inline-subquery pattern used elsewhere in this codebase
-- (see openings/hardware_items policies). No helper function — keeping
-- consistency with existing tables.

DROP POLICY IF EXISTS notes_select ON notes;
CREATE POLICY notes_select ON notes FOR SELECT
  USING (
    auth.uid() IN (
      SELECT user_id FROM project_members WHERE project_id = notes.project_id
    )
  );

DROP POLICY IF EXISTS notes_insert ON notes;
CREATE POLICY notes_insert ON notes FOR INSERT
  WITH CHECK (
    auth.uid() IN (
      SELECT user_id FROM project_members WHERE project_id = notes.project_id
    )
  );

DROP POLICY IF EXISTS notes_update ON notes;
CREATE POLICY notes_update ON notes FOR UPDATE
  USING (
    auth.uid() IN (
      SELECT user_id FROM project_members WHERE project_id = notes.project_id
    )
  );

DROP POLICY IF EXISTS notes_delete ON notes;
CREATE POLICY notes_delete ON notes FOR DELETE
  USING (
    auth.uid() IN (
      SELECT user_id FROM project_members WHERE project_id = notes.project_id
    )
  );

-- ── Updated_at maintenance ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION notes_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notes_updated_at ON notes;
CREATE TRIGGER notes_updated_at
  BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION notes_set_updated_at();

-- ── AI summary columns on parent tables ───────────────────────────────

ALTER TABLE openings
  ADD COLUMN IF NOT EXISTS notes_ai_summary TEXT,
  ADD COLUMN IF NOT EXISTS notes_ai_summary_previous TEXT,
  ADD COLUMN IF NOT EXISTS notes_ai_summary_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notes_ai_summary_stale BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN openings.notes_ai_summary IS
  'Current AI-generated summary of all notes (item / leaf / opening scope) for this opening. '
  'Manual regeneration via /api/openings/[id]/notes/summarize. See migration 051.';

COMMENT ON COLUMN openings.notes_ai_summary_previous IS
  'Previous AI summary, preserved on regenerate so users can revert if the new version is worse. '
  'Swap via /api/openings/[id]/notes/revert. See migration 051.';

COMMENT ON COLUMN openings.notes_ai_summary_stale IS
  'Set to TRUE by trigger when any child note changes. UI shows "(out of date)" badge. '
  'Cleared after successful regeneration. See migration 051.';

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS punch_notes_ai_summary TEXT,
  ADD COLUMN IF NOT EXISTS punch_notes_ai_summary_previous TEXT,
  ADD COLUMN IF NOT EXISTS punch_notes_ai_summary_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS punch_notes_ai_summary_stale BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN projects.punch_notes_ai_summary IS
  'Project-level AI summary aggregating all opening summaries + project-scope notes. See migration 051.';

COMMENT ON COLUMN projects.punch_notes_ai_summary_previous IS
  'Previous project AI summary for revert. See migration 051.';

COMMENT ON COLUMN projects.punch_notes_ai_summary_stale IS
  'TRUE when any note in the project has changed since the last project-summary regeneration. See migration 051.';

-- ── Stale-flag trigger ────────────────────────────────────────────────
--
-- Fires AFTER any change on the notes table. Marks the parent project
-- summary stale; if the note was opening/leaf/item-scoped, also marks the
-- parent opening summary stale. Keeps the application code simple — even
-- a future writer that bypasses the API and inserts into `notes` directly
-- will trigger the stale flag.

CREATE OR REPLACE FUNCTION mark_notes_summaries_stale() RETURNS TRIGGER AS $$
DECLARE
  v_project_id UUID;
  v_opening_id UUID;
BEGIN
  v_project_id := COALESCE(NEW.project_id, OLD.project_id);
  v_opening_id := COALESCE(NEW.opening_id, OLD.opening_id);

  -- Project summary is always stale on any note change in this project.
  UPDATE projects
    SET punch_notes_ai_summary_stale = TRUE
    WHERE id = v_project_id
      AND COALESCE(punch_notes_ai_summary_stale, FALSE) = FALSE;

  -- Opening summary stale only if the note is scoped to an opening.
  IF v_opening_id IS NOT NULL THEN
    UPDATE openings
      SET notes_ai_summary_stale = TRUE
      WHERE id = v_opening_id
        AND COALESCE(notes_ai_summary_stale, FALSE) = FALSE;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notes_stale_trigger ON notes;
CREATE TRIGGER notes_stale_trigger
  AFTER INSERT OR UPDATE OR DELETE ON notes
  FOR EACH ROW EXECUTE FUNCTION mark_notes_summaries_stale();

COMMIT;
