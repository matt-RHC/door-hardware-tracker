import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/admin-auth'

export const runtime = 'nodejs'

/**
 * GET /api/admin/companies
 * POST /api/admin/companies { name, slug }
 *
 * Admin-gated. requireAdmin is called on every handler — do not rely on
 * the layout gate alone.
 */

export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const gate = await requireAdmin(supabase)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const admin = createAdminSupabaseClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from('companies')
    .select('id, name, slug, created_at')
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ companies: data ?? [] })
}

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const gate = await requireAdmin(supabase)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const body = await request.json().catch(() => ({})) as { name?: string; slug?: string }
  const name = (body.name ?? '').trim()
  const slug = (body.slug ?? '').trim().toLowerCase()

  if (!name || !slug) {
    return NextResponse.json({ error: 'name and slug are required' }, { status: 400 })
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug)) {
    return NextResponse.json(
      { error: 'slug must be lowercase a–z, 0–9, hyphens; 3–64 chars' },
      { status: 400 },
    )
  }

  const admin = createAdminSupabaseClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from('companies')
    .insert({ name, slug })
    .select('id, name, slug, created_at')
    .single()

  if (error) {
    const status = error.code === '23505' ? 409 : 500
    return NextResponse.json({ error: error.message }, { status })
  }
  return NextResponse.json({ company: data }, { status: 201 })
}
