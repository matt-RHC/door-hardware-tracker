-- Migration 048: Per-run opening + pair-signal audit (observability)
--
-- Context: 2026-04-18 Radius DC DH4-R-NOCR bug. Three of four openings in a
-- single hardware set were silently dropped during PDF extraction (the heading
-- regex didn't match "Double Egress Door" — fixed in api/extract-tables.py),
-- and the one survivor landed with leaf_count=1 despite being a pair. Neither
-- failure was visible without re-running the extractor against the raw PDF.
--
-- This column makes both classes of failure observable post-hoc, directly
-- from the database, so the next bug like this can be diagnosed in seconds:
--
--   SELECT er.id, set_audit
--   FROM extraction_runs er,
--        jsonb_array_elements(er.opening_audit -> 'sets') set_audit
--   WHERE (set_audit->>'header_door_count')::int >
--         (set_audit->>'emitted_opening_count')::int;
--
-- The shape of opening_audit (assembled in src/lib/extraction-staging.ts at
-- staging-write time):
--
--   {
--     "sets": [
--       {
--         "set_id": "DH4-R-NOCR",
--         "heading": "DH4.1",
--         "header_door_count": 4,
--         "header_door_numbers": ["110-07B","110A-04B","110A-05B","110A-06B"],
--         "emitted_opening_count": 1,
--         "set_level_qty_door_count": 4
--       },
--       ...
--     ],
--     "openings": [
--       {
--         "door_number": "110-07B",
--         "set_id": "DH4-R-NOCR",
--         "leaf_count": 1,
--         "pair_signal_tier": "none",
--         "pair_signal_evidence": {}
--       },
--       ...
--     ]
--   }
--
-- Storing this on extraction_runs (instead of a new table) means it
-- auto-purges with the run, joins naturally to project_id + pdf_hash, and
-- avoids touching the write_staging_data / merge_extraction RPCs. Per-set
-- divergences and per-opening tier history are queryable via jsonb_path.

ALTER TABLE extraction_runs
  ADD COLUMN IF NOT EXISTS opening_audit JSONB;

COMMENT ON COLUMN extraction_runs.opening_audit IS
  'Per-run audit of opening extraction. Top-level keys: "sets" (per-hardware-set header_door_count vs emitted_opening_count, with header_door_numbers list); "openings" (per-opening leaf_count + winning pair_signal_tier + evidence). Populated at staging-write time. Use to spot silent opening loss or weak pair-detection signals without re-running extraction.';

-- Functional GIN index on the sets array. The audit is selectively queried
-- (only when investigating a regression), not on every read, so a partial
-- index keyed on the WHERE clause we expect — "any set where the header
-- count exceeds the emitted count" — would be premature. A single GIN
-- index covers ad-hoc jsonb_path queries cheaply enough.
CREATE INDEX IF NOT EXISTS idx_extraction_runs_opening_audit
  ON extraction_runs USING GIN (opening_audit jsonb_path_ops)
  WHERE opening_audit IS NOT NULL;
