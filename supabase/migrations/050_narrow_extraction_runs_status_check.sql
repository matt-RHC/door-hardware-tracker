-- Migration 050: Narrow the extraction_runs.status CHECK to the 4 live values.
--
-- The original CHECK constraint (from migration 007, which created the
-- extraction_runs table) allows:
--   pending | extracting | reviewing | promoted | rejected | failed |
--   completed_with_issues
--
-- Migration 007 also sets DEFAULT 'pending' on the column. Narrowing the
-- CHECK without changing the default would silently break any future
-- INSERT path that omits status — the row would default to 'pending',
-- which the new CHECK rejects. Today both writers (createExtractionRun
-- in extraction-staging.ts) explicitly pass status='extracting', so the
-- bug is dormant. Update the default in the same transaction so a
-- future contributor can't trip it.
--
-- After 6+ months of production traffic, only 4 are ever written:
--   extracting          — createExtractionRun() insert
--   reviewing           — updateExtractionRun() success path
--   completed_with_issues — partial chunk failure OR merge_extraction
--                          reported orphan doors
--   failed              — updateExtractionRun() catch path + reaper
--
-- The other 3 (pending, promoted, rejected) are vestigial:
--   - No TS / Python writer references them.
--   - The merge_extraction RPC (migration 025 / 037 / 034) does NOT update
--     extraction_runs.status to 'promoted' — promotion is tracked via
--     activity_log 'extraction_promoted' entries instead.
--   - The extraction_jobs.status column has its own separate lifecycle
--     (pending/running/completed/failed) and is unaffected by this change.
--
-- Narrowing the CHECK prevents a future accidental write of a dead value
-- (e.g. a refactor that confuses job status with run status) from going
-- unnoticed. Additive values can be re-introduced with a later migration
-- if the lifecycle grows.
--
-- Safety pre-flight: a SELECT against production on 2026-04-19 found zero
-- rows with any of the dead values. If a non-prod environment disagrees,
-- this migration will fail loudly at CHECK-validation — which is what we
-- want. To diagnose, run:
--   SELECT id, status, project_id FROM extraction_runs
--   WHERE status IN ('pending','promoted','rejected');

-- DROP + re-ADD is the standard pattern for altering a CHECK constraint
-- in Postgres. Wrapped so the operation is either fully applied or
-- fully reverted.

BEGIN;

ALTER TABLE extraction_runs
  DROP CONSTRAINT IF EXISTS extraction_runs_status_check;

ALTER TABLE extraction_runs
  ADD CONSTRAINT extraction_runs_status_check
  CHECK (status = ANY (ARRAY[
    'extracting'::text,
    'reviewing'::text,
    'completed_with_issues'::text,
    'failed'::text
  ]));

-- Migration 007's DEFAULT 'pending' is no longer in the allowed set.
-- 'extracting' is the natural new default — it's what every code path
-- already sets explicitly on insert, and it matches the row's actual
-- lifecycle entry state.
ALTER TABLE extraction_runs
  ALTER COLUMN status SET DEFAULT 'extracting';

COMMENT ON COLUMN extraction_runs.status IS
  'Run lifecycle state. Live values: extracting (created, in flight) → '
  'reviewing (success, awaiting user promote) | completed_with_issues '
  '(success but with partial chunks or orphan doors) | failed (catch '
  'handler or stuck-run reaper). See migration 050 for history of the '
  'narrowed CHECK constraint.';

COMMIT;
