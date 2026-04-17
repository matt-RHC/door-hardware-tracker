-- Migration 036: Product families — per-project product database
--
-- Turns the existing UI-only StepProducts grouping into a durable per-project
-- product library. Confirmed groupings persist here so:
--   (a) re-imports load prior decisions (don't re-prompt on known families)
--   (b) future cutsheet fetch by canonical_model has a stable key
--   (c) Darrin can consult the project's product DB to fill in blanks
--       during extraction (Phase 5+)
--
-- Scope: per-project only. Cross-project product library is out of scope.

-- =============================================================
-- product_families — canonical product groupings per project
-- =============================================================
CREATE TABLE IF NOT EXISTS product_families (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Identity: (project_id, manufacturer, base_series) is the natural key
  manufacturer     TEXT NOT NULL,
  base_series      TEXT NOT NULL,

  -- Canonical representation: the chosen model string to write back to items
  canonical_model  TEXT NOT NULL,
  category         TEXT,

  -- Variants rolled up from analyzeProducts(): [{ model, occurrences, setIds }]
  variants         JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Audit
  created_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One canonical row per (project, manufacturer, base_series) pair
  UNIQUE(project_id, manufacturer, base_series)
);

CREATE INDEX IF NOT EXISTS idx_product_families_project
  ON product_families(project_id);
CREATE INDEX IF NOT EXISTS idx_product_families_project_mfr
  ON product_families(project_id, manufacturer);

-- =============================================================
-- product_family_members — link hardware_items to a family
-- =============================================================
-- Populated by /api/parse-pdf/save after item insert. One item belongs to
-- at most one family; families can have many items.
CREATE TABLE IF NOT EXISTS product_family_members (
  family_id    UUID NOT NULL REFERENCES product_families(id) ON DELETE CASCADE,
  item_id      UUID NOT NULL REFERENCES hardware_items(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_product_family_members_item
  ON product_family_members(item_id);

-- =============================================================
-- RLS policies
-- =============================================================
ALTER TABLE product_families ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_family_members ENABLE ROW LEVEL SECURITY;

-- Project members can CRUD their project's product families
CREATE POLICY "Project members can manage product families"
  ON product_families FOR ALL
  USING (project_id IN (
    SELECT project_id FROM project_members WHERE user_id = auth.uid()
  ));

-- Members table follows the family's project access
CREATE POLICY "Project members can manage product family members"
  ON product_family_members FOR ALL
  USING (family_id IN (
    SELECT id FROM product_families WHERE project_id IN (
      SELECT project_id FROM project_members WHERE user_id = auth.uid()
    )
  ));

-- =============================================================
-- updated_at trigger
-- =============================================================
CREATE OR REPLACE FUNCTION update_product_families_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER product_families_updated_at
  BEFORE UPDATE ON product_families
  FOR EACH ROW EXECUTE FUNCTION update_product_families_updated_at();
