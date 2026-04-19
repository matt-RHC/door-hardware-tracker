-- ============================================================================
-- Migration 057: darrin_decisions — per-decision observability ledger
-- ============================================================================
-- Complements darrin_logs (mig 014 / renamed in mig 035) with per-decision
-- rows + outcome tracking. Where darrin_logs captures one fire-and-forget row
-- per Darrin API call (CP1/CP2/CP3), darrin_decisions captures one row per
-- actionable decision inside that call — every item add/remove/fix, every
-- group question, every infill — with confidence, reasoning, cost, and the
-- downstream outcome (auto-applied, user-accepted, error, etc.).
--
-- Why this table exists:
--   1. Diagnose whether Darrin's actions are landing correctly (vs. being
--      dropped by applyCorrections, rejected by downstream validators, or
--      overridden by the user in review).
--   2. Feed the rule-mining loop (Track 1 §1D Piece #5): accept-heavy
--      actions promote to deterministic rules; reject-heavy get guardrails.
--   3. Validate lane-based Darrin (Piece #3) once it ships — per-lane
--      outcome rates are queryable without code changes.
--
-- Naming distinction from the existing extraction_decisions table (mig 009):
--   * extraction_decisions: USER-FACING Q&A memory. Project members answer
--     Punchy questions ("hinges = 3 per leaf? yes") and the answers survive
--     across sessions. User-writable via RLS.
--   * darrin_decisions: INTERNAL observability ledger. Every Darrin action
--     logged with its outcome. Service-role writes only.
-- Different purposes, different audiences, different RLS. Do not merge.
--
-- Retention: append-only except for outcome_* columns (patched post-insert
-- once the decision resolves). Rows older than 180 days can be purged.
-- ============================================================================

CREATE TABLE IF NOT EXISTS darrin_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Context ------------------------------------------------------------------
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Matches darrin_logs precedent: FK to extraction_runs, not extraction_jobs.
  extraction_run_id   UUID NULL REFERENCES extraction_runs(id) ON DELETE SET NULL,
  opening_id          UUID NULL REFERENCES openings(id) ON DELETE SET NULL,
  hardware_item_id    UUID NULL REFERENCES hardware_items(id) ON DELETE SET NULL,
  source_page         INTEGER NULL,
  checkpoint          TEXT NOT NULL CHECK (checkpoint IN ('CP1', 'CP2', 'CP3')),
  -- Lane is null today; populated once lane-based Darrin (Track 1 §1D #3) ships.
  lane                TEXT NULL CHECK (lane IS NULL OR lane IN ('hardware', 'opening', 'leaf', 'frame')),

  -- Decision -----------------------------------------------------------------
  action              TEXT NOT NULL CHECK (action IN (
                        'add', 'remove', 'fix', 'infill', 'group_question', 'no_change'
                      )),
  target_field        TEXT NULL,
  proposed_value      JSONB NULL,
  prior_value         JSONB NULL,
  siblings_considered JSONB NULL,

  -- Reasoning ----------------------------------------------------------------
  -- confidence is a 0–1 probability. Bound via CHECK so a scale error at the
  -- writer (e.g. passing 85 instead of 0.85) fails at insert time rather than
  -- silently poisoning rule-mining roll-ups downstream.
  confidence          NUMERIC(4,3) NULL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  reasoning           TEXT NULL,
  -- prompt_version = sha256(promptString) truncated to first 16 hex chars.
  -- Cheap to compute, unique enough to correlate accuracy shifts to prompt edits.
  prompt_version      TEXT NULL,

  -- Cost accounting (for the rule-mining loop) -------------------------------
  model               TEXT NULL,
  input_tokens        INTEGER NULL,
  output_tokens       INTEGER NULL,
  cost_usd            NUMERIC(10,6) NULL,
  latency_ms          INTEGER NULL,

  -- Outcome ------------------------------------------------------------------
  -- Patched post-insert by patchDarrinDecisionOutcome() once the decision resolves.
  -- auto_applied_partial is used when a batch apply partially succeeded and
  -- per-item granularity isn't available (e.g. transaction rollback after N inserts).
  outcome             TEXT NOT NULL DEFAULT 'proposed' CHECK (outcome IN (
                        'proposed',
                        'auto_applied', 'auto_applied_partial',
                        'user_accepted', 'user_rejected', 'user_edited',
                        'superseded', 'error'
                      )),
  outcome_set_at      TIMESTAMPTZ NULL,
  outcome_source      TEXT NULL CHECK (outcome_source IS NULL OR outcome_source IN (
                        'darrin_auto', 'user_review', 'rule_promotion', 'system'
                      )),

  -- Error envelope -----------------------------------------------------------
  -- error_kind is populated by classifyDarrinInfrastructureError when the
  -- Anthropic call itself fails (credit_balance / auth / rate_limit / unknown).
  -- For per-decision apply failures (e.g. constraint violation), use a domain
  -- string like 'apply_failed' or 'validation_rejected'.
  error_kind          TEXT NULL,
  error_detail        TEXT NULL,

  -- Audit --------------------------------------------------------------------
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes chosen for the three highest-volume reads:
--   1. "Show me all decisions for this project, newest first" (debug view)
--   2. "Show me all decisions for this opening" (per-opening drill-down)
--   3. "Show me accept/reject rates by checkpoint" (rule-mining loop)
CREATE INDEX IF NOT EXISTS idx_darrin_decisions_project
  ON darrin_decisions (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_darrin_decisions_opening
  ON darrin_decisions (opening_id)
  WHERE opening_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_darrin_decisions_checkpoint_outcome
  ON darrin_decisions (checkpoint, outcome);

-- RLS: same pattern as darrin_logs (mig 014) — project members can read.
-- Writes go through service role only (no INSERT / UPDATE policy).
ALTER TABLE darrin_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Project members can read darrin decisions"
  ON darrin_decisions FOR SELECT
  USING (
    project_id IN (
      SELECT project_id FROM project_members
      WHERE user_id = auth.uid()
    )
  );

COMMENT ON TABLE darrin_decisions IS
  'Per-decision observability ledger for Darrin actions (CP1/CP2/CP3). '
  'Complements darrin_logs (per-call). Service-role writes only. '
  'Distinct from extraction_decisions (mig 009), which is a user-facing Q&A store.';
