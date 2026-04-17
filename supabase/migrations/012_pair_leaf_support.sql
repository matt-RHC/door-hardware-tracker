-- ============================================================================
-- Migration 012: Pair-door leaf support
-- ============================================================================
-- Phase 2 of pair-door handling. Adds per-opening leaf_count so the UI can
-- render Shared / Leaf 1 / Leaf 2 sections on pair-door detail pages, and
-- per-leaf checklist progress so installers can mark each leaf independently.
--
-- Phase 1 (PR #112) doubled per-leaf quantities at save time. Phase 2 reverts
-- that doubling — quantities are stored per-leaf, and the UI splits visually.
-- ============================================================================

-- 1. Add leaf_count to openings (1 = single, 2 = pair)
ALTER TABLE openings
  ADD COLUMN IF NOT EXISTS leaf_count INTEGER NOT NULL DEFAULT 1;

-- 2. Add leaf_count to staging_openings (flows to openings via promote)
ALTER TABLE staging_openings
  ADD COLUMN IF NOT EXISTS leaf_count INTEGER NOT NULL DEFAULT 1;

-- 3. Add leaf_index to checklist_progress for per-leaf tracking
ALTER TABLE checklist_progress
  ADD COLUMN IF NOT EXISTS leaf_index INTEGER NOT NULL DEFAULT 1;

-- Replace the old two-column unique with a three-column unique.
-- Existing rows all have leaf_index=1 so no conflicts.
ALTER TABLE checklist_progress
  DROP CONSTRAINT IF EXISTS checklist_progress_opening_id_item_id_key;

ALTER TABLE checklist_progress
  ADD CONSTRAINT checklist_progress_opening_item_leaf_key
  UNIQUE(opening_id, item_id, leaf_index);

COMMENT ON COLUMN openings.leaf_count IS
  'Number of door leaves in this opening. 1 = single, 2 = pair. '
  'Set from detectIsPair() at import time. Default 1 for legacy data.';

COMMENT ON COLUMN staging_openings.leaf_count IS
  'Number of door leaves. Copied to openings.leaf_count on promote.';

COMMENT ON COLUMN checklist_progress.leaf_index IS
  'Which leaf this progress row applies to. 1 = Leaf 1 (or single door), '
  '2 = Leaf 2. Shared items (per_pair, per_frame) always use 1.';

-- ============================================================================
-- 4. Update promote_extraction() to propagate leaf_count.
-- Body is identical to the definition in migration 010 apart from the added
-- leaf_count column in the INSERT statement.
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

  -- Insert staging hardware items -> production hardware items
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
