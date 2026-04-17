-- Migration 028: Link deliveries to hardware items + blocked openings view
-- Enables backorder visibility and per-item delivery tracking

CREATE TABLE IF NOT EXISTS delivery_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id      UUID NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  hardware_item_id UUID REFERENCES hardware_items(id) ON DELETE CASCADE,
  opening_id       UUID REFERENCES openings(id) ON DELETE SET NULL,
  qty_expected     INTEGER NOT NULL DEFAULT 1,
  qty_received     INTEGER DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'expected'
                   CHECK (status IN ('expected', 'received', 'partial', 'damaged', 'backordered', 'substituted')),
  eta              DATE,
  substitution_for UUID REFERENCES hardware_items(id) ON DELETE SET NULL,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_delivery_items_delivery ON delivery_items(delivery_id);
CREATE INDEX idx_delivery_items_hardware ON delivery_items(hardware_item_id) WHERE hardware_item_id IS NOT NULL;
CREATE INDEX idx_delivery_items_opening ON delivery_items(opening_id) WHERE opening_id IS NOT NULL;
CREATE INDEX idx_delivery_items_status ON delivery_items(status) WHERE status IN ('backordered', 'damaged');

-- View: openings with blocked items (backordered or damaged deliveries)
CREATE OR REPLACE VIEW openings_blocked_v AS
SELECT DISTINCT
  o.id AS opening_id,
  o.project_id,
  o.door_number,
  o.location,
  di.status AS block_reason,
  di.eta AS estimated_arrival,
  hi.name AS blocked_item_name,
  hi.install_type AS blocked_item_category,
  d.po_number,
  d.vendor
FROM openings o
JOIN hardware_items hi ON hi.opening_id = o.id
JOIN delivery_items di ON di.hardware_item_id = hi.id
JOIN deliveries d ON d.id = di.delivery_id
WHERE di.status IN ('backordered', 'damaged')
  AND o.is_active = true;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_delivery_items_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_delivery_items_updated_at
  BEFORE UPDATE ON delivery_items
  FOR EACH ROW
  EXECUTE FUNCTION update_delivery_items_updated_at();

-- RLS: delivery_items inherit access from the delivery's project
ALTER TABLE delivery_items ENABLE ROW LEVEL SECURITY;

-- Select policy: project members can view delivery items
CREATE POLICY delivery_items_select ON delivery_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM deliveries d
      JOIN project_members pm ON pm.project_id = d.project_id
      WHERE d.id = delivery_items.delivery_id
        AND pm.user_id = (SELECT auth.uid())
    )
  );

-- Insert policy: project members can create delivery items
CREATE POLICY delivery_items_insert ON delivery_items
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM deliveries d
      JOIN project_members pm ON pm.project_id = d.project_id
      WHERE d.id = delivery_items.delivery_id
        AND pm.user_id = (SELECT auth.uid())
    )
  );

-- Update policy: project members can update delivery items
CREATE POLICY delivery_items_update ON delivery_items
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM deliveries d
      JOIN project_members pm ON pm.project_id = d.project_id
      WHERE d.id = delivery_items.delivery_id
        AND pm.user_id = (SELECT auth.uid())
    )
  );

-- Delete policy: project members can delete delivery items
CREATE POLICY delivery_items_delete ON delivery_items
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM deliveries d
      JOIN project_members pm ON pm.project_id = d.project_id
      WHERE d.id = delivery_items.delivery_id
        AND pm.user_id = (SELECT auth.uid())
    )
  );
