-- Migration 033: Drop dead objects
-- extraction_corrections: 0 rows, only referenced by a never-called function (recordCorrection).
--   extraction_decisions (42 rows) handles the same concept and is actively used.
-- promote_extraction(): superseded by merge_extraction() — old destructive DELETE+reinsert
--   pattern that wiped checklist progress on every re-import.
--
-- Applied to production via Supabase MCP on 2026-04-15.

DROP TABLE IF EXISTS extraction_corrections CASCADE;
DROP FUNCTION IF EXISTS promote_extraction(UUID, UUID);
