import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import { assertProjectInUserCompany, CompanyAccessError } from '@/lib/companies'

const BUCKET = 'submittals'
const SIGNED_URL_TTL_SECONDS = 300 // 5 minutes; company isolation plan §2.

/**
 * GET /api/projects/[projectId]/pdf-url
 *
 * Returns a short-lived signed URL for the project's submittal PDF so
 * the client can open it in a new tab. Callers may append `#page=N` on
 * the returned URL.
 *
 * The submittals bucket is private, so the user-scoped Supabase client
 * cannot sign URLs — we fall through to the admin client after a strict
 * assertProjectInUserCompany check. Without this explicit assertion, a
 * caller in company A could request the PDF URL for company B's project
 * and get back a valid link (the admin client bypasses RLS).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const supabase = await createServerSupabaseClient()
    const { projectId } = await params

    try {
      await assertProjectInUserCompany(supabase, projectId)
    } catch (err) {
      if (err instanceof CompanyAccessError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    const { data: projectRow, error: projectError } = await supabase
      .from('projects')
      .select('pdf_storage_path, pdf_page_count')
      .eq('id', projectId)
      .single()

    const storagePath = (projectRow as Record<string, unknown> | null)?.pdf_storage_path as string | null
    const pageCount = (projectRow as Record<string, unknown> | null)?.pdf_page_count as number | null

    if (projectError || !storagePath) {
      return NextResponse.json(
        { error: 'No PDF has been uploaded for this project yet.' },
        { status: 404 },
      )
    }

    const admin = createAdminSupabaseClient()
    const { data: signed, error: signError } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS)

    if (signError || !signed?.signedUrl) {
      console.error('Failed to sign PDF URL:', signError)
      return NextResponse.json({ error: 'Failed to create signed URL' }, { status: 500 })
    }

    return NextResponse.json({
      url: signed.signedUrl,
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
      pageCount: pageCount ?? null,
    })
  } catch (error) {
    console.error('pdf-url GET error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
