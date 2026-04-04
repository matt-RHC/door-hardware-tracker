-- ============================================================================
-- EXTRACTION STAGING & RUNS
-- ============================================================================
-- Provides a staging layer so extraction results can be reviewed before
-- promoting to production tables (openings, hardware_items).
-- Tracks each extraction attempt with timing, accuracy, and error details.

-- --- Extraction Runs ---
-- One row per extraction attempt (upload or re-upload).
CREATE TABLE extraction_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'extracting', 'reviewing', 'promoted', 'rejected', 'failed', 'completed_with_issues')),

  -- Source PDF info
  pdf_storage_path TEXT,          -- Supabase Storage path
  pdf_hash TEXT,                  -- SHA-256 for dedup
  pdf_page_count INTEGER,
  pdf_source_type TEXT,           -- 'comsense' | 's4h' | 'word_excel' | 'allegion' | 'assa_abloy' | 'scanned' | 'bluebeam' | 'unknown'

  -- Extraction metadata
  extraction_method TEXT,         -- 'pdfplumber' | 'pymupdf' | 'claude_vision' | 'hybrid'
  confidence TEXT DEFAULT 'medium' CHECK (confidence IN ('high', 'medium', 'low')),
  confidence_score NUMERIC(4,3), -- 0.000 to 1.000 composite score

  -- Counts
  doors_extracted INTEGER DEFAULT 0,
  doors_flagged INTEGER DEFAULT 0,
  hw_sets_extracted INTEGER DEFAULT 0,
  reference_codes_extracted INTEGER DEFAULT 0,

  -- Timing
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,            -- total extraction time

  -- Error tracking
  error_message TEXT,
  extraction_notes TEXT[],        -- array of human-readable notes

  -- Audit
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  promoted_at TIMESTAMPTZ,
  promoted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX extraction_runs_project_id_idx ON extraction_runs(project_id);
CREATE INDEX extraction_runs_status_idx ON extraction_runs(status);

-- --- Staging Openings ---
-- Mirrors the openings table schema, plus extraction_run_id.
CREATE TABLE staging_openings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_run_id UUID NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
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

  -- Staging-specific fields
  is_flagged BOOLEAN DEFAULT false,
  flag_reason TEXT,
  field_confidence JSONB,         -- per-field confidence scores: {"hw_set": 0.95, "location": 0.87, ...}
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX staging_openings_run_id_idx ON staging_openings(extraction_run_id);
CREATE INDEX staging_openings_project_id_idx ON staging_openings(project_id);

-- --- Staging Hardware Items ---
-- Mirrors hardware_items but linked to staging_openings.
CREATE TABLE staging_hardware_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staging_opening_id UUID NOT NULL REFERENCES staging_openings(id) ON DELETE CASCADE,
  extraction_run_id UUID NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  qty INTEGER DEFAULT 1,
  qty_total INTEGER,              -- raw total from PDF
  qty_door_count INTEGER,         -- openings in set (divisor)
  qty_source TEXT,                -- "parsed" | "divided" | "flagged" | "capped"
  manufacturer TEXT,
  model TEXT,
  finish TEXT,
  options TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX staging_hw_items_opening_id_idx ON staging_hardware_items(staging_opening_id);
CREATE INDEX staging_hw_items_run_id_idx ON staging_hardware_items(extraction_run_id);

-- --- Extraction Corrections ---
-- Tracks every user correction for feedback loop / accuracy measurement.
CREATE TABLE extraction_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_run_id UUID NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  door_number TEXT,
  field_name TEXT NOT NULL,       -- 'hw_set', 'location', 'qty', 'model', etc.
  original_value TEXT,
  corrected_value TEXT,
  correction_type TEXT DEFAULT 'wrong_value'
    CHECK (correction_type IN ('wrong_value', 'missing_value', 'extra_value', 'wrong_column', 'split_error', 'merge_error', 'formatting')),
  corrected_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  corrected_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX extraction_corrections_run_id_idx ON extraction_corrections(extraction_run_id);
CREATE INDEX extraction_corrections_field_idx ON extraction_corrections(field_name);

-- ============================================================================
-- RLS POLICIES
-- ============================================================================

ALTER TABLE extraction_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE staging_openings ENABLE ROW LEVEL SECURITY;
ALTER TABLE staging_hardware_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_corrections ENABLE ROW LEVEL SECURITY;

-- extraction_runs: project members can view, create
CREATE POLICY "Project members can view extraction runs"
  ON extraction_runs FOR SELECT
  USING (auth.uid() IN (
    SELECT user_id FROM project_members WHERE project_id = extraction_runs.project_id
  ));

CREATE POLICY "Project members can create extraction runs"
  ON extraction_runs FOR INSERT
  WITH CHECK (auth.uid() IN (
    SELECT user_id FROM project_members WHERE project_id = extraction_runs.project_id
  ));

CREATE POLICY "Project members can update extraction runs"
  ON extraction_runs FOR UPDATE
  USING (auth.uid() IN (
    SELECT user_id FROM project_members WHERE project_id = extraction_runs.project_id
  ));

-- staging_openings: project members
CREATE POLICY "Project members can view staging openings"
  ON staging_openings FOR SELECT
  USING (auth.uid() IN (
    SELECT user_id FROM project_members WHERE project_id = staging_openings.project_id
  ));

CREATE POLICY "Project members can create staging openings"
  ON staging_openings FOR INSERT
  WITH CHECK (auth.uid() IN (
    SELECT user_id FROM project_members WHERE project_id = staging_openings.project_id
  ));

