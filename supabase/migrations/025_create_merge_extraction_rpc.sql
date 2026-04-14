-- Create merge_extraction RPC for promoting extraction runs to production openings
-- Applied in production, adding to repo for parity
CREATE OR REPLACE FUNCTION merge_extraction(p_extraction_run_id UUID, p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
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

  IF NOT EXISTS (
    SELECT 1 FROM project_members
    WHERE project_id = v_project_id
      AND user_id = p_user_id
      AND role = 'admin'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'User must be a project admin to promote extraction');
  END IF;

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

  SELECT array_agg(door_number) INTO v_staging_door_numbers
  FROM staging_openings
  WHERE extraction_run_id = p_extraction_run_id;

  FOR v_staging IN
    SELECT so.*, so.id AS staging_id
    FROM staging_openings so
    WHERE so.extraction_run_id = p_extraction_run_id
    ORDER BY so.door_number
  LOOP
    SELECT id INTO v_existing_opening_id
    FROM openings
    WHERE project_id = v_project_id
      AND door_number = v_staging.door_number;

    IF v_existing_opening_id IS NOT NULL THEN
      SELECT string_agg(sig, '|' ORDER BY sig) INTO v_staging_hw_sig
      FROM (
        SELECT shi.name || ':' || COALESCE(shi.qty, 1)::text AS sig
        FROM staging_hardware_items shi
        WHERE shi.staging_opening_id = v_staging.staging_id
        ORDER BY shi.name, shi.qty
      ) sub;

      SELECT string_agg(sig, '|' ORDER BY sig) INTO v_prod_hw_sig
      FROM (
        SELECT hi.name || ':' || hi.qty::text AS sig
        FROM hardware_items hi
        WHERE hi.opening_id = v_existing_opening_id
        ORDER BY hi.name, hi.qty
      ) sub;

      v_hw_changed := COALESCE(v_staging_hw_sig, '') IS DISTINCT FROM COALESCE(v_prod_hw_sig, '');

      IF v_hw_changed THEN
        UPDATE openings SET
          hw_set = v_staging.hw_set, hw_heading = v_staging.hw_heading,
          location = v_staging.location, door_type = v_staging.door_type,
          frame_type = v_staging.frame_type, fire_rating = v_staging.fire_rating,
          hand = v_staging.hand, notes = v_staging.notes,
          pdf_page = v_staging.pdf_page, leaf_count = COALESCE(v_staging.leaf_count, 1),
          is_active = true
        WHERE id = v_existing_opening_id;

        DELETE FROM hardware_items WHERE opening_id = v_existing_opening_id;

        INSERT INTO hardware_items (opening_id, name, qty, manufacturer, model, finish, options, sort_order, leaf_side)
        SELECT v_existing_opening_id, shi.name, shi.qty, shi.manufacturer, shi.model, shi.finish,
          shi.options, shi.sort_order, shi.leaf_side
        FROM staging_hardware_items shi
        WHERE shi.staging_opening_id = v_staging.staging_id;

        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        v_items_promoted := v_items_promoted + v_row_count;
        v_updated := v_updated + 1;
      ELSE
        UPDATE openings SET
          hw_set = v_staging.hw_set, hw_heading = v_staging.hw_heading,
          location = v_staging.location, door_type = v_staging.door_type,
          frame_type = v_staging.frame_type, fire_rating = v_staging.fire_rating,
          hand = v_staging.hand, notes = v_staging.notes,
          pdf_page = v_staging.pdf_page, leaf_count = COALESCE(v_staging.leaf_count, 1),
          is_active = true
        WHERE id = v_existing_opening_id;
        v_unchanged := v_unchanged + 1;
      END IF;
    ELSE
      INSERT INTO openings (
        project_id, door_number, hw_set, hw_heading, location,
        door_type, frame_type, fire_rating, hand, notes, pdf_page,
        leaf_count, is_active
      ) VALUES (
        v_project_id, v_staging.door_number, v_staging.hw_set,
        v_staging.hw_heading, v_staging.location,
        v_staging.door_type, v_staging.frame_type,
        v_staging.fire_rating, v_staging.hand,
        v_staging.notes, v_staging.pdf_page,
        COALESCE(v_staging.leaf_count, 1), true
      ) RETURNING id INTO v_new_opening_id;

      INSERT INTO hardware_items (opening_id, name, qty, manufacturer, model, finish, options, sort_order, leaf_side)
      SELECT v_new_opening_id, shi.name, shi.qty, shi.manufacturer, shi.model, shi.finish,
        shi.options, shi.sort_order, shi.leaf_side
      FROM staging_hardware_items shi
      WHERE shi.staging_opening_id = v_staging.staging_id;

      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      v_items_promoted := v_items_promoted + v_row_count;
      v_added := v_added + 1;
    END IF;
  END LOOP;

  UPDATE openings SET is_active = false
  WHERE project_id = v_project_id
    AND is_active = true
    AND door_number != ALL(COALESCE(v_staging_door_numbers, ARRAY[]::TEXT[]));

  GET DIAGNOSTICS v_deactivated = ROW_COUNT;

  UPDATE extraction_runs
  SET status = 'promoted', promoted_at = now(), promoted_by = p_user_id
  WHERE id = p_extraction_run_id;

  RETURN jsonb_build_object(
    'success', true, 'added', v_added, 'updated', v_updated,
    'unchanged', v_unchanged, 'deactivated', v_deactivated,
    'items_promoted', v_items_promoted, 'project_id', v_project_id
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
