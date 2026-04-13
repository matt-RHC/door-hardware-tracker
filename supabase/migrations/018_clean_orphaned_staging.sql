-- Migration 018: Clean orphaned staging openings and add orphan guard
--
-- Finding #3: Live DB has 6 staging_openings rows with no matching
-- staging_hardware_items (extraction_run_id 37c6737e-a82c-42a3-ae5d-e8ad12908ae9).
-- These resulted from a non-atomic writeStagingData call where the openings
-- insert succeeded but the items insert failed or was interrupted.
--
-- The promote_extraction RPC has been updated in migration 016 to reject
-- promotion if any orphaned openings exist. This migration cleans the existing
-- orphans so that the guard does not block any in-progress runs.
--
-- Note: The extraction run (37c6737e) has status='promoted', meaning it has
-- already been promoted to production. These orphaned staging rows are safe
-- to delete — they are stale staging artefacts that were never promoted.

DELETE FROM public.staging_openings
WHERE id IN (
  SELECT so.id
  FROM public.staging_openings so
  LEFT JOIN public.staging_hardware_items shi ON shi.staging_opening_id = so.id
  WHERE shi.id IS NULL
    -- Scope to the known orphaned run for safety; remove this filter
    -- if you want to clean orphans across all runs in one pass.
    AND so.extraction_run_id = '37c6737e-a82c-42a3-ae5d-e8ad12908ae9'
);

-- Verify: the following query should return 0 rows after applying this migration.
-- SELECT COUNT(*) FROM staging_openings so
-- LEFT JOIN staging_hardware_items shi ON shi.staging_opening_id = so.id
-- WHERE shi.id IS NULL;
