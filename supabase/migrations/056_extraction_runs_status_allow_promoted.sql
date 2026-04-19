-- Migration 056: HOTFIX — re-add 'promoted' to extraction_runs.status CHECK
--
-- SECOND production blocker uncovered after PR #341 (migration 055) fixed
-- the notes-column drift in merge_extraction. The notes bug short-circuited
-- the function with an exception before it reached the final UPDATE
-- statement; once 055 let the function run to completion, every promotion
-- attempt failed at:
--
--   UPDATE extraction_runs
--   SET status = 'promoted', promoted_at = now(), promoted_by = p_user_id
--   WHERE id = p_extraction_run_id;
--
-- Migration 050 narrowed extraction_runs_status_check from a wider set down
-- to {'extracting','reviewing','completed_with_issues','failed'} — explicitly
-- dropping 'promoted'. The 050 commit message claimed "merge_extraction does
-- NOT update extraction_runs.status to 'promoted' — promotion is tracked via
-- activity_log entries instead." That claim was an audit error: migration
-- 037 (the most recent function redefinition before 055) clearly contains
-- the UPDATE ... SET status='promoted' line, and a row in production with
-- promoted_at IS NOT NULL confirms the function used to work this way for
-- months prior to 050.
--
-- Net effect: every staged extraction promotion has been silently broken
-- since 050 landed — first by failing inside the function (notes column),
-- then by failing the CHECK constraint after 055 fixed the column issue.
-- The EXCEPTION WHEN OTHERS handler swallowed both errors so Sentry never
-- saw them; the failure surfaced only as merge_extraction returning
-- {success: false, error: ...} to the API caller.
--
-- Why re-widen instead of removing the function's status update:
--
--   1. promoted_at + promoted_by columns are clearly load-bearing. The
--      function writes both in the same UPDATE; they're audit signal that
--      structured queries (e.g. "show me all promoted runs") can use
--      without a join to activity_log.
--   2. The 050 author's "intent" was never actually implemented — no
--      function rewrite, no column drop. Honoring that intent now would
--      be a refactor, not a hotfix.
--   3. Adding a value to a CHECK constraint is monotonically safe — no
--      existing row can violate it. Removing the function's UPDATE +
--      dropping the columns would be higher-risk operations.
--
-- This migration restores 'promoted' to the allowed set. The DEFAULT stays
-- 'extracting' (migration 050's other half, also part of this constraint
-- block; restated here for clarity even though it's already in place).

BEGIN;

ALTER TABLE extraction_runs
  DROP CONSTRAINT IF EXISTS extraction_runs_status_check;

ALTER TABLE extraction_runs
  ADD CONSTRAINT extraction_runs_status_check
  CHECK (status = ANY (ARRAY[
    'extracting'::text,
    'reviewing'::text,
    'completed_with_issues'::text,
    'failed'::text,
    'promoted'::text
  ]));

-- Re-state the DEFAULT for clarity. Already set by migration 050; this is
-- idempotent and ensures the column's default doesn't drift if 050's other
-- changes are ever rolled back independently.
ALTER TABLE extraction_runs
  ALTER COLUMN status SET DEFAULT 'extracting';

COMMENT ON CONSTRAINT extraction_runs_status_check ON extraction_runs IS
  'Lifecycle states for an extraction run. Migration 056 re-added "promoted" '
  'after migration 050 mistakenly dropped it — the merge_extraction RPC has '
  'always written that value at the end of a successful promotion (see '
  'migration 037). See migration 056 for full context.';

COMMIT;
