import { createAdminSupabaseClient } from '@/lib/supabase/admin'

/**
 * Per-project extraction rate limiting.
 *
 * Prevents accidental cost spikes from:
 *  - Re-uploading the same PDF repeatedly
 *  - Retry storms from client-side bugs
 *  - Bulk uploads that would overwhelm Anthropic API budget
 *
 * Uses the admin client to count extraction_jobs regardless of who created them.
 */

const MAX_JOBS_PER_PROJECT_PER_HOUR = 5

interface RateLimitResult {
  allowed: boolean
  /** How many jobs have been created in the current window */
  recentCount: number
  /** Max allowed in the window */
  limit: number
  /** Seconds until the oldest job in the window expires (for retry-after) */
  retryAfterSeconds?: number
}

/**
 * Check whether a project can create a new extraction job.
 *
 * Returns { allowed: true } if under the limit, or
 * { allowed: false, retryAfterSeconds } if over.
 */
export async function checkExtractionRateLimit(
  projectId: string
): Promise<RateLimitResult> {
  const admin = createAdminSupabaseClient()
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()

  const { data, error } = await admin
    .from('extraction_jobs')
    .select('created_at')
    .eq('project_id', projectId)
    .gte('created_at', oneHourAgo)
    .order('created_at', { ascending: true })

  if (error) {
    // If we can't check, allow the request — fail open rather than blocking work
    console.error('[rate-limit] Failed to check extraction rate:', error.message)
    return { allowed: true, recentCount: 0, limit: MAX_JOBS_PER_PROJECT_PER_HOUR }
  }

  const recentCount = data?.length ?? 0

  if (recentCount < MAX_JOBS_PER_PROJECT_PER_HOUR) {
    return { allowed: true, recentCount, limit: MAX_JOBS_PER_PROJECT_PER_HOUR }
  }

  // Calculate when the oldest job in the window will expire
  const oldestInWindow = data?.[0]?.created_at
  const retryAfterSeconds = oldestInWindow
    ? Math.ceil((new Date(oldestInWindow).getTime() + 60 * 60 * 1000 - Date.now()) / 1000)
    : 3600

  return {
    allowed: false,
    recentCount,
    limit: MAX_JOBS_PER_PROJECT_PER_HOUR,
    retryAfterSeconds: Math.max(0, retryAfterSeconds),
  }
}
