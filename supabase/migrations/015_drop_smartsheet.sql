-- Remove all Smartsheet integration artifacts.
-- Smartsheet was retired as a project tracker (2026-04-12).

-- Drop standalone Smartsheet tables
DROP TABLE IF EXISTS smartsheet_portfolio;
DROP TABLE IF EXISTS smartsheet_webhooks;
DROP TABLE IF EXISTS smartsheet_row_map;

-- Drop Smartsheet columns from the projects table
ALTER TABLE projects
  DROP COLUMN IF EXISTS smartsheet_sheet_id,
  DROP COLUMN IF EXISTS smartsheet_last_synced,
  DROP COLUMN IF EXISTS smartsheet_webhook_id,
  DROP COLUMN IF EXISTS smartsheet_submittal_sheet_id,
  DROP COLUMN IF EXISTS smartsheet_delivery_sheet_id,
  DROP COLUMN IF EXISTS smartsheet_issues_sheet_id,
  DROP COLUMN IF EXISTS smartsheet_folder_id;
