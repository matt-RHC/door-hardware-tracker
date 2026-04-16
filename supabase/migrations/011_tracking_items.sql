-- ============================================================
-- TRACKING ITEMS: unified cross-session tracking table
-- Replaces the three Smartsheet sheets:
--   Project Plan   (4722023373688708)
--   Session Log    (1895373728599940)
--   Metrics Log    (2206493777547140)
-- See /root/.claude/plans/mutable-dazzling-tide.md for design context.
-- ============================================================

CREATE TABLE IF NOT EXISTS tracking_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Record discriminator: which sheet does this row come from?
  record_type TEXT NOT NULL CHECK (record_type IN ('plan_item', 'session', 'metric_run')),

  -- Source traceability (points back to Smartsheet origin for audit)
  source_sheet_id BIGINT,
  source_row_id BIGINT,
  source_imported_at TIMESTAMPTZ,

  -- Universal fields (all three record types share these)
  title TEXT NOT NULL,
  status TEXT,
  category TEXT,
  priority TEXT,
  area TEXT,
  description TEXT,
  notes TEXT,
  session_refs TEXT[],
  date_identified DATE,
  date_resolved DATE,
  due_date DATE,

  -- Git-walk resolution (populated by /api/admin/tracking/refresh-status)
  resolved_pr INT,
  resolved_commit TEXT,
  code_evidence JSONB,

  -- Relevance / staleness audit (set manually or by M2 review pass)
  relevance TEXT CHECK (relevance IN ('current', 'stale', 'archived', 'unknown')),
  relevance_notes TEXT,
  last_verified_at TIMESTAMPTZ,

  -- Session-specific fields (record_type='session')
  session_topics TEXT,
  session_decisions TEXT,
  session_status TEXT,

  -- Metric-specific fields (record_type='metric_run')
  metric_pdf_name TEXT,
  metric_doors_expected INT,
  metric_doors_extracted INT,
  metric_sets_expected INT,
  metric_sets_extracted INT,
  metric_accuracy_pct NUMERIC,
  metric_duration_ms INT,
  metric_build_commit TEXT,

  -- Standard audit
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Upserts are keyed on (source_sheet_id, source_row_id) when both are present.
-- Partial unique index so locally-created rows (no Smartsheet origin) don't
-- need to supply dummy values.
CREATE UNIQUE INDEX IF NOT EXISTS tracking_items_source_unique_idx
  ON tracking_items (source_sheet_id, source_row_id)
  WHERE source_row_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tracking_items_record_type_idx ON tracking_items (record_type);
CREATE INDEX IF NOT EXISTS tracking_items_status_idx ON tracking_items (status);
CREATE INDEX IF NOT EXISTS tracking_items_relevance_idx ON tracking_items (relevance);

-- Service-role only. This is an admin/maintenance table, not user-facing
-- project data, so no project_members join. Admin client bypasses RLS.
ALTER TABLE tracking_items ENABLE ROW LEVEL SECURITY;

-- No permissive policies. All access must go through the admin client
-- (service role key), matching the existing smartsheet_row_map / smartsheet_webhooks
-- pattern from migration 002.
