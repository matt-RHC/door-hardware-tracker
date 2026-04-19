-- ============================================================================
-- Migration 058: drop staging_openings.notes — finish the mig 054/055 cleanup
-- ============================================================================
-- Background: migration 054 dropped `openings.notes` (moved to the punch-notes
-- tables). Migration 055 updated `merge_extraction` to stop reading the column,
-- but explicitly left `staging_openings.notes` AND `write_staging_data`'s
-- INSERT of it in place — acknowledged as a follow-up in the 055 header:
--
--   "staging_openings.notes is intentionally left in place — write_staging_data
--    still writes it … drop staging_openings.notes too, but that's lower
--    priority."
--
-- That created a dead-write: the TS client sends `notes`, the RPC writes it to
-- staging, and `merge_extraction` discards it at promote time. Harmless today,
-- but fragile — a rollback of 054 would silently sever the staging→final wire,
-- and a future maintainer reading the schema would reasonably expect the
-- column to carry data through to `openings`.
--
-- This migration finishes the cleanup:
--   1. Redefine `write_staging_data` without the `notes` column reference.
--   2. Drop `staging_openings.notes`.
--
-- Order matters — the function redefinition has to land before the DROP
-- COLUMN, or the function body references a non-existent column.
--
-- Deployment:
--   - Apply AFTER the code removing `notes` from the TS payload is live,
--     or the RPC will 400 on unknown column (fails cleanly, no data loss).
--     Safer deploy order is code-first, migration-second.
--   - Idempotent: DROP COLUMN IF EXISTS + CREATE OR REPLACE FUNCTION.
-- ============================================================================

-- ── Step 1: redefine write_staging_data without `notes` ────────────────────
-- Body is identical to migration 023 (the last definition) minus:
--   - `notes` from the staging_openings INSERT column list
--   - `v_opening->>'notes'` from the VALUES list
-- All other semantics preserved: same parameters, same return shape, same
-- validation, same items loop, same SECURITY/search_path surface. The function
-- was not redefined between 023 and this migration — verified by grep.

-- Parameter order MUST match the live function signature
-- (p_extraction_run_id, p_project_id, p_payload). CREATE OR REPLACE FUNCTION
-- can change the body but cannot rename a parameter at a given position; an
-- earlier draft of this migration had project_id first and was rejected with
-- "cannot change name of input parameter" (SQLSTATE 42P13). Order verified
-- against pg_get_function_arguments(...) on prod 2026-04-19.
CREATE OR REPLACE FUNCTION write_staging_data(
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

  -- p_payload schema is unchanged from mig 023; the `notes` field is simply
  -- ignored if the TS client still sends it (jsonb operator returns NULL on
  -- absent keys). This keeps the function forward-compatible with older
  -- clients during a rolling deploy.

  FOR v_opening IN SELECT * FROM jsonb_array_elements(p_payload)
  LOOP
    INSERT INTO staging_openings (
      extraction_run_id, project_id, door_number, hw_set, hw_heading,
      location, door_type, frame_type, fire_rating, hand,
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
          manufacturer, model, finish, options, sort_order, leaf_side
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
          COALESCE((v_item->>'sort_order')::INTEGER, 0),
          v_item->>'leaf_side'
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
END;
$$;

-- ── Step 2: drop the now-orphaned column ───────────────────────────────────
ALTER TABLE staging_openings DROP COLUMN IF EXISTS notes;

COMMENT ON FUNCTION write_staging_data(UUID, UUID, JSONB) IS
  'Writes openings + hardware items to staging in one transaction. '
  'Does NOT write notes — staging_openings.notes was dropped in mig 058 '
  'to finish the openings.notes cleanup begun in mig 054/055.';
