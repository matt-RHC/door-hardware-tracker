import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'
import { callDeepExtraction, type DeepExtractResult } from '@/lib/parse-pdf-helpers'

// Haiku is fast — 300s is generous
export const maxDuration = 300

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
    }

    const body = await request.json()
    const { pdfBase64, emptySets } = body as {
      pdfBase64: string
      emptySets: Array<{ set_id: string; heading: string }>
    }

    if (!pdfBase64) {
      return NextResponse.json({ error: 'Missing pdfBase64' }, { status: 400 })
    }
    if (!emptySets || emptySets.length === 0) {
      return NextResponse.json({ error: 'No empty sets provided' }, { status: 400 })
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    const results: DeepExtractResult[] = await callDeepExtraction(
      client,
      pdfBase64,
      emptySets,
    )

    const totalItems = results.reduce(
      (sum, r) => sum + (r.items?.length ?? 0),
      0,
    )

    console.debug(
      `[deep-extract] ${emptySets.length} empty sets → ${results.length} sets returned, ` +
      `${totalItems} total items extracted`
    )

    return NextResponse.json({ sets: results })
  } catch (error) {
    console.error('Deep extract error:', error)
    const message = error instanceof Error ? error.message : 'Deep extraction failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
