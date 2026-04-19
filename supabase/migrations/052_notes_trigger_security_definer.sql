-- Migration 052: Fix mark_notes_summaries_stale silently no-oping for non-admins
--
-- Migration 051 created mark_notes_summaries_stale() with the default
-- SECURITY INVOKER, meaning the trigger ran with the calling user's role.
-- The projects UPDATE RLS policy (current version: migration 040) requires
-- BOTH project_members.role = 'admin' AND company_members on the company,
-- so when a regular project member created/edited/deleted a note, the
-- trigger's UPDATE on `projects` was silently filtered by RLS — no error,
-- no rows changed. Result: punch_notes_ai_summary_stale never flipped for
-- non-admin users (or for cross-company admins).
--
-- The same logic applies to admins on cross-company shared projects.
--
-- Fix: SECURITY DEFINER makes the function run as the role that owns it
-- (the migration runner — typically postgres / supabase_admin), which
-- bypasses RLS. SET search_path = public, pg_temp is the standard hardening
-- to pair with SECURITY DEFINER (prevents a search_path-injection attack
-- on the DEFINER-owned function).
--
-- Also adds COMMENT ON POLICY for notes_update + notes_delete to make the
-- "any project member can edit/delete any note" choice explicit. This is
-- intentional (PMs need to clean up after foremen) and documented here so
-- future readers don't assume it's an oversight to tighten.

BEGIN;

CREATE OR REPLACE FUNCTION mark_notes_summaries_stale()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
$$;

COMMENT ON FUNCTION mark_notes_summaries_stale() IS
  'Trigger function on `notes` that marks parent project + opening summaries stale. '
  'SECURITY DEFINER (migration 052) so it bypasses the projects UPDATE RLS policy, '
  'which restricts updates to admin + company members. Without this the stale flag '
  'silently no-ops for the majority of users.';

COMMENT ON POLICY notes_update ON notes IS
  'Any project member can edit any note in their project (not just the author). '
  'Intentional for the construction workflow: PMs need to clean up notes left by '
  'foremen / subs. UI gates Edit/Delete to the author via currentUserId; this '
  'policy is the safety net for power users with legitimate cleanup needs. '
  'See migration 051 + 052.';

COMMENT ON POLICY notes_delete ON notes IS
  'Any project member can delete any note in their project (not just the author). '
  'Same rationale as notes_update — author-only deletes would block PMs from '
  'cleaning up after departed subs. UI restricts Delete to the author via '
  'currentUserId. See migration 051 + 052.';

COMMIT;
