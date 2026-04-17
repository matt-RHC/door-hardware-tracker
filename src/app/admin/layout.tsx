import { redirect } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/admin-auth'
import type { ReactNode } from 'react'

/**
 * Admin surface gate.
 *
 * Enforces `requireAdmin` server-side before rendering any page under
 * /admin. IMPORTANT: every /api/admin/** route handler MUST also call
 * requireAdmin — this layout gate alone is not sufficient, because a
 * client can hit the API directly.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const supabase = await createServerSupabaseClient()
  const auth = await requireAdmin(supabase)
  if (!auth.ok) {
    redirect('/')
  }
  return <>{children}</>
}
