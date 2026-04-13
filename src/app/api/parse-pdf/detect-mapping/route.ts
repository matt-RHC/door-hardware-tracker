import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const maxDuration = 120

/**
 * Authenticated proxy to the Python `/api/detect-mapping` endpoint.
 *
 * The Python endpoint is publicly reachable on the Vercel deployment URL
 * and protected only by an X-Internal-Token shared secret. This route
 * sits between the browser and Python: it checks that the caller is
 * signed in via Supabase, then forwards the request with the secret
 * injected server-side so the token is never exposed to the client.
 *
 * Matches the pattern used by parse-pdf/region-extract/route.ts.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
    }

    const body = await request.json()

    const requestOrigin = new URL(request.url).origin
    const baseUrl = process.env.PYTHON_API_URL
      ?? (requestOrigin !== 'null' ? requestOrigin : null)
      ?? process.env.NEXT_PUBLIC_APP_URL
      ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

    const internalToken = process.env.PYTHON_INTERNAL_SECRET ?? ''

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 60_000)

    try {
      const response = await fetch(`${baseUrl}/api/detect-mapping`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(internalToken ? { 'X-Internal-Token': internalToken } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      const rawText = await response.text()

      if (!response.ok) {
        console.error('[detect-mapping proxy] Python error:', response.status, rawText.slice(0, 500))
        return NextResponse.json(
          { error: `Column detection failed: ${response.status}` },
          { status: response.status === 401 ? 500 : 502 },
        )
      }

      return new NextResponse(rawText, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    console.error('[detect-mapping proxy] Error:', error)
    const message = error instanceof Error ? error.message : 'Column detection failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
