import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createAdminSupabaseClient } from '@/lib/supabase/server'

const BUCKET = 'submittals'
const SIGNED_URL_TTL_SECONDS = 60 * 10 // 10 minutes

/**
 * GET /api/projects/[projectId]/pdf-url
 *
 * Returns a short-lived signed URL for the project's submittal PDF so the
 * client can open it directly in a browser tab. Callers may append a
 * "#page=N" (1-based) fragment on the returned URL to jump to a specific
 * page in the browser's built-in PDF viewer.
 *
 * Requires the caller to be a project member.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const supabase = await createServerSupabaseClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId } = await params

    // Verify project membership via RLS-friendly select
    const { data: projectMember, error: memberError } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (memberError || !projectMember) {
      return NextResponse.json(
        { error: 'Access denied to this project' },
        { status: 403 },
      )
    }

    // Look up the project's PDF storage path
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

    // Issue a signed URL via the admin client (the submittals bucket is
    // private, so the user-scoped client cannot sign it directly).
    const admin = createAdminSupabaseClient()
    const { data: signed, error: signError } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS)

    if (signError || !signed?.signedUrl) {
      console.error('Failed to sign PDF URL:', signError)
      return NextResponse.json(
        { error: signError?.message ?? 'Failed to create signed URL' },
        { status: 500 },
      )
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
