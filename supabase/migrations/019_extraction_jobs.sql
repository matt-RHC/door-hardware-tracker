-- Migration 019: Background extraction jobs
--
-- Adds extraction_jobs and job_user_constraints tables to support
-- server-side background extraction pipeline (Phase 1).

-- ─── extraction_jobs ─────────────────────────────────────────────

CREATE TABLE extraction_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by      UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued', 'classifying', 'detecting_columns', 'extracting',
      'triaging', 'validating', 'writing_staging', 'completed', 'failed', 'cancelled'
    )),
  progress        SMALLINT NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  status_message  TEXT,
  pdf_storage_path TEXT NOT NULL,
  pdf_hash        TEXT,
  pdf_page_count  INTEGER,
  extraction_run_id UUID REFERENCES extraction_runs(id) ON DELETE SET NULL,
  classify_result    JSONB,
  detect_result      JSONB,
  extraction_summary JSONB,
  constraint_flags   JSONB DEFAULT '[]'::jsonb,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  duration_ms     INTEGER,
  error_message   TEXT,
  error_phase     TEXT,
  retry_count     SMALLINT DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_extraction_jobs_project ON extraction_jobs(project_id);
CREATE INDEX idx_extraction_jobs_status ON extraction_jobs(status);
CREATE INDEX idx_extraction_jobs_created_by ON extraction_jobs(created_by);
CREATE INDEX idx_extraction_jobs_queued ON extraction_jobs(status, created_at) WHERE status = 'queued';

ALTER TABLE extraction_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Project members can view jobs" ON extraction_jobs FOR SELECT
  USING (project_id IN (
    SELECT project_id FROM project_members WHERE user_id = (SELECT auth.uid())
  ));

CREATE POLICY "Project members can create jobs" ON extraction_jobs FOR INSERT
  WITH CHECK (project_id IN (
    SELECT project_id FROM project_members WHERE user_id = (SELECT auth.uid())
  ));

CREATE POLICY "Job creator or admin can update" ON extraction_jobs FOR UPDATE
  USING (
    created_by = (SELECT auth.uid())
    OR project_id IN (
      SELECT project_id FROM project_members
      WHERE user_id = (SELECT auth.uid()) AND role = 'admin'
    )
  );

-- ─── job_user_constraints ────────────────────────────────────────

CREATE TABLE job_user_constraints (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES extraction_jobs(id) ON DELETE CASCADE,
  question_key    TEXT NOT NULL,
  answer_value    JSONB NOT NULL,
  answered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, question_key)
);

CREATE INDEX idx_job_constraints_job ON job_user_constraints(job_id);

ALTER TABLE job_user_constraints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Job participants can view constraints" ON job_user_constraints FOR SELECT
  USING (job_id IN (
    SELECT id FROM extraction_jobs WHERE project_id IN (
      SELECT project_id FROM project_members WHERE user_id = (SELECT auth.uid())
    )
  ));

CREATE POLICY "Job participants can upsert constraints" ON job_user_constraints FOR INSERT
  WITH CHECK (job_id IN (
    SELECT id FROM extraction_jobs WHERE project_id IN (
      SELECT project_id FROM project_members WHERE user_id = (SELECT auth.uid())
    )
  ));

CREATE POLICY "Job participants can update constraints" ON job_user_constraints FOR UPDATE
  USING (job_id IN (
    SELECT id FROM extraction_jobs WHERE project_id IN (
      SELECT project_id FROM project_members WHERE user_id = (SELECT auth.uid())
    )
  ));

-- ─── Link extraction_runs to jobs ────────────────────────────────

ALTER TABLE extraction_runs ADD COLUMN IF NOT EXISTS job_id UUID REFERENCES extraction_jobs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_extraction_runs_job ON extraction_runs(job_id);
