-- Migration 044: Post-migration schema reconciliation check for `issues`.
--
-- 032 now self-heals the 002 → 032 drift inline via `ALTER TABLE issues
-- ADD COLUMN IF NOT EXISTS …` statements placed between its CREATE TABLE
-- and its index block (commit 0576142 + follow-up). This migration is a
-- lightweight belt-and-suspenders: if any future migration (or human
-- edit) ever drops one of the columns we depend on, we want the CI
-- `rls-tenancy` job to fail here with a specific, greppable error
-- rather than fail later inside an opaque RLS policy evaluation or
-- route handler.
--
-- Runs zero writes in the happy path. A failure here means someone has
-- introduced new schema drift — inspect the diff between this check's
-- column list and `public.issues` in the target environment.

DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(expected, ', ')
  INTO v_missing
  FROM unnest(ARRAY[
    'category', 'issue_type', 'awaiting_from',
    'due_at', 'awaited_since',
    'title', 'resolution_summary',
    'source', 'source_data', 'parse_confidence',
    'resolved_at'
  ]) AS expected
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'issues'
      AND column_name  = expected
  );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      '044_reconcile: public.issues is missing expected columns (%). '
      'Expected 032_issue_tracking.sql to have added these inline. '
      'Check recent edits to 032 and any migration that may have dropped '
      'columns from issues.', v_missing;
  END IF;
END $$;

COMMENT ON TABLE public.issues IS
  'Issue tracking table. Original skeleton from 002_smartsheet_integration.sql; '
  'expanded schema (status lifecycle, classification, due_at, source fields) '
  'introduced by 032_issue_tracking.sql. Migration 044 is a post-check that '
  'the 032 reconciliation still holds.';
