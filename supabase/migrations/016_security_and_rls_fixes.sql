-- Migration 016: Security hardening and RLS fixes
--
-- Addresses audit findings:
--   #4  — project_members SELECT only sees own row (widened to project scope)
--   #5  — promote_extraction checks membership not admin role
--   #6  — promote_extraction + cleanup_old_staging mutable search_path
--   #7  — tracking_items RLS enabled but no policies (documented as service-role-only)
--   #17 — auth.uid() not wrapped in (select auth.uid()) on RLS policies (init plan perf)
--   #18 — cleanup_old_staging does not purge punchy_logs
--
-- All policy changes use (select auth.uid()) per Supabase recommendation to
-- avoid re-evaluating auth functions per row:
-- https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select

-- ─────────────────────────────────────────────────────────────────────────────
-- Finding #4: project_members SELECT policy — widen to project scope
-- ─────────────────────────────────────────────────────────────────────────────
-- Old: auth.uid() = user_id  (can only see own row)
-- New: any member of the same project can see all members of that project

DROP POLICY IF EXISTS "Project members can view members" ON public.project_members;

CREATE POLICY "Project members can view members"
  ON public.project_members FOR SELECT
  USING (
    project_id IN (
      SELECT pm2.project_id FROM public.project_members pm2
      WHERE pm2.user_id = (SELECT auth.uid())
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Finding #17: Wrap auth.uid() in (select auth.uid()) on all affected policies
-- This prevents Postgres from re-evaluating auth.uid() for every row scanned.
-- ─────────────────────────────────────────────────────────────────────────────

-- projects
DROP POLICY IF EXISTS "Users can view projects they are members of" ON public.projects;
CREATE POLICY "Users can view projects they are members of"
  ON public.projects FOR SELECT
  USING (
    (SELECT auth.uid()) IN (
      SELECT project_members.user_id FROM public.project_members
      WHERE project_members.project_id = projects.id
    )
  );

DROP POLICY IF EXISTS "Authenticated users can create projects" ON public.projects;
CREATE POLICY "Authenticated users can create projects"
  ON public.projects FOR INSERT
  WITH CHECK ((SELECT auth.uid()) = created_by);

DROP POLICY IF EXISTS "Project admins can update projects" ON public.projects;
CREATE POLICY "Project admins can update projects"
  ON public.projects FOR UPDATE
  USING (
    (SELECT auth.uid()) IN (
      SELECT project_members.user_id FROM public.project_members
      WHERE project_members.project_id = projects.id
        AND project_members.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Project admins can delete projects" ON public.projects;
CREATE POLICY "Project admins can delete projects"
  ON public.projects FOR DELETE
  USING (
    (SELECT auth.uid()) IN (
      SELECT project_members.user_id FROM public.project_members
      WHERE project_members.project_id = projects.id
        AND project_members.role = 'admin'
    )
  );

-- project_members (admin policies)
DROP POLICY IF EXISTS "Project admins can add members" ON public.project_members;
CREATE POLICY "Project admins can add members"
  ON public.project_members FOR INSERT
  WITH CHECK (
    (SELECT auth.uid()) IN (
      SELECT pm.user_id FROM public.project_members pm
      WHERE pm.project_id = project_members.project_id
        AND pm.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Project admins can update members" ON public.project_members;
CREATE POLICY "Project admins can update members"
  ON public.project_members FOR UPDATE
  USING (
    (SELECT auth.uid()) IN (
      SELECT pm.user_id FROM public.project_members pm
      WHERE pm.project_id = project_members.project_id
        AND pm.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Project admins can remove members" ON public.project_members;
CREATE POLICY "Project admins can remove members"
  ON public.project_members FOR DELETE
  USING (
    (SELECT auth.uid()) IN (
      SELECT pm.user_id FROM public.project_members pm
      WHERE pm.project_id = project_members.project_id
        AND pm.role = 'admin'
    )
  );

-- openings
DROP POLICY IF EXISTS "Project members can view openings" ON public.openings;
CREATE POLICY "Project members can view openings"
  ON public.openings FOR SELECT
  USING (
    (SELECT auth.uid()) IN (
      SELECT project_members.user_id FROM public.project_members
      WHERE project_members.project_id = openings.project_id
    )
  );

DROP POLICY IF EXISTS "Project members can create openings" ON public.openings;
CREATE POLICY "Project members can create openings"
  ON public.openings FOR INSERT
  WITH CHECK (
    (SELECT auth.uid()) IN (
      SELECT project_members.user_id FROM public.project_members
      WHERE project_members.project_id = openings.project_id
    )
  );

DROP POLICY IF EXISTS "Project members can update openings" ON public.openings;
CREATE POLICY "Project members can update openings"
  ON public.openings FOR UPDATE
  USING (
    (SELECT auth.uid()) IN (
      SELECT project_members.user_id FROM public.project_members
      WHERE project_members.project_id = openings.project_id
    )
  );

DROP POLICY IF EXISTS "Project admins can delete openings" ON public.openings;
CREATE POLICY "Project admins can delete openings"
  ON public.openings FOR DELETE
  USING (
    (SELECT auth.uid()) IN (
      SELECT project_members.user_id FROM public.project_members
      WHERE project_members.project_id = openings.project_id
        AND project_members.role = 'admin'
    )
  );

-- hardware_items
DROP POLICY IF EXISTS "Project members can view hardware items" ON public.hardware_items;
CREATE POLICY "Project members can view hardware items"
  ON public.hardware_items FOR SELECT
  USING (
    (SELECT auth.uid()) IN (
      SELECT pm.user_id FROM public.project_members pm
      JOIN public.openings o ON o.project_id = pm.project_id
      WHERE o.id = hardware_items.opening_id
    )
  );

DROP POLICY IF EXISTS "Project members can create hardware items" ON public.hardware_items;
CREATE POLICY "Project members can create hardware items"
  ON public.hardware_items FOR INSERT
  WITH CHECK (
    (SELECT auth.uid()) IN (
      SELECT pm.user_id FROM public.project_members pm
      JOIN public.openings o ON o.project_id = pm.project_id
      WHERE o.id = hardware_items.opening_id
    )
  );

DROP POLICY IF EXISTS "Project members can update hardware items" ON public.hardware_items;
CREATE POLICY "Project members can update hardware items"
  ON public.hardware_items FOR UPDATE
  USING (
    (SELECT auth.uid()) IN (
      SELECT pm.user_id FROM public.project_members pm
      JOIN public.openings o ON o.project_id = pm.project_id
      WHERE o.id = hardware_items.opening_id
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Finding #5: promote_extraction — add admin role check
-- Finding #6: Fix mutable search_path on both SECURITY DEFINER functions
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.promote_extraction(
  p_extraction_run_id UUID,
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  -- Verify user is a project ADMIN (finding #5: was member-only, now requires admin role)
  IF NOT EXISTS (
    SELECT 1 FROM project_members
    WHERE project_id = v_project_id
      AND user_id = p_user_id
      AND role = 'admin'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'User must be a project admin to promote extraction');
  END IF;

  -- Guard: ensure all staging openings have items before promoting.
  -- An orphaned opening (items insert failed mid-write) would produce a
  -- production door with no hardware — silently wrong data.
  IF EXISTS (
    SELECT 1 FROM staging_openings so
    LEFT JOIN staging_hardware_items shi ON shi.staging_opening_id = so.id
    WHERE so.extraction_run_id = p_extraction_run_id
      AND shi.id IS NULL
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Extraction run has openings with no hardware items. Re-extract or contact support.'
    );
  END IF;

  -- Delete existing production openings (cascade deletes hardware_items, checklist_progress)
  DELETE FROM openings WHERE project_id = v_project_id;

  -- Insert staging openings -> production openings, track ID mapping
  FOR v_staging_opening IN
    SELECT * FROM staging_openings
    WHERE extraction_run_id = p_extraction_run_id
    ORDER BY door_number
  LOOP
    INSERT INTO openings (project_id, door_number, hw_set, hw_heading, location,
                          door_type, frame_type, fire_rating, hand, notes, pdf_page,
                          leaf_count)
    VALUES (v_project_id, v_staging_opening.door_number, v_staging_opening.hw_set,
            v_staging_opening.hw_heading, v_staging_opening.location,
            v_staging_opening.door_type, v_staging_opening.frame_type,
            v_staging_opening.fire_rating, v_staging_opening.hand,
            v_staging_opening.notes, v_staging_opening.pdf_page,
            COALESCE(v_staging_opening.leaf_count, 1))
    RETURNING id INTO v_new_opening_id;

    -- Map staging_opening.id -> new production opening.id
    v_opening_map := v_opening_map || jsonb_build_object(
      v_staging_opening.id::text, v_new_opening_id::text
    );
    v_openings_count := v_openings_count + 1;
  END LOOP;

  -- Insert staging hardware items -> production hardware items (now with leaf_side)
  INSERT INTO hardware_items (opening_id, name, qty, qty_total, qty_door_count, qty_source, manufacturer, model, finish, options, sort_order, leaf_side)
  SELECT
    (v_opening_map ->> shi.staging_opening_id::text)::uuid,
    shi.name, shi.qty, shi.qty_total, shi.qty_door_count, shi.qty_source,
    shi.manufacturer, shi.model, shi.finish, shi.options, shi.sort_order,
    shi.leaf_side
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

-- ─────────────────────────────────────────────────────────────────────────────
-- Finding #6 + #18: Fix search_path on cleanup_old_staging and extend to
-- purge punchy_logs older than the retention window
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.cleanup_old_staging(
  p_retention_days INTEGER DEFAULT 30
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  -- Purge punchy_logs older than retention window (finding #18)
  DELETE FROM punchy_logs
  WHERE created_at < now() - (p_retention_days || ' days')::interval;

  -- Purge orphaned staging rows from abandoned extraction runs
  -- (runs that never reached promoted/rejected/failed but are stale)
  DELETE FROM staging_hardware_items
  WHERE extraction_run_id IN (
    SELECT id FROM extraction_runs
    WHERE status IN ('pending', 'extracting', 'reviewing', 'completed_with_issues')
      AND created_at < now() - (p_retention_days || ' days')::interval
  );

  DELETE FROM staging_openings
  WHERE extraction_run_id IN (
    SELECT id FROM extraction_runs
    WHERE status IN ('pending', 'extracting', 'reviewing', 'completed_with_issues')
      AND created_at < now() - (p_retention_days || ' days')::interval
  );

  -- Purge terminal extraction runs
  DELETE FROM extraction_runs
  WHERE status IN ('promoted', 'rejected', 'failed')
    AND created_at < now() - (p_retention_days || ' days')::interval;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Finding #7: tracking_items — RLS on, no policies
-- This table is intentionally service-role-only (internal audit/tracking).
-- Add a comment to document intent rather than open up client access.
-- ─────────────────────────────────────────────────────────────────────────────
COMMENT ON TABLE public.tracking_items IS
  'Internal audit/tracking table. Intentionally service-role-only — '
  'RLS is enabled with no client-facing policies. All access must go '
  'through server-side code using the service role key.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes for unindexed foreign keys flagged by Supabase advisor (finding #16)
-- Using CONCURRENTLY to avoid locking in production
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_project_members_user_id
  ON public.project_members(user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_projects_created_by
  ON public.projects(created_by);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_extraction_runs_created_by
  ON public.extraction_runs(created_by);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_extraction_runs_promoted_by
  ON public.extraction_runs(promoted_by);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_extraction_decisions_created_by
  ON public.extraction_decisions(created_by);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_extraction_corrections_project_id
  ON public.extraction_corrections(project_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_extraction_corrections_corrected_by
  ON public.extraction_corrections(corrected_by);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attachments_uploaded_by
  ON public.attachments(uploaded_by);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issues_hardware_item_id
  ON public.issues(hardware_item_id);

