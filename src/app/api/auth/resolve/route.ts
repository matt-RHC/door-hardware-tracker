import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import { isDisallowedDomain } from '@/lib/companies'

export const runtime = 'nodejs'

/**
 * POST /api/auth/resolve
 *
 * Body: { email: string }
 *
 * Resolves how a given email address should sign in. Never reveals
 * whether an account exists: for any ambiguity or unknown domain the
 * response is `{ kind: 'unknown' }`, matching the WorkOS identifier-first
 * recommendation.
 *
 * Responses:
 *   { kind: 'sso', provider: 'google'|'azure', company_name: string }
 *   { kind: 'password' }
 *   { kind: 'unknown' }
 *
 * Rate limited in-memory to 20 requests / minute / IP. This limit is
 * best-effort — Vercel function instances can spin up in parallel, so a
 * determined attacker can bypass it. Its job is to make casual enumeration
 * expensive, not to stop a dedicated adversary.
 */

interface ResolveBody {
  email?: string
}

type ResolveResponse =
  | { kind: 'sso'; provider: 'google' | 'azure'; company_name: string }
  | { kind: 'password' }
  | { kind: 'unknown' }

// ── Rate limit: 20 req/min/IP ──────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 20
const rateBuckets = new Map<string, { count: number; resetAt: number }>()

function ratelimit(ip: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now()
  const bucket = rateBuckets.get(ip)
  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return { ok: true }
  }
  if (bucket.count >= RATE_LIMIT_MAX) {
    return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) }
  }
  bucket.count += 1
  return { ok: true }
}

function clientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? 'unknown'
}

function extractDomain(email: string): string | null {
  const trimmed = email.trim().toLowerCase()
  const at = trimmed.indexOf('@')
  if (at <= 0 || at === trimmed.length - 1) return null
  const domain = trimmed.slice(at + 1)
  if (!domain.includes('.') || /\s/.test(domain)) return null
  return domain
}

/**
 * Map a company's registered provider preference. v1 doesn't track this
 * per-company yet, so we apply a simple heuristic: Microsoft-owned corp
 * domains default to 'azure', everything else to 'google'. Customers can
 * override at the client by using the fallback OAuth buttons.
 *
 * Future: add `company_domains.preferred_provider` column.
 */
function providerForDomain(domain: string): 'google' | 'azure' {
  const microsoftFirst = /\.onmicrosoft\.com$/i
  if (microsoftFirst.test(domain)) return 'azure'
  return 'google'
}

export async function POST(request: NextRequest): Promise<NextResponse<ResolveResponse>> {
  const ip = clientIp(request)
  const rate = ratelimit(ip)
  if (!rate.ok) {
    return NextResponse.json(
      { kind: 'unknown' } as const,
      {
        status: 429,
        headers: { 'Retry-After': String(rate.retryAfter) },
      },
    )
  }

  let body: ResolveBody
  try {
    body = (await request.json()) as ResolveBody
  } catch {
    return NextResponse.json({ kind: 'unknown' } as const)
  }

  const email = (body.email ?? '').trim().toLowerCase()
  const domain = extractDomain(email)
  if (!domain) {
    return NextResponse.json({ kind: 'unknown' } as const)
  }

  // Public-email providers: never leak whether the account exists. Clients
  // with a consumer provider address always land on the fallback OAuth
  // buttons below the divider.
  if (isDisallowedDomain(domain)) {
    return NextResponse.json({ kind: 'unknown' } as const)
  }

  const admin = createAdminSupabaseClient()

  // Look up the company by domain. `maybeSingle` returns null (not an
  // error) when the domain isn't registered.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: companyDomain } = await (admin as any)
    .from('company_domains')
    .select('company_id, companies ( name )')
    .eq('domain', domain)
    .maybeSingle()

  if (companyDomain && companyDomain.company_id) {
    const companyName =
      (companyDomain.companies as { name?: string } | null)?.name ??
      'your organization'
    return NextResponse.json({
      kind: 'sso',
      provider: providerForDomain(domain),
      company_name: companyName,
    } as const)
  }

  // Domain is NOT registered. Check whether a password user exists with
  // this email. If yes → password flow. Otherwise → unknown.
  //
  // We use the admin API's listUsers() email filter. For the single
  // existing user (per §0 of the plan) this is negligible load. In a
  // larger tenancy we'd replace this with a custom indexed lookup.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: userLookup } = await (admin.auth.admin as any).listUsers({
      page: 1,
      perPage: 1,
      filter: `email.eq.${email}`,
    })

    const users = (userLookup?.users ?? []) as Array<{ email?: string }>
    if (users.some((u) => (u.email ?? '').toLowerCase() === email)) {
      return NextResponse.json({ kind: 'password' } as const)
    }
  } catch {
    // Fall through to `unknown` — never leak the error to the caller.
  }

  return NextResponse.json({ kind: 'unknown' } as const)
}
