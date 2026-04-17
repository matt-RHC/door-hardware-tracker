-- Migration 022: Activity log for audit trail
--
-- Records who did what, when, and to which entity. Critical for:
-- - Tracing quantity discrepancies back to extraction vs Punchy vs manual edit
-- - Accountability when construction teams dispute hardware counts
-- - General "what happened to this project" visibility

CREATE TABLE activity_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   UUID,
  details     JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Actions include:
--   'extraction_promoted'       — staging data promoted to live
--   'extraction_job_created'    — new extraction job queued
--   'extraction_job_completed'  — extraction job finished
--   'extraction_job_failed'     — extraction job failed
--   'item_edited'               — hardware item manually edited
--   'item_deleted'              — hardware item deleted
--   'opening_edited'            — opening manually edited
--   'opening_deleted'           — opening deleted
--   'punchy_correction_applied' — Punchy's suggested correction was accepted
--   'punchy_correction_rejected'— Punchy's suggested correction was rejected
--   'member_added'              — project member added
--   'member_removed'            — project member removed
--   'member_role_changed'       — project member role changed

COMMENT ON TABLE activity_log IS 'Audit trail: who did what, when, to which entity.';
COMMENT ON COLUMN activity_log.action IS 'Machine-readable action type (see migration comments for enum).';
COMMENT ON COLUMN activity_log.entity_type IS 'Table name of the affected entity: opening, hardware_item, project, extraction_job, project_member.';
COMMENT ON COLUMN activity_log.entity_id IS 'Primary key of the affected row.';
COMMENT ON COLUMN activity_log.details IS 'Action-specific payload. For edits: {old: {...}, new: {...}}. For extractions: {run_id, item_count}.';

CREATE INDEX idx_activity_log_project ON activity_log(project_id, created_at DESC);
CREATE INDEX idx_activity_log_entity ON activity_log(entity_type, entity_id);
CREATE INDEX idx_activity_log_user ON activity_log(user_id);

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

-- Project members can view activity for their projects
CREATE POLICY "Project members can view activity"
  ON activity_log FOR SELECT
  USING (
    project_id IN (
      SELECT project_id FROM project_members
      WHERE user_id = (SELECT auth.uid())
    )
  );

-- Only service role inserts activity log entries (from API routes)
-- No INSERT policy for regular users — the API uses the service role client
-- to write audit entries, ensuring they can't be tampered with.
