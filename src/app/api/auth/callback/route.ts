import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

/**
 * OAuth callback with company resolution.
 *
 * Sequence:
 *   1. Exchange the auth code for a session (Supabase mints cookies).
 *   2. getUser() — populated by the just-exchanged cookies.
 *   3. JWT fast path: if app_metadata.company_id is already set (trigger
 *      ran or a previous session), redirect to /dashboard with no DB hit.
 *   4. Fallback: single company_members SELECT.
 *   5. Still no membership? Call try_domain_auto_join RPC — covers users
 *      whose account pre-dates the company_domains registration.
 *   6. Still nothing? Redirect to /auth/no-company?d=<domain>.
 *
 * The redirect URL honors `x-forwarded-host` so Vercel's edge keeps the
 * hostname consistent across the OAuth round-trip (per the Supabase
 * Google auth doc).
 */

export const runtime = 'nodejs'

function hostOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get('x-forwarded-host')
  const forwardedProto = request.headers.get('x-forwarded-proto') ?? 'https'
  if (forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`
  }
  return new URL(request.url).origin
}

function domainFromEmail(email: string | null | undefined): string | null {
  if (!email) return null
  const at = email.indexOf('@')
  if (at < 0 || at === email.length - 1) return null
  return email.slice(at + 1).toLowerCase()
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const code = searchParams.get('code')

    if (!code) {
      return NextResponse.json({ error: 'Missing authorization code' }, { status: 400 })
    }

    const origin = hostOrigin(request)
    const supabase = await createServerSupabaseClient()

    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
    if (exchangeError) {
      console.error('Error exchanging code for session:', exchangeError)
      return NextResponse.redirect(new URL('/auth/error', origin))
    }

    const { data: userResult } = await supabase.auth.getUser()
    const user = userResult?.user
    if (!user) {
      return NextResponse.redirect(new URL('/', origin))
    }

    // 1. JWT fast path.
    const fromJwt =
      ((user.app_metadata as Record<string, unknown> | null)?.company_id as string | undefined) ?? null
    if (fromJwt) {
      return NextResponse.redirect(new URL('/dashboard', origin))
    }

    // 2. Existing membership that hasn't been stamped to the JWT yet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: membership } = await (supabase as any)
      .from('company_members')
      .select('company_id')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle()

    if (membership?.company_id) {
      return NextResponse.redirect(new URL('/dashboard', origin))
    }

    // 3. RPC — covers pre-existing users whose company domain was
    // registered after their account was created.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rpcCompanyId } = await (supabase as any).rpc('try_domain_auto_join')
    if (rpcCompanyId) {
      return NextResponse.redirect(new URL('/dashboard', origin))
    }

    // 4. No resolution — punt to the friendly dead-end page.
    const domain = domainFromEmail(user.email)
    const redirectUrl = new URL('/auth/no-company', origin)
    if (domain) redirectUrl.searchParams.set('d', domain)
    return NextResponse.redirect(redirectUrl)
  } catch (error) {
    console.error('Auth callback error:', error)
    return NextResponse.redirect(new URL('/auth/error', request.url))
  }
}
