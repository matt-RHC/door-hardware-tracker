-- Migration 031: Dashboard schema additions
-- Adds stage tracking to hardware_items, floor/zone to openings,
-- and dashboard_shares table for external stakeholder access.

-- Stage column on hardware_items
ALTER TABLE hardware_items
  ADD COLUMN IF NOT EXISTS stage TEXT DEFAULT 'ordered'
    CHECK (stage IN ('ordered','shipped','received','installed','qa_passed'));

-- Floor/zone on openings
ALTER TABLE openings
  ADD COLUMN IF NOT EXISTS floor_number INTEGER,
  ADD COLUMN IF NOT EXISTS zone_name TEXT;

-- Dashboard sharing for external stakeholders
CREATE TABLE IF NOT EXISTS dashboard_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shared_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  share_token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  label TEXT,
  permissions TEXT[] DEFAULT ARRAY['view_progress'],
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dashboard_shares_project ON dashboard_shares(project_id);
CREATE INDEX IF NOT EXISTS idx_dashboard_shares_token ON dashboard_shares(share_token);
CREATE INDEX IF NOT EXISTS idx_openings_floor ON openings(floor_number);
CREATE INDEX IF NOT EXISTS idx_hardware_items_stage ON hardware_items(stage);

-- RLS
ALTER TABLE dashboard_shares ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members can manage dashboard shares"
  ON dashboard_shares FOR ALL
  USING (project_id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid()));
