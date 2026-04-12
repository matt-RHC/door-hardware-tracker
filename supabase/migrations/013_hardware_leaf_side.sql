-- ============================================================================
-- Migration 013: Per-item leaf_side attribution
-- ============================================================================
-- Phase 3 of the groovy-tumbling-backus mapping cleanup. Today, active /
-- inactive / shared classification runs every render via
-- `src/lib/classify-leaf-items.ts::groupItemsByLeaf` using taxonomy regex on
-- each item name. This migration adds a persisted attribution column so:
--
--   1. Punchy's post-extraction review can see which leaf each item is on
--      and reason about pair-door rules (active-leaf lockset, inactive-leaf
--      flush bolts, etc.) directly from the data it sees.
--   2. The door detail page reads `leaf_side` from the DB instead of
--      recomputing on every render.
--   3. A future triage UI can let the user override per-item attribution
--      when the automatic classification is wrong.
--
-- NULL remains a valid value and means "unset — fall back to render-time
-- classification." This lets existing rows continue working without a full
-- backfill and lets the save path populate only unambiguous cases for now,
-- leaving the ambiguous per_leaf / per_opening pair-door cases for the
-- triage UI in a follow-up.
-- ============================================================================

-- 1. Add leaf_side to hardware_items with a CHECK constraint on the values.
ALTER TABLE hardware_items
  ADD COLUMN IF NOT EXISTS leaf_side TEXT NULL
  CHECK (leaf_side IS NULL OR leaf_side IN ('active', 'inactive', 'shared', 'both'));

-- 2. Mirror on staging_hardware_items so promote_extraction can carry it over.
ALTER TABLE staging_hardware_items
  ADD COLUMN IF NOT EXISTS leaf_side TEXT NULL
  CHECK (leaf_side IS NULL OR leaf_side IN ('active', 'inactive', 'shared', 'both'));

COMMENT ON COLUMN hardware_items.leaf_side IS
  'Which door leaf this item belongs to on pair-door openings. '
  '''active'' = active leaf only (lockset, exit device on most pairs). '
  '''inactive'' = inactive leaf only (flush bolts). '
  '''shared'' = one per opening, not per leaf (coordinator, threshold, astragal). '
  '''both'' = present on each leaf with its own row (hinges, closers). '
  'NULL = unset; render-time classify-leaf-items.ts falls back to the '
  'taxonomy regex. Populated at save time for unambiguous cases (structural '
  'Door/Frame rows, per_pair and per_frame scope items). Ambiguous cases '
  '(per_leaf / per_opening on pairs) stay NULL until a user overrides via '
  'the triage UI.';

COMMENT ON COLUMN staging_hardware_items.leaf_side IS
  'Copied to hardware_items.leaf_side on promote. See that column for semantics.';

-- 3. Backfill for existing rows where the answer is unambiguous from the
--    row name alone. Leaves everything else at NULL.
UPDATE hardware_items
SET leaf_side = 'shared'
WHERE leaf_side IS NULL
  AND name = 'Frame';

UPDATE hardware_items
SET leaf_side = 'active'
WHERE leaf_side IS NULL
  AND name = 'Door (Active Leaf)';

UPDATE hardware_items
SET leaf_side = 'inactive'
WHERE leaf_side IS NULL
  AND name = 'Door (Inactive Leaf)';

-- Single-leaf openings: the sole Door row is implicitly 'active' (there is
-- no inactive leaf on a single). Attribute explicitly so the render path
-- doesn't have to special-case it.
UPDATE hardware_items hi
SET leaf_side = 'active'
FROM openings o
WHERE hi.opening_id = o.id
  AND hi.leaf_side IS NULL
  AND hi.name = 'Door'
  AND o.leaf_count = 1;

-- ============================================================================
-- 4. Update promote_extraction() to carry leaf_side from staging to production.
-- Body is identical to the definition in migration 012 apart from the added
-- leaf_side column in the INSERT.
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

  -- Insert staging hardware items -> production hardware items (now with leaf_side)
  INSERT INTO hardware_items (opening_id, name, qty, manufacturer, model, finish, options, sort_order, leaf_side)
  SELECT
    (v_opening_map ->> shi.staging_opening_id::text)::uuid,
    shi.name, shi.qty, shi.manufacturer, shi.model, shi.finish, shi.options, shi.sort_order,
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
