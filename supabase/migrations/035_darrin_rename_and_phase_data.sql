-- Rename punchy_logs table to darrin_logs
ALTER TABLE IF EXISTS punchy_logs RENAME TO darrin_logs;

-- Add phase_data JSONB column to extraction_jobs (if it doesn't exist)
ALTER TABLE extraction_jobs ADD COLUMN IF NOT EXISTS phase_data JSONB DEFAULT '{}';

COMMENT ON COLUMN extraction_jobs.phase_data IS 'Progressive extraction findings emitted at each pipeline phase (classify, extraction, triage). Consumed by the Darrin conversational wizard UI.';
