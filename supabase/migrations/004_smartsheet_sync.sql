-- Add Smartsheet sheet ID to projects for sync tracking
ALTER TABLE projects ADD COLUMN IF NOT EXISTS smartsheet_sheet_id bigint;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS smartsheet_last_synced timestamptz;
