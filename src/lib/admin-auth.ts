/**
 * Shared admin gate for the /admin surface and /api/admin routes.
 *
 * Two independent criteria grant admin access:
 *   1. The legacy tracking admin (TRACKING_ADMIN_EMAIL) — preserved for
 *      /admin/tracking backwards compatibility.
 *   2. Any UUID present in the comma-separated `ADMIN_USER_IDS` env var —
 *      the primary mechanism for company/domain admin.
 *
 * IMPORTANT: Every admin API route MUST re-call `requireAdmin` on its own
 * handler. Layout-level auth is not load-bearing; a missing gate on a
 * handler is a data-leak bug.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { TRACKING_ADMIN_EMAIL } from '@/lib/tracking/constants'

export type AdminGateResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; status: 401 | 403; error: string }

function parseAdminIds(): string[] {
  const raw = process.env.ADMIN_USER_IDS ?? ''
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function requireAdmin(supabase: SupabaseClient<any>): Promise<AdminGateResult> {
  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) {
    return { ok: false, status: 401, error: 'Unauthorized' }
  }

  const user = data.user
  const email = user.email ?? ''

  if (email === TRACKING_ADMIN_EMAIL) {
    return { ok: true, userId: user.id, email }
  }

  const allowed = parseAdminIds()
  if (allowed.includes(user.id)) {
    return { ok: true, userId: user.id, email }
  }

  return { ok: false, status: 403, error: 'Forbidden' }
}
