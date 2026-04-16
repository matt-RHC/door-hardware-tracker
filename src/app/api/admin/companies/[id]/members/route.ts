import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/admin-auth'

export const runtime = 'nodejs'

/**
 * GET /api/admin/companies/[id]/members
 * POST /api/admin/companies/[id]/members { user_id, role }
 * PATCH /api/admin/companies/[id]/members { user_id, role }
 * DELETE /api/admin/companies/[id]/members?user_id=<uuid>
 *
 * Admin-gated on every handler. The DB side is locked: there are no
 * client-facing INSERT/UPDATE/DELETE policies on company_members, so this
 * admin-API route is the only non-trigger write path.
 */

type RouteParams = { params: Promise<{ id: string }> }
type Role = 'owner' | 'admin' | 'member'

const ROLES: readonly Role[] = ['owner', 'admin', 'member'] as const

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const supabase = await createServerSupabaseClient()
  const gate = await requireAdmin(supabase)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const { id } = await params
  const admin = createAdminSupabaseClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from('company_members')
    .select('company_id, user_id, role, is_default, joined_at')
    .eq('company_id', id)
    .order('joined_at', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ members: data ?? [] })
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const supabase = await createServerSupabaseClient()
  const gate = await requireAdmin(supabase)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const { id } = await params
  const body = await request.json().catch(() => ({})) as { user_id?: string; role?: string }
  const userId = (body.user_id ?? '').trim()
  const role = (body.role as Role | undefined) ?? 'member'

  if (!userId) {
    return NextResponse.json({ error: 'user_id required' }, { status: 400 })
  }
  if (!ROLES.includes(role)) {
    return NextResponse.json({ error: `role must be one of ${ROLES.join(',')}` }, { status: 400 })
  }

  const admin = createAdminSupabaseClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from('company_members')
    .insert({ company_id: id, user_id: userId, role, is_default: true })
    .select('company_id, user_id, role, is_default, joined_at')
    .single()

  if (error) {
    const status = error.code === '23505' ? 409 : 500
    return NextResponse.json({ error: error.message }, { status })
  }
  return NextResponse.json({ member: data }, { status: 201 })
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const supabase = await createServerSupabaseClient()
  const gate = await requireAdmin(supabase)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const { id } = await params
  const body = await request.json().catch(() => ({})) as { user_id?: string; role?: string }
  const userId = (body.user_id ?? '').trim()
  const role = (body.role as Role | undefined)
  if (!userId || !role || !ROLES.includes(role)) {
    return NextResponse.json({ error: 'user_id and valid role required' }, { status: 400 })
  }

  const admin = createAdminSupabaseClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from('company_members')
    .update({ role })
    .eq('company_id', id)
    .eq('user_id', userId)
    .select('company_id, user_id, role, is_default, joined_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ member: data })
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const supabase = await createServerSupabaseClient()
  const gate = await requireAdmin(supabase)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const { id } = await params
  const url = new URL(request.url)
  const userId = url.searchParams.get('user_id')
  if (!userId) {
    return NextResponse.json({ error: 'user_id query param required' }, { status: 400 })
  }

  const admin = createAdminSupabaseClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from('company_members')
    .delete()
    .eq('company_id', id)
    .eq('user_id', userId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
