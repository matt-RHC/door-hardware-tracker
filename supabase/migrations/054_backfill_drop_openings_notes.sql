-- Migration 054: Backfill openings.notes into the notes table, then drop column
--
-- Closes audit finding #10 (the dead column flagged by the 2026-04-18 pipeline
-- audit). The column was historically a free-text per-opening notes field that
-- the UI accepted writes to but no other code path consumed. Migration 051
-- introduced the proper `notes` table; PR #338 (door detail page) stopped
-- accepting new writes and rendered the legacy value read-only with a "Legacy"
-- badge. This migration completes the transition: backfill any non-empty
-- legacy values into `notes` as opening-scope rows, then DROP the column so
-- the badge can go away.
--
-- Idempotent. Safe to re-run: the IF EXISTS guard on the column means a
-- second invocation is a no-op (both backfill and drop are skipped when the
-- column is already gone). The whole migration runs in a single transaction
-- so a failure mid-backfill rolls everything back.
--
-- Side effects of the backfill:
--   - Each INSERT fires the `mark_notes_summaries_stale` trigger (migration
--     051 + 052), marking each affected opening + project summary stale.
--     This is correct: the AI summary should regenerate to include the
--     newly-visible notes. The trigger's COALESCE check skips redundant
--     UPDATEs, so even with N openings + M projects affected, the total
--     trigger work is ~N + M UPDATE statements, which is fine for any
--     realistic N.
--   - Backfilled notes have `created_by = NULL` (original author unknown)
--     and `created_at = NOW()` (default). They're indistinguishable in the
--     UI from notes typed in the new editor, which is fine — the content
--     is what matters.
--
-- The legacy column comment (if any) goes away automatically with the column.

BEGIN;

DO $$
BEGIN
  -- Only run if the column still exists. Re-runs become no-ops.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'openings'
      AND column_name = 'notes'
  ) THEN
    -- Backfill: one opening-scope note per opening with a non-empty legacy value.
    INSERT INTO notes (project_id, opening_id, scope, original_text, created_by)
    SELECT
      o.project_id,
      o.id,
      'opening',
      o.notes,
      NULL  -- original author unknown
    FROM openings o
    WHERE o.notes IS NOT NULL AND TRIM(o.notes) <> '';

    -- Drop the legacy column. UI in PR #338 already stopped reading it via
    -- the editor; the read-only "Legacy" banner in the Notes tab references
    -- the same `notes` field on the OpeningDetail payload, which will now
    -- return undefined → banner naturally hides.
    ALTER TABLE openings DROP COLUMN notes;
  END IF;
END $$;

COMMIT;
