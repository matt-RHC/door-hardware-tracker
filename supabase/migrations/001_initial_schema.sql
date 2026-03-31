-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- TABLES
-- ============================================================================

-- Projects table
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  job_number TEXT,
  general_contractor TEXT,
  architect TEXT,
  address TEXT,
  submittal_date DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Project Members table
CREATE TABLE project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  invited_email TEXT,
  joined_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, user_id)
);

-- Openings (doors) table
CREATE TABLE openings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  door_number TEXT NOT NULL,
  hw_set TEXT,
  hw_heading TEXT,
  location TEXT,
  door_type TEXT,
  frame_type TEXT,
  fire_rating TEXT,
  hand TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, door_number)
);

-- Hardware Items table
CREATE TABLE hardware_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opening_id UUID NOT NULL REFERENCES openings(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  qty INTEGER DEFAULT 1,
  manufacturer TEXT,
  model TEXT,
  finish TEXT,
  options TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Checklist Progress table
CREATE TABLE checklist_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opening_id UUID NOT NULL REFERENCES openings(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES hardware_items(id) ON DELETE CASCADE,
  checked BOOLEAN DEFAULT false,
  checked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  checked_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(opening_id, item_id)
);

-- Attachments table
CREATE TABLE attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opening_id UUID NOT NULL REFERENCES openings(id) ON DELETE CASCADE,
  file_url TEXT NOT NULL,
  file_name TEXT,
  file_type TEXT,
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX openings_project_id_idx ON openings(project_id);
CREATE INDEX hardware_items_opening_id_idx ON hardware_items(opening_id);
CREATE INDEX checklist_progress_opening_id_idx ON checklist_progress(opening_id);
CREATE INDEX checklist_progress_item_id_idx ON checklist_progress(item_id);
CREATE INDEX attachments_opening_id_idx ON attachments(opening_id);

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE openings ENABLE ROW LEVEL SECURITY;
ALTER TABLE hardware_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;

-- Projects RLS Policies
-- Users can select projects they are members of
CREATE POLICY "Users can view projects they are members of"
  ON projects FOR SELECT
  USING (
    auth.uid() IN (
      SELECT user_id FROM project_members
      WHERE project_members.project_id = projects.id
    )
  );

-- Users can insert projects (they become the creator)
CREATE POLICY "Authenticated users can create projects"
  ON projects FOR INSERT
  WITH CHECK (auth.uid() = created_by);

-- Users can update projects they are admins of
CREATE POLICY "Project admins can update projects"
  ON projects FOR UPDATE
  USING (
    auth.uid() IN (
      SELECT user_id FROM project_members
      WHERE project_members.project_id = projects.id
      AND role = 'admin'
    )
  );

-- Users can delete projects they are admins of
CREATE POLICY "Project admins can delete projects"
  ON projects FOR DELETE
  USING (
    auth.uid() IN (
      SELECT user_id FROM project_members
      WHERE project_members.project_id = projects.id
      AND role = 'admin'
    )
  );

-- Project Members RLS Policies
-- Users can view project members if they are members of the project
CREATE POLICY "Project members can view members"
  ON project_members FOR SELECT
  USING (
    auth.uid() IN (
      SELECT user_id FROM project_members pm2
      WHERE pm2.project_id = project_members.project_id
    )
  );

-- Only admins can insert new project members
CREATE POLICY "Project admins can add members"
  ON project_members FOR INSERT
  WITH CHECK (
    auth.uid() IN (
      SELECT user_id FROM project_members pm
      WHERE pm.project_id = project_members.project_id
      AND pm.role = 'admin'
    )
  );

-- Only admins can update project members
CREATE POLICY "Project admins can update members"
  ON project_members FOR UPDATE
  USING (
    auth.uid() IN (
      SELECT user_id FROM project_members pm
      WHERE pm.project_id = project_members.project_id
      AND pm.role = 'admin'
    )
  );

-- Only admins can delete project members
CREATE POLICY "Project admins can remove members"
  ON project_members FOR DELETE
  USING (
    auth.uid() IN (
      SELECT user_id FROM project_members pm
      WHERE pm.project_id = project_members.project_id
      AND pm.role = 'admin'
    )
  );

-- Openings RLS Policies
-- Users can select openings in projects they are members of
CREATE POLICY "Project members can view openings"
  ON openings FOR SELECT
  USING (
    auth.uid() IN (
      SELECT user_id FROM project_members
      WHERE project_members.project_id = openings.project_id
    )
  );

-- Users can insert openings in projects they are members of
CREATE POLICY "Project members can create openings"
  ON openings FOR INSERT
  WITH CHECK (
    auth.uid() IN (
      SELECT user_id FROM project_members
      WHERE project_members.project_id = openings.project_id
    )
  );

-- Users can update openings in projects they are members of
CREATE POLICY "Project members can update openings"
  ON openings FOR UPDATE
  USING (
    auth.uid() IN (
      SELECT user_id FROM project_members
      WHERE project_members.project_id = openings.project_id
    )
  );

-- Users can delete openings in projects they are admins of
CREATE POLICY "Project admins can delete openings"
  ON openings FOR DELETE
  USING (
    auth.uid() IN (
      SELECT user_id FROM project_members
      WHERE project_members.project_id = openings.project_id
      AND role = 'admin'
    )
  );

-- Hardware Items RLS Policies
-- Users can select hardware items in openings from projects they are members of
CREATE POLICY "Project members can view hardware items"
  ON hardware_items FOR SELECT
  USING (
    auth.uid() IN (
      SELECT pm.user_id FROM project_members pm
      JOIN openings o ON o.project_id = pm.project_id
      WHERE o.id = hardware_items.opening_id
    )
  );

-- Users can insert hardware items in openings from projects they are members of
CREATE POLICY "Project members can create hardware items"
  ON hardware_items FOR INSERT
  WITH CHECK (
    auth.uid() IN (
      SELECT pm.user_id FROM project_members pm
      JOIN openings o ON o.project_id = pm.project_id
      WHERE o.id = hardware_items.opening_id
    )
  );

-- Users can update hardware items in openings from projects they are members of
CREATE POLICY "Project members can update hardware items"
  ON hardware_items FOR UPDATE
  USING (
    auth.uid() IN (
      SELECT pm.user_id FROM project_members pm
      JOIN openings o ON o.project_id = pm.project_id
      WHERE o.id = hardware_items.opening_id
    )
  );

-- Users can delete hardware items in openings from projects they are admins of
CREATE POLICY "Project admins can delete hardware items"
  ON hardware_items FOR DELETE
  USING (
    auth.uid() IN (
      SELECT pm.user_id FROM project_members pm
      JOIN openings o ON o.project_id = pm.project_id
      WHERE o.id = hardware_items.opening_id
      AND pm.role = 'admin'
    )
  );

-- Checklist Progress RLS Policies
-- Users can select checklist progress in openings from projects they are members of
CREATE POLICY "Project members can view checklist progress"
  ON checklist_progress FOR SELECT
  USING (
    auth.uid() IN (
      SELECT pm.user_id FROM project_members pm
      JOIN openings o ON o.project_id = pm.project_id
      WHERE o.id = checklist_progress.opening_id
    )
  );

-- Users can insert checklist progress in openings from projects they are members of
CREATE POLICY "Project members can create checklist progress"
  ON checklist_progress FOR INSERT
  WITH CHECK (
    auth.uid() IN (
      SELECT pm.user_id FROM project_members pm
      JOIN openings o ON o.project_id = pm.project_id
      WHERE o.id = checklist_progress.opening_id
    )
  );

-- Users can update checklist progress in openings from projects they are members of
CREATE POLICY "Project members can update checklist progress"
  ON checklist_progress FOR UPDATE
  USING (
    auth.uid() IN (
      SELECT pm.user_id FROM project_members pm
      JOIN openings o ON o.project_id = pm.project_id
      WHERE o.id = checklist_progress.opening_id
    )
  );

-- Users can delete checklist progress in openings from projects they are admins of
CREATE POLICY "Project admins can delete checklist progress"
  ON checklist_progress FOR DELETE
  USING (
    auth.uid() IN (
      SELECT pm.user_id FROM project_members pm
      JOIN openings o ON o.project_id = pm.project_id
      WHERE o.id = checklist_progress.opening_id
      AND pm.role = 'admin'
    )
  );

-- Attachments RLS Policies
-- Users can select attachments in openings from projects they are members of
CREATE POLICY "Project members can view attachments"
  ON attachments FOR SELECT
  USING (
    auth.uid() IN (
      SELECT pm.user_id FROM project_members pm
      JOIN openings o ON o.project_id = pm.project_id
      WHERE o.id = attachments.opening_id
    )
  );

-- Users can insert attachments in openings from projects they are members of
CREATE POLICY "Project members can create attachments"
  ON attachments FOR INSERT
  WITH CHECK (
    auth.uid() IN (
      SELECT pm.user_id FROM project_members pm
      JOIN openings o ON o.project_id = pm.project_id
      WHERE o.id = attachments.opening_id
    )
  );

-- Users can update attachments in openings from projects they are members of
CREATE POLICY "Project members can update attachments"
  ON attachments FOR UPDATE
  USING (
    auth.uid() IN (
      SELECT pm.user_id FROM project_members pm
      JOIN openings o ON o.project_id = pm.project_id
      WHERE o.id = attachments.opening_id
    )
  );

-- Users can delete attachments in openings from projects they are admins of
CREATE POLICY "Project admins can delete attachments"
  ON attachments FOR DELETE
  USING (
    auth.uid() IN (
      SELECT pm.user_id FROM project_members pm
      JOIN openings o ON o.project_id = pm.project_id
      WHERE o.id = attachments.opening_id
      AND pm.role = 'admin'
    )
  );

-- ============================================================================
-- REALTIME
-- ============================================================================

-- Enable realtime for checklist_progress table
ALTER PUBLICATION supabase_realtime ADD TABLE checklist_progress;

-- ============================================================================
-- STORAGE
-- ============================================================================

-- Create the attachments storage bucket
-- Note: This is typically done via Supabase dashboard or management API
-- The bucket should be created with public access enabled
INSERT INTO storage.buckets (id, name, public)
VALUES ('attachments', 'attachments', true)
ON CONFLICT (id) DO NOTHING;

-- Set public access policy for attachments bucket
CREATE POLICY "Public Access" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'attachments');

-- Allow authenticated users to upload to their project's attachments
CREATE POLICY "Authenticated users can upload attachments"
  ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'attachments'
    AND auth.role() = 'authenticated'
  );

-- Allow authenticated users to update their uploads
CREATE POLICY "Authenticated users can update attachments"
  ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'attachments'
    AND auth.role() = 'authenticated'
  );

-- Allow project admins to delete attachments
CREATE POLICY "Project admins can delete attachments"
  ON storage.objects
  FOR DELETE
  USING (bucket_id = 'attachments' AND auth.role() = 'authenticated');
