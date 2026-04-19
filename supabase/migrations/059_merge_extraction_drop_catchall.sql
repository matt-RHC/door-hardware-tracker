-- Migration 059: drop the catch-all EXCEPTION handler from merge_extraction
--
-- Background: migrations 021 through 055 all defined merge_extraction with
-- an `EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('success', false,
-- 'error', SQLERRM)` block at the end of the function body. The intent was
-- to keep the function's contract clean — it would always return a JSONB
-- success/failure envelope rather than throw. The cost was opacity: every
-- unexpected runtime error (column drift, CHECK-constraint drift, type
-- mismatch) was converted into the same failure JSON as deliberate,
-- user-recoverable validation rejections (orphan doors, wrong status, not
-- admin). The caller had no way to distinguish "the user needs to pick a
-- different door set" from "the schema is broken and every promotion is
-- silently failing in prod."
--
-- Two production bugs shipped past this handler:
--   - PR #341 / migration 055: migration 054 dropped openings.notes but the
--     function still wrote the column. Column-not-exist was caught and
--     returned as generic failure JSON.
--   - PR #343 / migration 056: migration 050 narrowed the extraction_runs
--     status CHECK and dropped 'promoted'. CHECK violation was caught and
--     returned as generic failure JSON.
--
-- In both cases Sentry never saw the error. The failure surfaced only as
-- extraction_runs.status='failed' plus a toast to the end user.
--
-- Fix: remove the catch-all. Deliberate validation failures still return
-- the failure envelope via explicit `RETURN jsonb_build_object(...)` calls
-- (orphan doors, wrong status, not admin, run-not-found). Unexpected
-- exceptions now propagate to the RPC caller, where supabase-js maps them
-- to the `error` field of the response. The single call site
-- (src/lib/extraction-staging.ts:343) already handles `error`:
--
--     const { data, error } = await supabase.rpc('merge_extraction', ...)
--     if (error) return { success: false, error: error.message }
--
-- Paired with the Sentry.captureMessage added in save/route.ts (PR #351),
-- this routes column/CHECK drift to Sentry in real time.
--
-- Migration 055's body was byte-identical to the live function except for
-- the three notes-column references. This migration copies that body
-- verbatim minus the trailing `EXCEPTION WHEN OTHERS THEN ...` block.
--
-- Do NOT reintroduce a catch-all EXCEPTION WHEN OTHERS block in this
-- function. If future work needs to handle a SPECIFIC exception class
-- (e.g. RAISE EXCEPTION 'foo' for an expected business-rule violation),
-- scope the handler to that exception type only, e.g.
--   EXCEPTION WHEN check_violation THEN ...
-- A blanket WHEN OTHERS defeats Sentry observability for the entire
-- function.
--
-- Rollback: re-apply migration 055 (CREATE OR REPLACE restores the prior
-- definition with the handler).

CREATE OR REPLACE FUNCTION public.merge_extraction(p_extraction_run_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_existing_opening_id UUID;
  v_new_opening_id UUID;
  v_hw_changed BOOLEAN;
  v_staging_hw_sig TEXT;
  v_prod_hw_sig TEXT;
  v_staging_door_numbers TEXT[];
  v_orphan_doors TEXT[];
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

  -- Identify openings with no joined hardware items. The array_agg here
  -- returns NULL (not an empty array) when every opening has items — that's
  -- the happy path.
  SELECT array_agg(so.door_number ORDER BY so.door_number)
    INTO v_orphan_doors
  FROM staging_openings so
  LEFT JOIN staging_hardware_items shi ON shi.staging_opening_id = so.id
  WHERE so.extraction_run_id = p_extraction_run_id
  GROUP BY so.id, so.door_number
  HAVING COUNT(shi.id) = 0;

  IF v_orphan_doors IS NOT NULL AND array_length(v_orphan_doors, 1) > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format(
        'Cannot promote: %s door(s) have no hardware items: %s. Exclude them or add hardware before promoting.',
        array_length(v_orphan_doors, 1),
        array_to_string(v_orphan_doors, ', ')
      ),
      'orphan_doors', to_jsonb(v_orphan_doors)
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
        -- migration 055: removed `notes = v_staging.notes` (column dropped in 054)
        UPDATE openings SET
          hw_set = v_staging.hw_set, hw_heading = v_staging.hw_heading,
          location = v_staging.location, door_type = v_staging.door_type,
          frame_type = v_staging.frame_type, fire_rating = v_staging.fire_rating,
          hand = v_staging.hand,
          pdf_page = v_staging.pdf_page, leaf_count = COALESCE(v_staging.leaf_count, 1),
          is_active = true
        WHERE id = v_existing_opening_id;

        DELETE FROM hardware_items WHERE opening_id = v_existing_opening_id;

        INSERT INTO hardware_items (opening_id, name, qty, qty_total, qty_door_count, qty_source, manufacturer, model, finish, options, sort_order, leaf_side)
        SELECT v_existing_opening_id, shi.name, shi.qty, shi.qty_total, shi.qty_door_count, shi.qty_source,
          shi.manufacturer, shi.model, shi.finish,
          shi.options, shi.sort_order, shi.leaf_side
        FROM staging_hardware_items shi
        WHERE shi.staging_opening_id = v_staging.staging_id;

        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        v_items_promoted := v_items_promoted + v_row_count;
        v_updated := v_updated + 1;
      ELSE
        -- migration 055: removed `notes = v_staging.notes` (column dropped in 054)
        UPDATE openings SET
          hw_set = v_staging.hw_set, hw_heading = v_staging.hw_heading,
          location = v_staging.location, door_type = v_staging.door_type,
          frame_type = v_staging.frame_type, fire_rating = v_staging.fire_rating,
          hand = v_staging.hand,
          pdf_page = v_staging.pdf_page, leaf_count = COALESCE(v_staging.leaf_count, 1),
          is_active = true
        WHERE id = v_existing_opening_id;
        v_unchanged := v_unchanged + 1;
      END IF;
    ELSE
      -- migration 055: removed `notes` column from INSERT (dropped in 054)
      INSERT INTO openings (
        project_id, door_number, hw_set, hw_heading, location,
        door_type, frame_type, fire_rating, hand, pdf_page,
        leaf_count, is_active
      ) VALUES (
        v_project_id, v_staging.door_number, v_staging.hw_set,
        v_staging.hw_heading, v_staging.location,
        v_staging.door_type, v_staging.frame_type,
        v_staging.fire_rating, v_staging.hand,
        v_staging.pdf_page,
        COALESCE(v_staging.leaf_count, 1), true
      ) RETURNING id INTO v_new_opening_id;

      INSERT INTO hardware_items (opening_id, name, qty, qty_total, qty_door_count, qty_source, manufacturer, model, finish, options, sort_order, leaf_side)
      SELECT v_new_opening_id, shi.name, shi.qty, shi.qty_total, shi.qty_door_count, shi.qty_source,
        shi.manufacturer, shi.model, shi.finish,
        shi.options, shi.sort_order, shi.leaf_side
      FROM staging_hardware_items shi
      WHERE shi.staging_opening_id = v_staging.staging_id;

      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      v_items_promoted := v_items_promoted + v_row_count;
      v_added := v_added + 1;
    END IF;
  END LOOP;

  -- FIX (migration 034): Guard against NULL v_staging_door_numbers which
  -- would deactivate ALL openings. array_agg() returns NULL (not empty
  -- array) when there are no staging rows.
  IF v_staging_door_numbers IS NOT NULL THEN
    UPDATE openings SET is_active = false
    WHERE project_id = v_project_id
      AND is_active = true
      AND door_number != ALL(v_staging_door_numbers);

    GET DIAGNOSTICS v_deactivated = ROW_COUNT;
  END IF;

  UPDATE extraction_runs
  SET status = 'promoted', promoted_at = now(), promoted_by = p_user_id
  WHERE id = p_extraction_run_id;

  RETURN jsonb_build_object(
    'success', true, 'added', v_added, 'updated', v_updated,
    'unchanged', v_unchanged, 'deactivated', v_deactivated,
    'items_promoted', v_items_promoted, 'project_id', v_project_id
  );

-- migration 059: removed `EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object(
-- 'success', false, 'error', SQLERRM)`. Unexpected exceptions now propagate
-- to the RPC caller so Sentry sees them. Deliberate validation failures
-- (orphan doors, wrong status, not admin, run-not-found) are still returned
-- as failure JSON via the RETURN statements above. See PR #351 for the
-- paired TS-side Sentry.captureMessage.

END;
$function$;

COMMENT ON FUNCTION public.merge_extraction(uuid, uuid) IS
  'Promotes a staged extraction run into the production openings + hardware_items tables. '
  'Migration 059 removed the catch-all EXCEPTION WHEN OTHERS handler — unexpected '
  'exceptions now propagate to the caller so Sentry sees them; deliberate validation '
  'failures are still returned as {success:false, error} JSON via explicit RETURNs. '
  'Do NOT reintroduce a blanket exception handler — it hid PR #341 (column drift) and '
  'PR #343 (CHECK drift) in prod. SECURITY DEFINER + SET search_path = public, pg_temp '
  'per the 052/053 hardening pattern.';
