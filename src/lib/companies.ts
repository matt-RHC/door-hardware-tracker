/**
 * Company tenancy helpers.
 *
 * These functions are the single load-bearing boundary for tenant
 * isolation on the server. Every API route that uses the admin
 * (service-role) client to sign URLs or write data MUST call
 * `assertProjectInUserCompany` first — the admin client bypasses RLS, so
 * without this explicit check a caller in company A could read company
 * B's data by passing a project ID they don't own.
 *
 * Safe to import from any server code path. Do not import into client
 * components.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/types/database'

// Using `any` on DB results where the regenerated database.ts hasn't been
// refreshed yet (companies / company_members / company_id were added by
// migrations 038–042). Re-run the Supabase MCP `generate_typescript_types`
// against project `jfecdnosrwaqrekoryqt` after applying 038+ to remove
// these casts.
/* eslint-disable @typescript-eslint/no-explicit-any */

export type UserSupabaseClient = SupabaseClient<Database>

export class CompanyAccessError extends Error {
  public readonly status: 401 | 403 | 404
  constructor(status: 401 | 403 | 404, message: string) {
    super(message)
    this.name = 'CompanyAccessError'
    this.status = status
  }
}

/**
 * Resolve the caller's active company.
 *
 * Preference order:
 *   1. JWT `app_metadata.company_id` (populated by the auto-join trigger /
 *      RPC; zero DB hits).
 *   2. Earliest-joined company_members row for the caller (single select).
 *   3. null — caller has no company membership at all (should redirect to
 *      /auth/no-company).
 */
export async function getActiveCompanyId(
  supabase: UserSupabaseClient,
): Promise<string | null> {
  const { data: userResult } = await supabase.auth.getUser()
  const user = userResult?.user
  if (!user) return null

  const fromJwt =
    ((user.app_metadata as Record<string, unknown> | null)?.company_id as string | undefined) ?? null
  if (fromJwt) return fromJwt

  const { data } = await (supabase as any)
    .from('company_members')
    .select('company_id, is_default, joined_at')
    .eq('user_id', user.id)
    .order('is_default', { ascending: false })
    .order('joined_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  return ((data as Record<string, unknown> | null)?.company_id as string | null) ?? null
}

/**
 * Verify the current caller is a company_member of the company that owns
 * the given project AND a project_member of the project itself. Throws
 * CompanyAccessError on any failure — callers turn that into a 401/403/404.
 *
 * Uses the USER-scoped client (not admin) for both lookups, so RLS
 * participates as a belt-and-suspenders check. If RLS is misconfigured
 * later and accidentally widens access, this assertion still fails
 * because we explicitly compare the project's company_id against the
 * user's company_members rows.
 */
export async function assertProjectInUserCompany(
  supabase: UserSupabaseClient,
  projectId: string,
): Promise<{ userId: string; companyId: string }> {
  const { data: userResult, error: userErr } = await supabase.auth.getUser()
  const user = userResult?.user
  if (userErr || !user) {
    throw new CompanyAccessError(401, 'Unauthorized')
  }

  // SELECT company_id via the user-scoped client. RLS must already permit
  // this read; if it doesn't, the project belongs to a different company
  // and we return 404 to avoid leaking existence.
  const { data: projectRow, error: projectErr } = await (supabase as any)
    .from('projects')
    .select('company_id')
    .eq('id', projectId)
    .maybeSingle()

  if (projectErr || !projectRow) {
    throw new CompanyAccessError(404, 'Project not found')
  }

  const companyId = (projectRow as { company_id?: string }).company_id
  if (!companyId) {
    // Legacy row with no company set — treat as forbidden. 039 backfill
    // should have filled every row; if we see this in prod, it's a bug.
    throw new CompanyAccessError(403, 'Project has no company assignment')
  }

  // Explicit company_members check — critical when the route downstream
  // uses the admin client and skips RLS.
  const { data: membership } = await (supabase as any)
    .from('company_members')
    .select('company_id')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) {
    throw new CompanyAccessError(403, 'Access denied (company)')
  }

  // And a project_members check — keep the project-level invariant.
  const { data: projectMembership } = await (supabase as any)
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!projectMembership) {
    throw new CompanyAccessError(403, 'Access denied (project)')
  }

  return { userId: user.id, companyId }
}

/**
 * List all registered domains for a company. Used by the admin UI.
 */
export async function listDomainsForCompany(
  supabase: UserSupabaseClient,
  companyId: string,
): Promise<Array<{ id: string; domain: string; verified_at: string | null }>> {
  const { data } = await (supabase as any)
    .from('company_domains')
    .select('id, domain, verified_at')
    .eq('company_id', companyId)
    .order('domain', { ascending: true })

  return (data ?? []) as Array<{ id: string; domain: string; verified_at: string | null }>
}

/**
 * Hard-coded public-email providers. Mirrors the `disallowed_domains`
 * table seed in migration 038. Used by the admin API to reject a domain
 * registration before it ever reaches the DB.
 */
const STATIC_DISALLOWED = new Set([
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com',
  'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.de',
  'fastmail.com', 'tutanota.com', 'zoho.com',
  'qq.com', '163.com', '126.com', 'sina.com',
  'yandex.ru', 'yandex.com', 'mail.ru',
])

export function isDisallowedDomain(domain: string): boolean {
  return STATIC_DISALLOWED.has(domain.trim().toLowerCase())
}

export function normalizeDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase()
  // Basic shape: at least one dot, no whitespace, no @, 4+ chars total.
  if (!trimmed || trimmed.length < 4) return null
  if (trimmed.includes('@')) return null
  if (trimmed.includes(' ')) return null
  if (!trimmed.includes('.')) return null
  return trimmed
}
