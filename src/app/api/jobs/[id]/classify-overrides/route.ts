import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import {
  ClassifyOverridesRequestSchema,
  applyClassifyOverrides,
  type ClassifyPageDetail,
} from '@/lib/schemas/classify'
import type { PageClassification } from '@/lib/types'

export const maxDuration = 10

/**
 * POST /api/jobs/[id]/classify-overrides
 *
 * Persist user corrections to page classifications made in StepQuestions.
 * The orchestrator re-reads these before extraction (phase 3.5) so the
 * corrections take effect even if the user saves them just-in-time while
 * classification has already published.
 *
 * This endpoint rewrites the derived arrays in phase_data.classify
 * (schedule_pages, hardware_pages, etc.) so downstream UI reads see
 * the corrected state without the caller having to re-apply. It also
 * keeps user_overrides around so the orchestrator can replay them on
 * retry.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: jobId } = await params

  try {
    // ── Auth ──
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
    }

    // RLS check — an anon / unauthorized user won't see the job row.
    const { data: job, error: jobError } = await supabase
      .from('extraction_jobs')
      .select('id, phase_data, classify_result')
      .eq('id', jobId)
      .single()

    if (jobError || !job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    // ── Validate body ──
    const body = await request.json().catch(() => null)
    const parsed = ClassifyOverridesRequestSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid overrides payload', details: parsed.error.issues },
        { status: 400 },
      )
    }
    const { overrides } = parsed.data

    // ── Recompute the phase_data.classify payload ──
    //
    // We prefer page_details from phase_data.classify (already in the
    // Prompt-4 shape). Fallback to deriving it from classify_result.pages
    // for older jobs that predate the enriched payload — this keeps the
    // endpoint usable even for in-flight jobs written by a previous
    // orchestrator version.
    const phaseData =
      job.phase_data && typeof job.phase_data === 'object' && !Array.isArray(job.phase_data)
        ? (job.phase_data as Record<string, unknown>)
        : {}
    const existingClassify =
      phaseData.classify && typeof phaseData.classify === 'object'
        ? (phaseData.classify as Record<string, unknown>)
        : {}

    let pageDetails: ClassifyPageDetail[] = Array.isArray(existingClassify.page_details)
      ? (existingClassify.page_details as ClassifyPageDetail[])
      : []

    if (pageDetails.length === 0) {
      const classifyResult = job.classify_result as
        | { pages?: PageClassification[] }
        | null
      if (classifyResult?.pages) {
        pageDetails = classifyResult.pages.map((p) => ({
          page: p.page_number,
          type:
            p.page_type === 'hardware_sets'
              ? 'hardware_set'
              : (p.page_type as ClassifyPageDetail['type']),
          confidence: p.confidence,
          labels: p.section_labels ?? [],
          hw_set_ids: p.hw_set_ids ?? [],
        }))
      }
    }

    if (pageDetails.length === 0) {
      return NextResponse.json(
        { error: 'Job has no classification data yet — wait for classify phase to complete' },
        { status: 409 },
      )
    }

    const totalPages =
      typeof existingClassify.total_pages === 'number'
        ? (existingClassify.total_pages as number)
        : pageDetails.length

    const corrected = applyClassifyOverrides(pageDetails, overrides)

    const nextClassify = {
      total_pages: totalPages,
      schedule_pages: corrected.schedule_pages,
      hardware_pages: corrected.hardware_pages,
      reference_pages: corrected.reference_pages,
      cover_pages: corrected.cover_pages,
      skipped_pages: corrected.skipped_pages,
      page_details: corrected.pageDetails,
      user_overrides: overrides,
    }

    // Use admin client for the write — RLS was already checked above,
    // and the admin client avoids write-policy complexity for
    // server-side updates. Same pattern as /answers.
    const adminSupabase = createAdminSupabaseClient()
    const { error: writeErr } = await adminSupabase
      .from('extraction_jobs')
      .update({
        phase_data: { ...phaseData, classify: nextClassify },
        updated_at: new Date().toISOString(),
      })
      .eq('id', jobId)

    if (writeErr) {
      console.error(`[classify-overrides] write failed for ${jobId}:`, writeErr.message)
      return NextResponse.json({ error: 'Failed to save overrides' }, { status: 500 })
    }

    return NextResponse.json({
      saved: overrides.length,
      excluded_pages: corrected.excluded_pages,
      schedule_pages: corrected.schedule_pages,
      hardware_pages: corrected.hardware_pages,
      reference_pages: corrected.reference_pages,
      cover_pages: corrected.cover_pages,
      skipped_pages: corrected.skipped_pages,
    })
  } catch (error) {
    console.error('POST /api/jobs/[id]/classify-overrides error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save overrides' },
      { status: 500 },
    )
  }
}
