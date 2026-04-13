import { createClient } from '@supabase/supabase-js'
import { Database } from '@/lib/types/database'

/**
 * Admin Supabase client — bypasses Row Level Security.
 *
 * Lives in its own module (separate from `server.ts`) because `server.ts`
 * top-level-imports `next/headers` for the cookie-aware authed client, and
 * `next/headers` is only available in Server Components / Route Handlers.
 * When a client component transitively pulls the admin client through
 * `server.ts`, Turbopack refuses to bundle and the production build fails.
 *
 * Split keeps the admin client safe to import from any server code path
 * (including `parse-pdf-helpers.ts`, which is consumed by both server
 * routes and client components via `classifyItemScope`).
 *
 * Use only for trusted server-side operations:
 *   - project creation (chicken-and-egg with RLS)
 *   - fire-and-forget logging (punchy_logs)
 *   - admin/tracking endpoints
 *   - cron cleanup jobs
 * Per CLAUDE.md, never hand an admin client to user-facing read/write paths.
 */
export function createAdminSupabaseClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}
