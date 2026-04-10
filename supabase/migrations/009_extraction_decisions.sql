-- ============================================================================
-- EXTRACTION DECISIONS
-- ============================================================================
-- Stores project-level decisions about how to interpret quantities, formats,
-- and special cases. Survives across wizard sessions and re-imports.
--
-- Examples:
--   "For this project, hinges = 3 per leaf (user confirmed from sample)"
--   "Set DH5 has 4 hinges per leaf because it's a tall door (user answered)"
--   "This submittal shows total quantities, not per-opening (user confirmed)"

CREATE TABLE extraction_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- What this decision is about
  decision_type TEXT NOT NULL
    CHECK (decision_type IN ('qty_correction', 'qty_answer', 'sample_verification', 'format_rule')),

  -- Context: which item/set/pattern this applies to
  item_category TEXT,          -- 'hinges' | 'closer' | 'lockset' | etc. (from taxonomy)
  set_id TEXT,                 -- specific set, or NULL for project-wide
  item_name TEXT,              -- specific item name pattern

  -- The decision itself
  question_text TEXT,          -- what Punchy asked (NULL for auto-corrections)
  answer TEXT NOT NULL,        -- user's response or "auto_applied"
  resolved_value JSONB,        -- structured result: {"qty": 3, "scope": "per_leaf"}

  -- How many items this was applied to
  applied_count INT DEFAULT 0,

  -- Audit
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX extraction_decisions_project_id_idx ON extraction_decisions(project_id);
CREATE INDEX extraction_decisions_category_idx ON extraction_decisions(project_id, item_category);

-- RLS: project members can manage decisions
ALTER TABLE extraction_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Project members can read decisions"
  ON extraction_decisions FOR SELECT
  USING (project_id IN (
    SELECT project_id FROM project_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "Project members can insert decisions"
  ON extraction_decisions FOR INSERT
  WITH CHECK (project_id IN (
    SELECT project_id FROM project_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "Project members can update decisions"
  ON extraction_decisions FOR UPDATE
  USING (project_id IN (
    SELECT project_id FROM project_members WHERE user_id = auth.uid()
  ));
