-- ============================================================================
-- Migration 014: Punchy observation logging
-- ============================================================================
-- Persists every Punchy checkpoint call (column review, post-extraction,
-- quantity check) for observability. Previously, Punchy responses were used
-- inline and discarded — no way to query which PDFs/checkpoints fail most.
--
-- This table lets us:
--   1. See which PDFs produce low-confidence Punchy responses
--   2. Identify which checkpoint is the bottleneck (CP1/CP2/CP3)
--   3. Track token usage and latency over time
--   4. Grow the golden suite based on real failure data
--   5. Debug specific extraction runs without reproducing them
--
-- Retention: rows older than 90 days can be safely purged (no FK deps).
-- ============================================================================

CREATE TABLE IF NOT EXISTS punchy_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID REFERENCES projects(id) ON DELETE SET NULL,

  -- Which checkpoint: 1 = column mapping, 2 = post-extraction, 3 = quantity check
  checkpoint    SMALLINT NOT NULL CHECK (checkpoint IN (1, 2, 3)),

  -- The extraction_run this call belongs to (nullable — may not exist yet at CP1 time)
  extraction_run_id UUID REFERENCES extraction_runs(id) ON DELETE SET NULL,

  -- What was sent to Punchy (truncated to avoid storing full PDF base64)
  input_snapshot JSONB,

  -- Raw Punchy response (the parsed JSON, not the raw text)
  response      JSONB,

  -- Did the response parse as valid JSON?
  parse_ok      BOOLEAN NOT NULL DEFAULT true,

  -- Anthropic API usage
  input_tokens  INTEGER,
  output_tokens INTEGER,

  -- Wall-clock latency of the Anthropic call
  latency_ms    INTEGER,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for the two most common queries:
-- "show me all logs for a project" and "show me all logs for a checkpoint"
CREATE INDEX IF NOT EXISTS idx_punchy_logs_project
  ON punchy_logs (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_punchy_logs_checkpoint
  ON punchy_logs (checkpoint, created_at DESC);

-- RLS: same pattern as extraction_runs — project members can read their own logs
ALTER TABLE punchy_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Project members can read punchy logs"
  ON punchy_logs FOR SELECT
  USING (
    project_id IN (
      SELECT project_id FROM project_members
      WHERE user_id = auth.uid()
    )
  );

-- Service role (used by the logging wrapper) can insert without RLS
-- No INSERT policy for anon/authenticated — inserts go through service role only.

COMMENT ON TABLE punchy_logs IS
  'Persists every Punchy AI checkpoint call for observability and debugging. '
  'Checkpoint 1 = column mapping review, 2 = post-extraction review, '
  '3 = quantity sanity check. Rows >90 days old are safe to purge.';
