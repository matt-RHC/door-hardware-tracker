import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { Database } from '@/lib/types/database'

export async function createServerSupabaseClient() {
  const cookieStore = await cookies()
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Server Component - read only
          }
        },
      },
    }
  )
}

// NOTE: `createAdminSupabaseClient` used to live here, but this module
// top-level-imports `next/headers` (for the cookie-aware authed client),
// which forbids bundling into client components. Since `parse-pdf-helpers`
// is imported by both server routes and client components (via
// `classifyItemScope`), the admin client now lives in `./admin` where it
// can be imported safely from any code path. Import it from
// `@/lib/supabase/admin` directly.
