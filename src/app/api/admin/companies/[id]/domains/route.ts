import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/admin-auth'
import { isDisallowedDomain, normalizeDomain } from '@/lib/companies'

export const runtime = 'nodejs'

/**
 * GET /api/admin/companies/[id]/domains
 * POST /api/admin/companies/[id]/domains { domain }
 * PATCH /api/admin/companies/[id]/domains { domain_id, preferred_provider }
 * DELETE /api/admin/companies/[id]/domains?domain_id=<uuid>
 *
 * Admin-gated on every handler.
 *
 * Rejects consumer providers client-side via isDisallowedDomain and
 * server-side via the disallowed_domains table lookup.
 */

type RouteParams = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: RouteParams) {
  const supabase = await createServerSupabaseClient()
  const gate = await requireAdmin(supabase)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const { id } = await params
  const admin = createAdminSupabaseClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from('company_domains')
    .select('id, domain, verified_at, created_at, preferred_provider')
    .eq('company_id', id)
    .order('domain', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ domains: data ?? [] })
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const supabase = await createServerSupabaseClient()
  const gate = await requireAdmin(supabase)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const { id } = await params
  const body = await request.json().catch(() => ({})) as { domain?: string }
  const domain = normalizeDomain(body.domain ?? '')
  if (!domain) {
    return NextResponse.json({ error: 'Valid domain required' }, { status: 400 })
  }
  if (isDisallowedDomain(domain)) {
    return NextResponse.json(
      { error: `Public email provider domains cannot be registered (${domain}).` },
      { status: 400 },
    )
  }

  const admin = createAdminSupabaseClient()

  // Server-side disallow check — defence in depth against future edits
  // to the hard-coded list diverging from the DB seed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: disallowed } = await (admin as any)
    .from('disallowed_domains')
    .select('domain')
    .eq('domain', domain)
    .maybeSingle()
  if (disallowed) {
    return NextResponse.json(
      { error: `Public email provider domains cannot be registered (${domain}).` },
      { status: 400 },
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from('company_domains')
    .insert({ company_id: id, domain })
    .select('id, domain, verified_at, created_at, preferred_provider')
    .single()

  if (error) {
    const status = error.code === '23505' ? 409 : 500
    return NextResponse.json({ error: error.message }, { status })
  }
  return NextResponse.json({ domain: data }, { status: 201 })
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const supabase = await createServerSupabaseClient()
  const gate = await requireAdmin(supabase)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const { id } = await params
  const body = (await request.json().catch(() => ({}))) as {
    domain_id?: string
    preferred_provider?: 'google' | 'azure' | null
  }

  const domainId = typeof body.domain_id === 'string' ? body.domain_id.trim() : ''
  if (!domainId) {
    return NextResponse.json({ error: 'domain_id required' }, { status: 400 })
  }

  // preferred_provider must be one of 'google' | 'azure' | null. Explicit
  // null clears the override and returns the domain to the code-side
  // heuristic in /api/auth/resolve.
  const provider = body.preferred_provider
  if (provider !== null && provider !== 'google' && provider !== 'azure') {
    return NextResponse.json(
      { error: "preferred_provider must be 'google', 'azure', or null" },
      { status: 400 },
    )
  }

  const admin = createAdminSupabaseClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin as any)
    .from('company_domains')
    .update({ preferred_provider: provider })
    .eq('id', domainId)
    .eq('company_id', id)
    .select('id, domain, verified_at, created_at, preferred_provider')
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) {
    return NextResponse.json({ error: 'Domain not found for this company' }, { status: 404 })
  }
  return NextResponse.json({ domain: data })
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const supabase = await createServerSupabaseClient()
  const gate = await requireAdmin(supabase)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  const { id } = await params
  const url = new URL(request.url)
  const domainId = url.searchParams.get('domain_id')
  if (!domainId) {
    return NextResponse.json({ error: 'domain_id query param required' }, { status: 400 })
  }

  const admin = createAdminSupabaseClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (admin as any)
    .from('company_domains')
    .delete()
    .eq('id', domainId)
    .eq('company_id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
