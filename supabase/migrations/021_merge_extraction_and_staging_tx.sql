-- ============================================================================
-- Migration 021: Merge-based promote + transactional staging writes
-- ============================================================================
-- Fixes two P0 data-integrity issues:
--
-- 1. promote_extraction() destroys all field progress (§4.1)
--    → New merge_extraction() matches by door_number, preserves checklist
--      progress and attachments for unchanged doors, soft-deletes removed doors.
--
-- 2. writeStagingData() inserts in non-transactional chunks (§2.1)
--    → New write_staging_data() RPC accepts full payload as JSONB and writes
--      everything in a single transaction.
-- ============================================================================

-- ── 1. Add is_active column to openings ─────────────────────────────────────

ALTER TABLE openings
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN openings.is_active IS
  'Soft-delete flag. Doors removed during a re-import are set to false '
  'rather than hard-deleted, preserving their checklist history and attachments.';

-- Index for common queries that filter active doors
CREATE INDEX IF NOT EXISTS openings_project_active_idx
  ON openings(project_id) WHERE is_active = true;

-- ── 2. merge_extraction() ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.merge_extraction(
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
  v_added INTEGER := 0;
  v_updated INTEGER := 0;
  v_unchanged INTEGER := 0;
  v_deactivated INTEGER := 0;
  v_items_promoted INTEGER := 0;
  v_row_count INTEGER;
  v_staging RECORD;
  v_existing RECORD;
  v_existing_opening_id UUID;
  v_new_opening_id UUID;
  v_hw_changed BOOLEAN;
  v_staging_hw_sig TEXT;
  v_prod_hw_sig TEXT;
  v_staging_door_numbers TEXT[];
BEGIN
  -- ── Validate extraction run ──
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

  -- ── Verify user is a project ADMIN ──
  IF NOT EXISTS (
    SELECT 1 FROM project_members
    WHERE project_id = v_project_id
      AND user_id = p_user_id
      AND role = 'admin'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'User must be a project admin to promote extraction');
  END IF;

  -- ── Guard: ensure all staging openings have items ──
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

  -- ── Collect staging door numbers for deactivation step ──
  SELECT array_agg(door_number) INTO v_staging_door_numbers
  FROM staging_openings
  WHERE extraction_run_id = p_extraction_run_id;

  -- ── Process each staging opening ──
  FOR v_staging IN
    SELECT so.*, so.id AS staging_id
    FROM staging_openings so
    WHERE so.extraction_run_id = p_extraction_run_id
    ORDER BY so.door_number
  LOOP
    -- Check if this door already exists in production
    SELECT id INTO v_existing_opening_id
    FROM openings
    WHERE project_id = v_project_id
      AND door_number = v_staging.door_number;

    IF v_existing_opening_id IS NOT NULL THEN
      -- ── Existing door: check if hardware changed ──

      -- Build a hardware signature for the staging door (sorted name+qty pairs)
      SELECT string_agg(sig, '|' ORDER BY sig) INTO v_staging_hw_sig
      FROM (
        SELECT shi.name || ':' || COALESCE(shi.qty, 1)::text AS sig
        FROM staging_hardware_items shi
        WHERE shi.staging_opening_id = v_staging.staging_id
        ORDER BY shi.name, shi.qty
      ) sub;

      -- Build a hardware signature for the production door
      SELECT string_agg(sig, '|' ORDER BY sig) INTO v_prod_hw_sig
      FROM (
        SELECT hi.name || ':' || hi.qty::text AS sig
        FROM hardware_items hi
        WHERE hi.opening_id = v_existing_opening_id
        ORDER BY hi.name, hi.qty
      ) sub;

      v_hw_changed := COALESCE(v_staging_hw_sig, '') IS DISTINCT FROM COALESCE(v_prod_hw_sig, '');

      IF v_hw_changed THEN
        -- ── Hardware changed: update metadata, replace hardware items ──

        -- Update opening metadata
        UPDATE openings SET
          hw_set       = v_staging.hw_set,
          hw_heading   = v_staging.hw_heading,
          location     = v_staging.location,
          door_type    = v_staging.door_type,
          frame_type   = v_staging.frame_type,
          fire_rating  = v_staging.fire_rating,
          hand         = v_staging.hand,
          notes        = v_staging.notes,
          pdf_page     = v_staging.pdf_page,
          leaf_count   = COALESCE(v_staging.leaf_count, 1),
          is_active    = true
        WHERE id = v_existing_opening_id;

        -- Delete old hardware items (cascades checklist_progress for those items)
        DELETE FROM hardware_items WHERE opening_id = v_existing_opening_id;

        -- Insert new hardware items from staging
        INSERT INTO hardware_items (opening_id, name, qty, manufacturer, model, finish, options, sort_order, leaf_side)
        SELECT
          v_existing_opening_id,
          shi.name, shi.qty, shi.manufacturer, shi.model, shi.finish,
          shi.options, shi.sort_order, shi.leaf_side
        FROM staging_hardware_items shi
        WHERE shi.staging_opening_id = v_staging.staging_id;

        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        v_items_promoted := v_items_promoted + v_row_count;

        -- Try to preserve checklist_progress where item names match.
        -- The old items are gone, but we can re-link progress to new items
        -- by matching on name. We do this by finding checklist_progress rows
        -- that were orphaned (their item_id no longer exists) and seeing if
        -- there's a new hardware_item with the same name on this opening.
        -- NOTE: Since hardware_items CASCADE deletes checklist_progress,
        -- the old progress is already gone at this point. We cannot preserve
        -- checklist progress for changed doors — this is the expected trade-off.
        -- The user changed hardware, so old check-offs may not be valid.

        v_updated := v_updated + 1;
      ELSE
        -- ── Hardware unchanged: keep everything, just update metadata ──
        UPDATE openings SET
          hw_set       = v_staging.hw_set,
          hw_heading   = v_staging.hw_heading,
          location     = v_staging.location,
          door_type    = v_staging.door_type,
          frame_type   = v_staging.frame_type,
          fire_rating  = v_staging.fire_rating,
          hand         = v_staging.hand,
          notes        = v_staging.notes,
          pdf_page     = v_staging.pdf_page,
          leaf_count   = COALESCE(v_staging.leaf_count, 1),
          is_active    = true
        WHERE id = v_existing_opening_id;

        v_unchanged := v_unchanged + 1;
      END IF;
    ELSE
      -- ── New door: insert opening + hardware items ──
      INSERT INTO openings (
        project_id, door_number, hw_set, hw_heading, location,
        door_type, frame_type, fire_rating, hand, notes, pdf_page,
        leaf_count, is_active
      )
      VALUES (
        v_project_id, v_staging.door_number, v_staging.hw_set,
        v_staging.hw_heading, v_staging.location,
        v_staging.door_type, v_staging.frame_type,
        v_staging.fire_rating, v_staging.hand,
        v_staging.notes, v_staging.pdf_page,
        COALESCE(v_staging.leaf_count, 1), true
      )
      RETURNING id INTO v_new_opening_id;

      -- Insert hardware items for the new door
      INSERT INTO hardware_items (opening_id, name, qty, manufacturer, model, finish, options, sort_order, leaf_side)
      SELECT
        v_new_opening_id,
        shi.name, shi.qty, shi.manufacturer, shi.model, shi.finish,
        shi.options, shi.sort_order, shi.leaf_side
      FROM staging_hardware_items shi
      WHERE shi.staging_opening_id = v_staging.staging_id;

      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      v_items_promoted := v_items_promoted + v_row_count;

      v_added := v_added + 1;
    END IF;
  END LOOP;

  -- ── Soft-delete doors that are in production but not in staging ──
  UPDATE openings
  SET is_active = false
  WHERE project_id = v_project_id
    AND is_active = true
    AND door_number != ALL(COALESCE(v_staging_door_numbers, ARRAY[]::TEXT[]));

  GET DIAGNOSTICS v_deactivated = ROW_COUNT;

  -- ── Update extraction run status ──
  UPDATE extraction_runs
  SET status = 'promoted',
      promoted_at = now(),
      promoted_by = p_user_id
  WHERE id = p_extraction_run_id;

  RETURN jsonb_build_object(
    'success', true,
    'added', v_added,
    'updated', v_updated,
    'unchanged', v_unchanged,
    'deactivated', v_deactivated,
    'items_promoted', v_items_promoted,
    'project_id', v_project_id
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', false,
    'error', SQLERRM
  );
END;
$$;

-- ── 3. write_staging_data() — transactional staging writes ──────────────────

CREATE OR REPLACE FUNCTION public.write_staging_data(
  p_extraction_run_id UUID,
  p_project_id UUID,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_opening JSONB;
  v_item JSONB;
  v_opening_id UUID;
  v_openings_count INTEGER := 0;
  v_items_count INTEGER := 0;
BEGIN
  -- Validate extraction run exists
  IF NOT EXISTS (
    SELECT 1 FROM extraction_runs
    WHERE id = p_extraction_run_id
      AND project_id = p_project_id
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Extraction run not found or project mismatch'
    );
  END IF;

  -- p_payload is a JSON array of openings, each with a nested "items" array:
  -- [
  --   {
  --     "door_number": "101",
  --     "hw_set": "DH1",
  --     "hw_heading": "...",
  --     "location": "...",
  --     "door_type": "...",
  --     "frame_type": "...",
  --     "fire_rating": "...",
  --     "hand": "...",
  --     "notes": "...",
  --     "pdf_page": 0,
  --     "leaf_count": 1,
  --     "is_flagged": false,
  --     "flag_reason": null,
  --     "field_confidence": {},
  --     "items": [
  --       { "name": "Closer", "qty": 1, "manufacturer": "LCN", ... }
  --     ]
  --   }
  -- ]

  FOR v_opening IN SELECT * FROM jsonb_array_elements(p_payload)
  LOOP
    INSERT INTO staging_openings (
      extraction_run_id, project_id, door_number, hw_set, hw_heading,
      location, door_type, frame_type, fire_rating, hand, notes,
      pdf_page, leaf_count, is_flagged, flag_reason, field_confidence
    )
    VALUES (
      p_extraction_run_id,
      p_project_id,
      v_opening->>'door_number',
      v_opening->>'hw_set',
      v_opening->>'hw_heading',
      v_opening->>'location',
      v_opening->>'door_type',
      v_opening->>'frame_type',
      v_opening->>'fire_rating',
      v_opening->>'hand',
      v_opening->>'notes',
      (v_opening->>'pdf_page')::INTEGER,
      COALESCE((v_opening->>'leaf_count')::INTEGER, 1),
      COALESCE((v_opening->>'is_flagged')::BOOLEAN, false),
      v_opening->>'flag_reason',
      CASE WHEN v_opening->'field_confidence' IS NOT NULL
           AND v_opening->>'field_confidence' != 'null'
        THEN v_opening->'field_confidence'
        ELSE NULL
      END
    )
    RETURNING id INTO v_opening_id;

    v_openings_count := v_openings_count + 1;

    -- Insert hardware items for this opening
    IF v_opening->'items' IS NOT NULL AND jsonb_array_length(v_opening->'items') > 0 THEN
      FOR v_item IN SELECT * FROM jsonb_array_elements(v_opening->'items')
      LOOP
        INSERT INTO staging_hardware_items (
          staging_opening_id, extraction_run_id, name, qty,
          qty_total, qty_door_count, qty_source,
          manufacturer, model, finish, options, sort_order
        )
        VALUES (
          v_opening_id,
          p_extraction_run_id,
          v_item->>'name',
          COALESCE((v_item->>'qty')::INTEGER, 1),
          (v_item->>'qty_total')::INTEGER,
          (v_item->>'qty_door_count')::INTEGER,
          v_item->>'qty_source',
          v_item->>'manufacturer',
          v_item->>'model',
          v_item->>'finish',
          v_item->>'options',
          COALESCE((v_item->>'sort_order')::INTEGER, 0)
        );

        v_items_count := v_items_count + 1;
      END LOOP;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'openings_count', v_openings_count,
    'items_count', v_items_count
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', false,
    'error', SQLERRM
  );
END;
$$;
