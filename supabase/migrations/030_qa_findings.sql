-- Migration 030: QA findings expansion
-- Replaces single qa_qc boolean with multi-dimension QA tracking
-- Enables punch list generation and per-dimension compliance reporting

ALTER TABLE checklist_progress
  ADD COLUMN IF NOT EXISTS qa_findings    TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS qa_notes       TEXT,
  ADD COLUMN IF NOT EXISTS qa_resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qa_resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Document qa_findings tag values
COMMENT ON COLUMN checklist_progress.qa_findings IS
  'QA dimension tags: spec_match, operation, finish, fire_rating, ada, life_safety';

-- Index for punch list queries (find all items with unresolved QA issues)
CREATE INDEX IF NOT EXISTS idx_checklist_progress_qa_findings
  ON checklist_progress USING GIN (qa_findings)
  WHERE array_length(qa_findings, 1) > 0;

-- Index for unresolved QA items
CREATE INDEX IF NOT EXISTS idx_checklist_progress_qa_unresolved
  ON checklist_progress (opening_id)
  WHERE array_length(qa_findings, 1) > 0 AND qa_resolved_at IS NULL;