-- staging_hardware_items: via extraction_run
CREATE POLICY "Project members can view staging hw items"
  ON staging_hardware_items FOR SELECT
  USING (auth.uid() IN (
    SELECT pm.user_id FROM project_members pm
    JOIN extraction_runs er ON er.project_id = pm.project_id
    WHERE er.id = staging_hardware_items.extraction_run_id
  ));

CREATE POLICY "Project members can create staging hw items"
  ON staging_hardware_items FOR INSERT
  WITH CHECK (auth.uid() IN (
    SELECT pm.user_id FROM project_members pm
    JOIN extraction_runs er ON er.project_id = pm.project_id
    WHERE er.id = staging_hardware_items.extraction_run_id
  ));

-- extraction_corrections: project members
CREATE POLICY "Project members can view corrections"
  ON extraction_corrections FOR SELECT
  USING (auth.uid() IN (
    SELECT user_id FROM project_members WHERE project_id = extraction_corrections.project_id
  ));

CREATE POLICY "Project members can create corrections"
  ON extraction_corrections FOR INSERT
  WITH CHECK (auth.uid() IN (
    SELECT user_id FROM project_members WHERE project_id = extraction_corrections.project_id
  ));

-- ============================================================================
-- PROMOTE EXTRACTION RPC
-- ============================================================================
-- Atomically moves staging data → production tables.
-- Deletes existing project openings (cascade) and inserts from staging.
-- Updates extraction_run status to 'promoted'.
-- Returns the count of promoted openings and items.

CREATE OR REPLACE FUNCTION promote_extraction(
  p_extraction_run_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_project_id UUID;
  v_status TEXT;
  v_openings_count INTEGER := 0;
  v_items_count INTEGER := 0;
  v_opening_map JSONB := '{}';
  v_staging_opening RECORD;
  v_new_opening_id UUID;
BEGIN
  -- Validate the extraction run exists and is in a promotable state
  SELECT project_id, status INTO v_project_id, v_status
  FROM extraction_runs
  WHERE id = p_extraction_run_id;

  IF v_project_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Extraction run not found');
  END IF;

  IF v_status NOT IN ('reviewing', 'completed_with_issues') THEN
    RETURN jsonb_build_object('success', false, 'error',
      format('Cannot promote extraction in status "%s". Must be "reviewing" or "completed_with_issues".', v_status));
  END IF;

  -- Verify user is a project member
  IF NOT EXISTS (
    SELECT 1 FROM project_members
    WHERE project_id = v_project_id AND user_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'User is not a project member');
  END IF;

  -- Delete existing production openings (cascade deletes hardware_items, checklist_progress)
  DELETE FROM openings WHERE project_id = v_project_id;

  -- Insert staging openings → production openings, track ID mapping
  FOR v_staging_opening IN
    SELECT * FROM staging_openings
    WHERE extraction_run_id = p_extraction_run_id
    ORDER BY door_number
  LOOP
    INSERT INTO openings (project_id, door_number, hw_set, hw_heading, location,
                          door_type, frame_type, fire_rating, hand, notes)
    VALUES (v_project_id, v_staging_opening.door_number, v_staging_opening.hw_set,
            v_staging_opening.hw_heading, v_staging_opening.location,
            v_staging_opening.door_type, v_staging_opening.frame_type,
            v_staging_opening.fire_rating, v_staging_opening.hand,
            v_staging_opening.notes)
    RETURNING id INTO v_new_opening_id;

    -- Map staging_opening.id → new production opening.id
    v_opening_map := v_opening_map || jsonb_build_object(
      v_staging_opening.id::text, v_new_opening_id::text
    );
    v_openings_count := v_openings_count + 1;
  END LOOP;

  -- Insert staging hardware items → production hardware items
  INSERT INTO hardware_items (opening_id, name, qty, manufacturer, model, finish, options, sort_order)
  SELECT
    (v_opening_map ->> shi.staging_opening_id::text)::uuid,
    shi.name, shi.qty, shi.manufacturer, shi.model, shi.finish, shi.options, shi.sort_order
  FROM staging_hardware_items shi
  WHERE shi.extraction_run_id = p_extraction_run_id
    AND v_opening_map ? shi.staging_opening_id::text;

  GET DIAGNOSTICS v_items_count = ROW_COUNT;

  -- Update extraction run status
  UPDATE extraction_runs
  SET status = 'promoted',
      promoted_at = now(),
      promoted_by = p_user_id
  WHERE id = p_extraction_run_id;

  RETURN jsonb_build_object(
    'success', true,
    'openings_promoted', v_openings_count,
    'items_promoted', v_items_count,
    'project_id', v_project_id
  );

EXCEPTION WHEN OTHERS THEN
  -- On any error, the entire transaction rolls back automatically
  RETURN jsonb_build_object(
    'success', false,
    'error', SQLERRM
  );
END;
$$;

-- ============================================================================
-- CLEANUP: Remove old staging data (retention policy)
-- ============================================================================
-- Call this from a cron job or Supabase scheduled function.
-- Keeps staging data for 30 days after promotion or rejection.

CREATE OR REPLACE FUNCTION cleanup_old_staging(p_retention_days INTEGER DEFAULT 30)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  -- Delete extraction runs (cascade deletes staging_openings, staging_hardware_items)
  DELETE FROM extraction_runs
  WHERE status IN ('promoted', 'rejected', 'failed')
    AND created_at < now() - (p_retention_days || ' days')::interval;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;
