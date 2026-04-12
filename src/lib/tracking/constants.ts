// Shared constants + admin gate for the tracking dashboard.
//
// M1 of the Smartsheet-replacement project (see /root/.claude/plans/mutable-dazzling-tide.md).
// The three sheet IDs below are the cross-session tracking sheets we are
// migrating off of. They remain readable via Smartsheet's API as the source
// of truth until M2 actually runs the import.

import type { SupabaseClient } from '@supabase/supabase-js'

/** Admin email allowed to access the tracking dashboard and admin API routes. */
export const TRACKING_ADMIN_EMAIL = 'matt@rabbitholeconsultants.com'

/** Smartsheet sheet IDs for the three tracking sheets. */
export const TRACKING_SHEET_IDS = {
  plan_item: 4722023373688708,
  session: 1895373728599940,
  metric_run: 2206493777547140,
} as const

export type TrackingRecordType = keyof typeof TRACKING_SHEET_IDS

/**
 * Verify the current Supabase session belongs to the tracking admin.
 * Returns the user on success or an object with an error response on failure,
 * so API routes can early-return without boilerplate.
 */
export async function requireTrackingAdmin(
  supabase: SupabaseClient,
): Promise<
  | { ok: true; email: string }
  | { ok: false; status: 401 | 403; error: string }
> {
  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) {
    return { ok: false, status: 401, error: 'Unauthorized' }
  }
  const email = data.user.email ?? ''
  if (email !== TRACKING_ADMIN_EMAIL) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }
  return { ok: true, email }
}
