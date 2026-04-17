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
 * Map a company's registered provider preference. Admins may set
 * `company_domains.preferred_provider` to pin a domain to `google` or
 * `azure`; when NULL we fall back to a tiny heuristic that only routes
 * literal `*.onmicrosoft.com` tenant domains to Azure and defaults the
 * rest to Google.
 *
 * Known limitation: an Azure AD tenant with a vanity domain (e.g.
 * dpr.com) whose admin hasn't set `preferred_provider` yet gets routed
 * to Google by the heuristic. Those customers should fall through to the
 * fallback OAuth pills under the divider, or have an admin set
 * `preferred_provider='azure'` for their domain.
 */
export function providerForDomain(domain: string): 'google' | 'azure' {
  const microsoftFirst = /\.onmicrosoft\.com$/i
  if (microsoftFirst.test(domain)) return 'azure'
  return 'google'
}

/**
 * Pure helper: honour an explicit `preferred_provider` override if set,
 * otherwise fall through to the regex heuristic. Exported for unit tests
 * so the POST handler doesn't need Supabase mocking.
 */
export function resolveProviderForDomain(
  domain: string,
  preferredProvider: 'google' | 'azure' | null | undefined,
): 'google' | 'azure' {
  return preferredProvider ?? providerForDomain(domain)
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
    .select('company_id, preferred_provider, companies ( name )')
    .eq('domain', domain)
    .maybeSingle()

  if (companyDomain && companyDomain.company_id) {
    const companyName =
      (companyDomain.companies as { name?: string } | null)?.name ??
      'your organization'
    const preferred = (companyDomain.preferred_provider ?? null) as
      | 'google'
      | 'azure'
      | null
    return NextResponse.json({
      kind: 'sso',
      provider: resolveProviderForDomain(domain, preferred),
      company_name: companyName,
    } as const)
  }

  // Domain is NOT registered. Check whether the email has a *password*
  // identity in `auth.identities`. We deliberately do not just check
  // for an existing user: an OAuth-only user (no password row) should
  // never see the password slot.
  //
  // The supabase-js admin SDK has no `filter` parameter on listUsers —
  // earlier code passed one and it was silently ignored, so this branch
  // mostly fell through to `unknown` even for legit password users.
  // Migration 043 ships `public.has_password_identity(text)`
  // SECURITY DEFINER, called via the service role.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: hasPassword, error: rpcErr } = await (admin as any).rpc(
      'has_password_identity',
      { p_email: email },
    )
    if (!rpcErr && hasPassword === true) {
      return NextResponse.json({ kind: 'password' } as const)
    }
  } catch {
    // Fall through to `unknown` — never leak the error to the caller.
  }

  return NextResponse.json({ kind: 'unknown' } as const)
}
