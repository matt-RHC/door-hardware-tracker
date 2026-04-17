import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import type { Json } from '@/lib/types/database'

export const maxDuration = 10

/**
 * POST /api/jobs/[id]/answers — Submit user constraint answers for a job.
 *
 * Upserts answers into job_user_constraints table. These answers can be
 * used by the triage phase as user hints for classification accuracy.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: jobId } = await params

  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
    }

    // Verify user has access to this job via RLS
    const { data: job, error: jobError } = await supabase
      .from('extraction_jobs')
      .select('id, project_id')
      .eq('id', jobId)
      .single()

    if (jobError || !job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const body = await request.json()
    const { answers } = body as {
      answers: Array<{ questionKey: string; answerValue: unknown }>
    }

    if (!answers || !Array.isArray(answers) || answers.length === 0) {
      return NextResponse.json({ error: 'Missing or empty answers array' }, { status: 400 })
    }

    // Use admin client for upsert (avoids RLS complexity for server-side writes)
    const adminSupabase = createAdminSupabaseClient()

    let savedCount = 0
    for (const answer of answers) {
      if (!answer.questionKey) continue

      const { error: upsertError } = await adminSupabase
        .from('job_user_constraints')
        .upsert(
          {
            job_id: jobId,
            question_key: answer.questionKey,
            answer_value: (answer.answerValue ?? null) as Json,
            answered_at: new Date().toISOString(),
          },
          { onConflict: 'job_id,question_key' }
        )

      if (upsertError) {
        console.error(`Failed to upsert constraint ${answer.questionKey}:`, upsertError.message)
      } else {
        savedCount++
      }
    }

    return NextResponse.json({ saved: savedCount })
  } catch (error) {
    console.error('POST /api/jobs/[id]/answers error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save answers' },
      { status: 500 }
    )
  }
}
