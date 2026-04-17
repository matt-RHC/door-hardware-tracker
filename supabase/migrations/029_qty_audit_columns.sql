-- Migration 029: Quantity audit columns on hardware_items
-- Tracks how quantities were derived (parsed, divided, flagged, etc.)
-- Needed for DPR dispute resolution and extraction audit trail

ALTER TABLE hardware_items
  ADD COLUMN IF NOT EXISTS qty_total      INTEGER,
  ADD COLUMN IF NOT EXISTS qty_door_count INTEGER,
  ADD COLUMN IF NOT EXISTS qty_source     TEXT;

-- Document qty_source values
COMMENT ON COLUMN hardware_items.qty_source IS
  'How qty was derived: parsed | divided | flagged | capped | manual | region_extract';
