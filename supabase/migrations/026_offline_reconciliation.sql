-- Migration 026: Offline reconciliation support
-- Adds LWW conflict resolution columns to checklist_progress
-- All columns are backward-compatible (nullable or have defaults)

ALTER TABLE checklist_progress
  ADD COLUMN IF NOT EXISTS client_id UUID,
  ADD COLUMN IF NOT EXISTS client_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS server_updated_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS sync_status TEXT DEFAULT 'synced'
    CHECK (sync_status IN ('synced', 'pending_retry', 'conflict'));

-- Index for tracking devices and sync issues
CREATE INDEX IF NOT EXISTS idx_checklist_progress_client_id
  ON checklist_progress(client_id);
CREATE INDEX IF NOT EXISTS idx_checklist_progress_sync_status
  ON checklist_progress(sync_status)
  WHERE sync_status != 'synced';

-- Backfill server_updated_at from existing timestamps
-- Uses the most recent workflow step timestamp as the baseline
UPDATE checklist_progress
SET server_updated_at = COALESCE(
  qa_qc_at, installed_at, pre_install_at, received_at, checked_at, created_at
)
WHERE server_updated_at IS NULL;

-- Trigger to auto-update server_updated_at on every upsert
CREATE OR REPLACE FUNCTION update_server_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.server_updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_checklist_progress_server_updated_at
  BEFORE INSERT OR UPDATE ON checklist_progress
  FOR EACH ROW
  EXECUTE FUNCTION update_server_updated_at();

-- New activity_log action values for offline sync:
--   'offline_sync_started'    — batch sync replay began
--   'offline_sync_completed'  — batch sync replay finished (details: { synced: N, failed: N })
--   'offline_sync_conflict'   — LWW conflict detected (details: { client_updated_at, server_updated_at })
