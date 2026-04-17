-- ============================================================================
-- Migration 010: Per-opening PDF page reference
-- ============================================================================
-- Adds a nullable pdf_page column to openings and staging_openings so that
-- every door row can remember which page of the project's submittal PDF its
-- hardware set was defined on. This backs the "click an opening → jump to
-- the PDF page" UX on the project dashboard and door detail view.
--
-- The column is 0-based to match the classify-pages page index used by
-- findPageForSet (src/lib/punch-cards.ts:48). Existing rows will have NULL
-- (no backfill) until their project's PDF is re-imported through the wizard.
--
-- Also updates the promote_extraction() stored function so the value flows
-- from staging_openings → openings on auto-promote. The function body is
-- unchanged apart from adding pdf_page to the INSERT column list.
-- ============================================================================

ALTER TABLE openings
  ADD COLUMN IF NOT EXISTS pdf_page INTEGER;

ALTER TABLE staging_openings
  ADD COLUMN IF NOT EXISTS pdf_page INTEGER;

COMMENT ON COLUMN openings.pdf_page IS
  '0-based page index of the project submittal PDF where this opening''s '
  'hardware set is defined. NULL if unknown (e.g., extraction predates '
  'migration 010 or hw_set was not matched to a page).';

COMMENT ON COLUMN staging_openings.pdf_page IS
  '0-based page index of the project submittal PDF where this opening''s '
  'hardware set is defined. Copied to openings.pdf_page on promote.';

-- ============================================================================
-- Update promote_extraction() to propagate pdf_page through.
-- Body is identical to the definition in migration 007 apart from the added
-- pdf_page column in the INSERT statement.
-- ============================================================================

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
                          door_type, frame_type, fire_rating, hand, notes, pdf_page)
    VALUES (v_project_id, v_staging_opening.door_number, v_staging_opening.hw_set,
            v_staging_opening.hw_heading, v_staging_opening.location,
            v_staging_opening.door_type, v_staging_opening.frame_type,
            v_staging_opening.fire_rating, v_staging_opening.hand,
            v_staging_opening.notes, v_staging_opening.pdf_page)
    RETURNING id INTO v_new_opening_id;

    -- Map staging_opening.id → new production opening.id
    v_opening_map := v_opening_map || jsonb_build_object(
      v_staging_opening.id::text, v_new_opening_id::text
    );
    v_openings_count := v_openings_count + 1;
  END LOOP;

  -- Insert staging hardware items → production hardware items
  INSERT INTO hardware_items (opening_id, name, qty, qty_total, qty_door_count, qty_source, manufacturer, model, finish, options, sort_order)
  SELECT
    (v_opening_map ->> shi.staging_opening_id::text)::uuid,
    shi.name, shi.qty, shi.qty_total, shi.qty_door_count, shi.qty_source,
    shi.manufacturer, shi.model, shi.finish, shi.options, shi.sort_order
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
