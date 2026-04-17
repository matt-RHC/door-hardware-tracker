-- Migration 032: Issue tracking tables
-- Adds comprehensive issue tracking with attachments, comments, links, and watches

-- =============================================================
-- issues — core table
-- =============================================================
CREATE TABLE IF NOT EXISTS issues (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  opening_id       UUID REFERENCES openings(id) ON DELETE SET NULL,
  hardware_item_id UUID REFERENCES hardware_items(id) ON DELETE SET NULL,

  -- Classification
  category    TEXT NOT NULL,
  issue_type  TEXT NOT NULL CHECK (issue_type IN (
    'wrong_sku', 'damaged', 'keying_mismatch', 'finish_variation',
    'missing_items', 'substitution_needed', 'install_defect',
    'photo_mismatch', 'compliance_risk', 'other'
  )),
  severity    TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('critical', 'high', 'medium', 'low')),

  -- Lifecycle
  status        TEXT NOT NULL DEFAULT 'created' CHECK (status IN (
    'created', 'acknowledged', 'awaiting_action', 'blocked', 'resolved', 'duplicate', 'closed'
  )),
  assigned_to   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  awaiting_from TEXT CHECK (awaiting_from IN ('assignee', 'reporter', 'consultant', 'supplier', 'other')),
  due_at        TIMESTAMPTZ,
  awaited_since TIMESTAMPTZ,

  -- Content
  title               TEXT NOT NULL,
  description         TEXT,
  resolution_summary  TEXT,

  -- Source & audit
  reported_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  source           TEXT NOT NULL DEFAULT 'form' CHECK (source IN ('form', 'email', 'slack', 'api', 'voice_memo')),
  source_data      JSONB DEFAULT '{}',
  parse_confidence NUMERIC(4,3) DEFAULT 1.000,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);

-- Migration-drift reconciliation: migration 002_smartsheet_integration.sql
-- also creates a table called `issues` with an older, smaller column set.
-- When 002 runs first (every fresh environment — CI via `supabase start`,
-- any restored backup), the `CREATE TABLE IF NOT EXISTS` above becomes a
-- no-op and the columns below would never land, causing the next
-- `CREATE INDEX … ON issues(due_at)` to fail with 42703. These inline
-- ADD COLUMN IF NOT EXISTS statements make 032 self-healing in both
-- directions: on fresh-from-001 databases they fill in the delta; on
-- production (where the table already matches) they no-op. Order matches
-- the CREATE TABLE declaration for easy diffing.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS category           TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS issue_type         TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS awaiting_from      TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS due_at             TIMESTAMPTZ;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS awaited_since      TIMESTAMPTZ;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS title              TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS resolution_summary TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS source             TEXT DEFAULT 'form';
ALTER TABLE issues ADD COLUMN IF NOT EXISTS source_data        JSONB DEFAULT '{}'::jsonb;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS parse_confidence   NUMERIC(4,3) DEFAULT 1.000;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS resolved_at        TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_issues_project_created ON issues(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_opening ON issues(opening_id);
CREATE INDEX IF NOT EXISTS idx_issues_project_status ON issues(project_id, status);
CREATE INDEX IF NOT EXISTS idx_issues_assigned ON issues(assigned_to);
CREATE INDEX IF NOT EXISTS idx_issues_due ON issues(due_at);

-- =============================================================
-- issue_attachments — photos, voice, docs
-- =============================================================
CREATE TABLE IF NOT EXISTS issue_attachments (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id              UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  file_name             TEXT NOT NULL,
  file_type             TEXT NOT NULL CHECK (file_type IN ('photo', 'voice', 'document', 'spec_sheet', 'external_link')),
  file_size_bytes       INTEGER,
  content_type          TEXT,
  storage_path          TEXT NOT NULL,
  signed_url            TEXT,
  signed_url_expires_at TIMESTAMPTZ,
  transcript            TEXT,
  transcript_source     TEXT CHECK (transcript_source IN ('deepgram', 'browser_speech_api', 'manual')),
  uploaded_by           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  uploaded_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_issue_attachments_issue ON issue_attachments(issue_id);

-- =============================================================
-- issue_comments — threaded replies
-- =============================================================
CREATE TABLE IF NOT EXISTS issue_comments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id         UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_id        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  comment_type     TEXT NOT NULL DEFAULT 'user_comment' CHECK (comment_type IN ('user_comment', 'system_update', 'ai_summary')),
  visibility       TEXT NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'external')),
  body             TEXT NOT NULL,
  mentions         UUID[] DEFAULT ARRAY[]::UUID[],
  email_message_id TEXT,
  email_from       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_comments_email_msg ON issue_comments(email_message_id);

-- =============================================================
-- issue_links — issue relationships
-- =============================================================
CREATE TABLE IF NOT EXISTS issue_links (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_issue_id  UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  target_issue_id  UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  link_type        TEXT NOT NULL CHECK (link_type IN ('duplicate_of', 'blocks', 'related_to', 'caused_by')),
  created_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source_issue_id, target_issue_id, link_type)
);

CREATE INDEX IF NOT EXISTS idx_issue_links_source ON issue_links(source_issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_links_target ON issue_links(target_issue_id);

-- =============================================================
-- issue_watches — notification subscriptions
-- =============================================================
CREATE TABLE IF NOT EXISTS issue_watches (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id                UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  notify_on               TEXT[] DEFAULT ARRAY['status_change', 'comment_added'],
  email_digest_preference TEXT DEFAULT 'real_time' CHECK (email_digest_preference IN ('real_time', 'daily', 'weekly', 'never')),
  subscribed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(issue_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_issue_watches_issue ON issue_watches(issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_watches_user ON issue_watches(user_id);

-- =============================================================
-- RLS policies
-- =============================================================
ALTER TABLE issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE issue_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE issue_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE issue_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE issue_watches ENABLE ROW LEVEL SECURITY;

-- Issues: project members can CRUD
CREATE POLICY "Project members can manage issues"
  ON issues FOR ALL
  USING (project_id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid()));

-- Issue attachments: via issue -> project membership
CREATE POLICY "Project members can manage issue attachments"
  ON issue_attachments FOR ALL
  USING (issue_id IN (SELECT id FROM issues WHERE project_id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid())));

-- Issue comments: via issue -> project membership
CREATE POLICY "Project members can manage issue comments"
  ON issue_comments FOR ALL
  USING (issue_id IN (SELECT id FROM issues WHERE project_id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid())));

-- Issue links: via source issue -> project membership
CREATE POLICY "Project members can manage issue links"
  ON issue_links FOR ALL
  USING (source_issue_id IN (SELECT id FROM issues WHERE project_id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid())));

-- Issue watches: users manage their own watches
CREATE POLICY "Users can manage their own watches"
  ON issue_watches FOR ALL
  USING (user_id = auth.uid());

-- =============================================================
-- Supabase Storage bucket for issue evidence
-- =============================================================
-- Note: Storage bucket creation requires Supabase dashboard or management API
-- Bucket name: issue-evidence
-- Access: private (RLS via storage policies)

-- =============================================================
-- updated_at trigger
-- =============================================================
CREATE OR REPLACE FUNCTION update_issues_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER issues_updated_at
  BEFORE UPDATE ON issues
  FOR EACH ROW EXECUTE FUNCTION update_issues_updated_at();

CREATE OR REPLACE FUNCTION update_issue_comments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER issue_comments_updated_at
  BEFORE UPDATE ON issue_comments
  FOR EACH ROW EXECUTE FUNCTION update_issue_comments_updated_at();
