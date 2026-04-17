export const ACTIVITY_ACTIONS = {
  // Existing extraction actions
  EXTRACTION_PROMOTED: 'extraction_promoted',
  EXTRACTION_JOB_CREATED: 'extraction_job_created',
  EXTRACTION_JOB_COMPLETED: 'extraction_job_completed',
  EXTRACTION_JOB_FAILED: 'extraction_job_failed',
  ITEM_EDITED: 'item_edited',
  ITEM_DELETED: 'item_deleted',

  // New workflow actions
  ITEM_RECEIVED: 'item_received',
  ITEM_RECEIVE_UNDONE: 'item_receive_undone',
  ITEM_PRE_INSTALLED: 'item_pre_installed',
  ITEM_PRE_INSTALL_UNDONE: 'item_pre_install_undone',
  ITEM_INSTALLED: 'item_installed',
  ITEM_INSTALL_UNDONE: 'item_install_undone',
  ITEM_QA_PASSED: 'item_qa_passed',
  ITEM_QA_FAILED: 'item_qa_failed',
  ITEM_QA_UNDONE: 'item_qa_undone',
  ITEM_CHECKED: 'item_checked',
  ITEM_UNCHECKED: 'item_unchecked',

  // Damage and issues
  DAMAGE_REPORTED: 'damage_reported',
  ISSUE_CREATED: 'issue_created',
  ISSUE_STATUS_CHANGED: 'issue_status_changed',
  ISSUE_ASSIGNED: 'issue_assigned',
  ISSUE_COMMENT_ADDED: 'issue_comment_added',

  // Offline sync
  OFFLINE_SYNC_STARTED: 'offline_sync_started',
  OFFLINE_SYNC_COMPLETED: 'offline_sync_completed',
  OFFLINE_SYNC_CONFLICT: 'offline_sync_conflict',

  // Classification
  INSTALL_TYPE_CHANGED: 'install_type_changed',

  // Batch operations
  BATCH_UPDATE: 'batch_update',
} as const

export type ActivityAction = typeof ACTIVITY_ACTIONS[keyof typeof ACTIVITY_ACTIONS]

export const ACTION_LABELS: Record<string, string> = {
  item_received: 'Item Received',
  item_receive_undone: 'Receive Undone',
  item_pre_installed: 'Pre-Install Done',
  item_pre_install_undone: 'Pre-Install Undone',
  item_installed: 'Item Installed',
  item_install_undone: 'Install Undone',
  item_qa_passed: 'QA Passed',
  item_qa_failed: 'QA Failed',
  item_qa_undone: 'QA Undone',
  item_checked: 'Item Checked',
  item_unchecked: 'Item Unchecked',
  damage_reported: 'Damage Reported',
  issue_created: 'Issue Created',
  issue_status_changed: 'Issue Status Changed',
  issue_assigned: 'Issue Assigned',
  issue_comment_added: 'Comment Added',
  offline_sync_started: 'Sync Started',
  offline_sync_completed: 'Sync Completed',
  offline_sync_conflict: 'Sync Conflict',
  install_type_changed: 'Install Type Changed',
  batch_update: 'Batch Update',
  extraction_promoted: 'Extraction Promoted',
  extraction_job_created: 'Extraction Started',
  extraction_job_completed: 'Extraction Completed',
  extraction_job_failed: 'Extraction Failed',
  item_edited: 'Item Edited',
  item_deleted: 'Item Deleted',
}
