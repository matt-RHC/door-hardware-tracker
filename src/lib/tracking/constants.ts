// Shared constants + admin gate for the tracking dashboard.

import type { SupabaseClient } from '@supabase/supabase-js'

/** Admin email allowed to access the tracking dashboard and admin API routes. */
export const TRACKING_ADMIN_EMAIL = 'matt@rabbitholeconsultants.com'

export type TrackingRecordType = 'plan_item' | 'session' | 'metric_run'

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
