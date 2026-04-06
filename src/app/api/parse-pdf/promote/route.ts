import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { promoteExtraction } from '@/lib/extraction-staging'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
    }

    const body = await request.json()
    const { extractionRunId } = body as { extractionRunId: string }

    if (!extractionRunId) {
      return NextResponse.json({ error: 'Missing extractionRunId' }, { status: 400 })
    }

    const result = await promoteExtraction(supabase, extractionRunId, user.id)

    if (!result.success) {
      return NextResponse.json({ error: result.error ?? 'Promotion failed' }, { status: 400 })
    }

    console.log(`Promoted extraction run ${extractionRunId}: ${result.openingsPromoted} openings, ${result.itemsPromoted} items`)

    return NextResponse.json({
      success: true,
      openingsPromoted: result.openingsPromoted,
      itemsPromoted: result.itemsPromoted,
    })
  } catch (error) {
    console.error('Promote error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
