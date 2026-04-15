-- Migration 027: Expand attachments for delivery photos, damage tracking, and per-item attribution
-- Backward compatible: existing attachments continue to work via opening_id

-- ─────────────────────────────────────────────────────────────────────────────
-- New columns for broader attachment scoping
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS delivery_id  UUID REFERENCES deliveries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS progress_id  UUID REFERENCES checklist_progress(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS leaf_index   INTEGER,
  ADD COLUMN IF NOT EXISTS damage_flag  BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS damage_notes TEXT;

-- Make opening_id nullable (delivery-only photos won't have an opening yet)
ALTER TABLE attachments
  ALTER COLUMN opening_id DROP NOT NULL;

-- Ensure at least one scope reference exists
ALTER TABLE attachments
  ADD CONSTRAINT attachments_scope_check
  CHECK (opening_id IS NOT NULL OR delivery_id IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- New category values
-- ─────────────────────────────────────────────────────────────────────────────
-- Current categories from migration 003: 'floor_plan', 'door_drawing', 'frame_drawing', 'general'
-- category is a TEXT column with no CHECK constraint, so new values just work.
-- Document the expanded set via column comment.
COMMENT ON COLUMN attachments.category IS
  'Categories: floor_plan, door_drawing, frame_drawing, general, receiving_photo, damage_photo, install_progress, qa_punch';

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes for new lookup patterns
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_attachments_delivery_id
  ON attachments(delivery_id) WHERE delivery_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_attachments_progress_id
  ON attachments(progress_id) WHERE progress_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_attachments_damage
  ON attachments(opening_id) WHERE damage_flag = true;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS policies for delivery-scoped attachments
-- ─────────────────────────────────────────────────────────────────────────────
-- Existing policies (migration 001) join through openings.opening_id, which
-- still works for opening-scoped rows. Delivery-only rows (opening_id IS NULL)
-- are naturally excluded by those policies, so we add complementary policies
-- that join through deliveries → project_members for delivery-scoped access.
--
-- Pattern follows migration 016: use (select auth.uid()) to avoid per-row
-- re-evaluation of the auth function.

CREATE POLICY "Project members can view delivery attachments"
  ON attachments FOR SELECT
  USING (
    delivery_id IS NOT NULL
    AND (SELECT auth.uid()) IN (
      SELECT pm.user_id FROM project_members pm
      JOIN deliveries d ON d.project_id = pm.project_id
      WHERE d.id = attachments.delivery_id
    )
  );

CREATE POLICY "Project members can create delivery attachments"
  ON attachments FOR INSERT
  WITH CHECK (
    delivery_id IS NOT NULL
    AND (SELECT auth.uid()) IN (
      SELECT pm.user_id FROM project_members pm
      JOIN deliveries d ON d.project_id = pm.project_id
      WHERE d.id = attachments.delivery_id
    )
  );

CREATE POLICY "Project members can update delivery attachments"
  ON attachments FOR UPDATE
  USING (
    delivery_id IS NOT NULL
    AND (SELECT auth.uid()) IN (
      SELECT pm.user_id FROM project_members pm
      JOIN deliveries d ON d.project_id = pm.project_id
      WHERE d.id = attachments.delivery_id
    )
  );

CREATE POLICY "Project admins can delete delivery attachments"
  ON attachments FOR DELETE
  USING (
    delivery_id IS NOT NULL
    AND (SELECT auth.uid()) IN (
      SELECT pm.user_id FROM project_members pm
      JOIN deliveries d ON d.project_id = pm.project_id
      WHERE d.id = attachments.delivery_id
        AND pm.role = 'admin'
    )
  );
