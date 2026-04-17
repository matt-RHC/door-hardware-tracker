import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import { checkExtractionRateLimit } from '@/lib/extraction-rate-limit'
import { logActivity } from '@/lib/activity-log'

export const maxDuration = 30

/**
 * POST /api/jobs — Create a new background extraction job.
 *
 * 1. Authenticate user and verify project membership
 * 2. Verify PDF exists in storage (read projects.pdf_storage_path)
 * 3. INSERT extraction_jobs row (status='queued')
 * 4. Fire-and-forget: fetch /api/jobs/:id/run with service role header
 * 5. Return 202 { jobId, status: 'queued' }
 */
export async function POST(request: NextRequest) {
  try {
    // Auth check
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
    }

    const body = await request.json()
    const { projectId } = body as { projectId: string }

    if (!projectId) {
      return NextResponse.json({ error: 'Missing projectId' }, { status: 400 })
    }

    // Verify project membership
    const { data: member, error: memberError } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (memberError || !member) {
      return NextResponse.json({ error: 'Not a member of this project' }, { status: 403 })
    }

    // Read project to verify PDF exists in storage
    const adminSupabase = createAdminSupabaseClient()
    const { data: project, error: projectError } = await adminSupabase
      .from('projects')
      .select('pdf_storage_path, last_pdf_hash, pdf_page_count')
      .eq('id', projectId)
      .single()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const projectRow = project as any
    if (projectError || !projectRow?.pdf_storage_path) {
      return NextResponse.json(
        { error: 'No PDF uploaded for this project. Upload a PDF first.' },
        { status: 400 }
      )
    }

    // Rate limit: max 5 extraction jobs per project per hour
    const rateLimit = await checkExtractionRateLimit(projectId)
    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          error: `Too many recent extractions for this project (${rateLimit.recentCount}/${rateLimit.limit} in the last hour). Please wait before starting another.`,
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        },
        { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfterSeconds ?? 3600) } }
      )
    }

    // Create extraction_jobs row
    const { data: job, error: insertError } = await adminSupabase
      .from('extraction_jobs')
      .insert({
        project_id: projectId,
        created_by: user.id,
        status: 'queued',
        pdf_storage_path: projectRow.pdf_storage_path,
        pdf_hash: projectRow.last_pdf_hash ?? null,
        pdf_page_count: projectRow.pdf_page_count ?? null,
      })
      .select('id')
      .single()

    if (insertError || !job) {
      console.error('Failed to create extraction job:', insertError)
      return NextResponse.json(
        { error: 'Failed to create extraction job' },
        { status: 500 }
      )
    }

    const jobId = job.id

    // Audit trail
    await logActivity({
      projectId,
      userId: user.id,
      action: 'extraction_job_created',
      entityType: 'extraction_job',
      entityId: jobId,
      details: {
        pdfHash: projectRow.last_pdf_hash,
        pageCount: projectRow.pdf_page_count,
      },
    })

    // Fire-and-forget: kick off the run endpoint
    const requestOrigin = new URL(request.url).origin
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL
      || (requestOrigin && requestOrigin !== 'null' ? requestOrigin : null)
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

    fetch(`${baseUrl}/api/jobs/${jobId}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': process.env.CRON_SECRET!,
      },
    }).catch(err => {
      console.error(`Fire-and-forget /api/jobs/${jobId}/run failed:`, err)
    })

    return NextResponse.json({ jobId, status: 'queued' }, { status: 202 })
  } catch (error) {
    console.error('POST /api/jobs error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
