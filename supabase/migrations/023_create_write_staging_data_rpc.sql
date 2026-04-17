-- ============================================================================
-- Migration 023: Ensure write_staging_data() RPC exists
-- ============================================================================
-- Fixes: "Could not find the function public.write_staging_data(...) in the
-- schema cache" on the Import Wizard Confirm step.
--
-- The function was originally defined in migration 021, but that migration
-- may not have been applied to the production database. This migration
-- uses CREATE OR REPLACE so it is safe to run regardless of whether 021
-- was already applied.
--
-- The function accepts the full extraction payload as JSONB and writes
-- staging_openings + staging_hardware_items in a single transaction,
-- preventing orphaned rows if a partial write fails.
-- ============================================================================

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
  --       { "name": "Closer", "qty": 1, "manufacturer": "LCN", "leaf_side": "shared", ... }
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

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'success', false,
    'error', SQLERRM
  );
END;
$$;
