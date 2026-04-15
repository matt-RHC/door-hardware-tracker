import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import type { ActivityAction as ConstantActivityAction } from '@/lib/constants/activity-actions'

/**
 * Activity log — audit trail for who did what, when.
 *
 * Uses the admin (service role) client so entries cannot be tampered with
 * by end users. The activity_log table has no INSERT RLS policy for regular
 * users — only service role can write.
 *
 * Call this from API routes after mutations (promote, edit, delete, etc.).
 */

export type ActivityAction =
  | 'extraction_promoted'
  | 'extraction_job_created'
  | 'extraction_job_completed'
  | 'extraction_job_failed'
  | 'item_edited'
  | 'item_deleted'
  | 'opening_edited'
  | 'opening_deleted'
  | 'punchy_correction_applied'
  | 'punchy_correction_rejected'
  | 'member_added'
  | 'member_removed'
  | 'member_role_changed'
  | 'item_received'
  | 'item_receive_undone'
  | 'item_pre_installed'
  | 'item_pre_install_undone'
  | 'item_installed'
  | 'item_install_undone'
  | 'item_qa_passed'
  | 'item_qa_failed'
  | 'item_qa_undone'
  | 'item_checked'
  | 'item_unchecked'
  | 'damage_reported'
  | 'issue_created'
  | 'issue_status_changed'
  | 'issue_comment_added'
  | 'offline_sync_started'
  | 'offline_sync_completed'
  | 'offline_sync_conflict'
  | 'install_type_changed'
  | 'batch_update'
  | ConstantActivityAction

export type EntityType =
  | 'opening'
  | 'hardware_item'
  | 'project'
  | 'extraction_job'
  | 'project_member'
  | 'checklist_progress'
  | 'delivery'
  | 'issue'

interface LogActivityParams {
  projectId: string
  userId: string | null
  action: ActivityAction
  entityType?: EntityType
  entityId?: string
  details?: Record<string, unknown>
}

/**
 * Log an activity to the audit trail.
 *
 * Fire-and-forget — errors are caught and logged to console,
 * never thrown. An audit log failure should not break the primary operation.
 */
export async function logActivity({
  projectId,
  userId,
  action,
  entityType,
  entityId,
  details,
}: LogActivityParams): Promise<void> {
  try {
    const admin = createAdminSupabaseClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (admin as any).from('activity_log').insert({
      project_id: projectId,
      user_id: userId,
      action,
      entity_type: entityType ?? null,
      entity_id: entityId ?? null,
      details: details ?? {},
    })
    if (error) {
      console.error('[activity-log] Failed to write:', error.message)
    }
  } catch (err) {
    console.error('[activity-log] Unexpected error:', err)
  }
}
