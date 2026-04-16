-- Migration 022: Add deep extraction columns to extraction_jobs
--
-- Phase D of the "nuclear option": supports auto-fallback deep extraction
-- by adding dedicated columns for tracking deep extraction state,
-- auto-trigger status, confidence data, and reconciliation results.

ALTER TABLE extraction_jobs
  ADD COLUMN IF NOT EXISTS deep_extraction       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_triggered         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS extraction_confidence  JSONB,
  ADD COLUMN IF NOT EXISTS reconciliation_result  JSONB;

-- Index for querying jobs that need deep extraction
CREATE INDEX IF NOT EXISTS idx_extraction_jobs_deep
  ON extraction_jobs(deep_extraction) WHERE deep_extraction = true;

COMMENT ON COLUMN extraction_jobs.deep_extraction IS 'Whether this job uses vision-model deep extraction (Strategy B)';
COMMENT ON COLUMN extraction_jobs.auto_triggered IS 'Whether deep extraction was auto-triggered by low confidence (vs user-initiated)';
COMMENT ON COLUMN extraction_jobs.extraction_confidence IS 'Confidence scoring result from Strategy A extraction';
COMMENT ON COLUMN extraction_jobs.reconciliation_result IS 'Reconciliation output from merging Strategy A + B';
