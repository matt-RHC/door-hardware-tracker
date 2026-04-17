/**
 * Centralized Supabase .select() column lists.
 *
 * WHY THIS EXISTS: When a migration adds a column to a table, the
 * database.ts types get updated but individual route files' .select()
 * calls don't — causing the app to silently ignore new columns.
 *
 * RULE: When you add a column via migration, add it here too.
 * All routes import from this file, so one update propagates everywhere.
 */

/** All columns from the openings table. */
export const OPENING_COLUMNS = `
  id, project_id, door_number, hw_set, hw_heading, location,
  door_type, frame_type, fire_rating, hand, notes, pdf_page,
  leaf_count, is_active, floor_number, zone_name, created_at
`

/** Hardware items with all columns including qty fields and stage. */
export const HARDWARE_ITEM_COLUMNS = `
  id, opening_id, name, qty, qty_total, qty_door_count, qty_source,
  manufacturer, model, finish, options, sort_order,
  install_type, leaf_side, stage, created_at
`

/** Checklist progress with all workflow + QA + sync columns. */
export const CHECKLIST_PROGRESS_COLUMNS = `
  id, item_id, opening_id, leaf_index,
  checked, checked_by, checked_at,
  received, received_by, received_at,
  pre_install, pre_install_by, pre_install_at,
  installed, installed_by, installed_at,
  qa_qc, qa_qc_by, qa_qc_at,
  qa_findings, qa_notes, qa_resolved_at, qa_resolved_by,
  client_id, client_updated_at, server_updated_at, sync_status,
  notes, created_at
`

/** Full opening detail with nested hardware_items and checklist_progress. */
export const OPENING_DETAIL_SELECT = `
  ${OPENING_COLUMNS},
  hardware_items(${HARDWARE_ITEM_COLUMNS}),
  checklist_progress(${CHECKLIST_PROGRESS_COLUMNS})
`

/** Opening list — just IDs from nested tables for counting. */
export const OPENING_LIST_SELECT = `
  ${OPENING_COLUMNS},
  hardware_items:hardware_items(id),
  checklist_progress(id, checked, received, pre_install, installed, qa_qc)
`
