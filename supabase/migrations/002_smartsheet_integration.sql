-- ============================================================
-- PROJECTS TABLE: Smartsheet tracking columns
-- ============================================================
ALTER TABLE projects ADD COLUMN IF NOT EXISTS smartsheet_sheet_id BIGINT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS smartsheet_last_synced TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS smartsheet_webhook_id BIGINT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS smartsheet_submittal_sheet_id BIGINT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS smartsheet_delivery_sheet_id BIGINT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS smartsheet_issues_sheet_id BIGINT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS smartsheet_folder_id BIGINT;

-- ============================================================
-- HARDWARE ITEMS: add install_type for bench/field classification
-- ============================================================
ALTER TABLE hardware_items ADD COLUMN IF NOT EXISTS install_type TEXT
  CHECK (install_type IN ('bench', 'field'));

-- ============================================================
-- CHECKLIST PROGRESS: add multi-step workflow columns
-- ============================================================
ALTER TABLE checklist_progress ADD COLUMN IF NOT EXISTS received BOOLEAN DEFAULT false;
ALTER TABLE checklist_progress ADD COLUMN IF NOT EXISTS received_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE checklist_progress ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
ALTER TABLE checklist_progress ADD COLUMN IF NOT EXISTS pre_install BOOLEAN DEFAULT false;
ALTER TABLE checklist_progress ADD COLUMN IF NOT EXISTS pre_install_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE checklist_progress ADD COLUMN IF NOT EXISTS pre_install_at TIMESTAMPTZ;
ALTER TABLE checklist_progress ADD COLUMN IF NOT EXISTS installed BOOLEAN DEFAULT false;
ALTER TABLE checklist_progress ADD COLUMN IF NOT EXISTS installed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE checklist_progress ADD COLUMN IF NOT EXISTS installed_at TIMESTAMPTZ;
ALTER TABLE checklist_progress ADD COLUMN IF NOT EXISTS qa_qc BOOLEAN DEFAULT false;
ALTER TABLE checklist_progress ADD COLUMN IF NOT EXISTS qa_qc_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE checklist_progress ADD COLUMN IF NOT EXISTS qa_qc_at TIMESTAMPTZ;

-- ============================================================
-- SMARTSHEET ROW MAP: track row-level sync mapping
-- ============================================================
CREATE TABLE IF NOT EXISTS smartsheet_row_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sheet_type TEXT NOT NULL CHECK (sheet_type IN ('project', 'submittal', 'delivery', 'issues', 'portfolio')),
  smartsheet_sheet_id BIGINT NOT NULL,
  smartsheet_row_id BIGINT NOT NULL,
  local_record_id UUID NOT NULL,
  local_table TEXT NOT NULL,
  last_synced_at TIMESTAMPTZ DEFAULT now(),
  last_smartsheet_modified TIMESTAMPTZ,
  last_local_modified TIMESTAMPTZ,
  sync_hash TEXT,
  UNIQUE(smartsheet_sheet_id, smartsheet_row_id),
  UNIQUE(sheet_type, local_record_id)
);

CREATE INDEX smartsheet_row_map_project_idx ON smartsheet_row_map(project_id);
CREATE INDEX smartsheet_row_map_sheet_idx ON smartsheet_row_map(smartsheet_sheet_id);

-- ============================================================
-- SMARTSHEET WEBHOOKS: track registered webhooks
-- ============================================================
CREATE TABLE IF NOT EXISTS smartsheet_webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sheet_type TEXT NOT NULL CHECK (sheet_type IN ('project', 'submittal', 'delivery', 'issues')),
  smartsheet_webhook_id BIGINT NOT NULL UNIQUE,
  smartsheet_sheet_id BIGINT NOT NULL,
  callback_url TEXT NOT NULL,
  status TEXT DEFAULT 'ENABLED' CHECK (status IN ('ENABLED', 'DISABLED', 'NEW_NOT_VERIFIED')),
  shared_secret TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- ISSUES TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  opening_id UUID REFERENCES openings(id) ON DELETE SET NULL,
  hardware_item_id UUID REFERENCES hardware_items(id) ON DELETE SET NULL,
  door_number TEXT,
  hardware_item_name TEXT,
  issue_id_short TEXT,
  description TEXT NOT NULL,
  severity TEXT DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  assigned_to TEXT,
  reported_by TEXT,
  date_reported TIMESTAMPTZ DEFAULT now(),
  date_resolved TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX issues_project_idx ON issues(project_id);
CREATE INDEX issues_opening_idx ON issues(opening_id);

-- ============================================================
-- DELIVERIES TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  po_number TEXT,
  vendor TEXT,
  description TEXT,
  items_summary TEXT,
  quantity INTEGER,
  expected_date DATE,
  actual_date DATE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_transit', 'delivered', 'partial', 'delayed', 'cancelled')),
  tracking_number TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX deliveries_project_idx ON deliveries(project_id);

-- ============================================================
-- PORTFOLIO CONFIG
-- ============================================================
CREATE TABLE IF NOT EXISTS smartsheet_portfolio (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  smartsheet_sheet_id BIGINT,
  smartsheet_webhook_id BIGINT,
  last_synced TIMESTAMPTZ
);

-- ============================================================
-- RLS for new tables
-- ============================================================
ALTER TABLE smartsheet_row_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartsheet_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE smartsheet_portfolio ENABLE ROW LEVEL SECURITY;

-- Issues RLS
CREATE POLICY "Project members can view issues" ON issues FOR SELECT
  USING (auth.uid() IN (SELECT user_id FROM project_members WHERE project_id = issues.project_id));
CREATE POLICY "Project members can create issues" ON issues FOR INSERT
  WITH CHECK (auth.uid() IN (SELECT user_id FROM project_members WHERE project_id = issues.project_id));
CREATE POLICY "Project members can update issues" ON issues FOR UPDATE
  USING (auth.uid() IN (SELECT user_id FROM project_members WHERE project_id = issues.project_id));
CREATE POLICY "Project admins can delete issues" ON issues FOR DELETE
  USING (auth.uid() IN (SELECT user_id FROM project_members WHERE project_id = issues.project_id AND role = 'admin'));

-- Deliveries RLS
CREATE POLICY "Project members can view deliveries" ON deliveries FOR SELECT
  USING (auth.uid() IN (SELECT user_id FROM project_members WHERE project_id = deliveries.project_id));
CREATE POLICY "Project members can create deliveries" ON deliveries FOR INSERT
  WITH CHECK (auth.uid() IN (SELECT user_id FROM project_members WHERE project_id = deliveries.project_id));
CREATE POLICY "Project members can update deliveries" ON deliveries FOR UPDATE
  USING (auth.uid() IN (SELECT user_id FROM project_members WHERE project_id = deliveries.project_id));
CREATE POLICY "Project admins can delete deliveries" ON deliveries FOR DELETE
  USING (auth.uid() IN (SELECT user_id FROM project_members WHERE project_id = deliveries.project_id AND role = 'admin'));

-- Smartsheet internal tables: accessed only via admin client (service role bypasses RLS)

-- Enable realtime for issues and deliveries
ALTER PUBLICATION supabase_realtime ADD TABLE issues;
ALTER PUBLICATION supabase_realtime ADD TABLE deliveries;
