import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { uploadProjectPdf } from '@/lib/pdf-storage'

/**
 * POST /api/projects/[projectId]/pdf
 *
 * Upload a submittal PDF to Supabase Storage.
 * Accepts FormData with:
 *   - file: the PDF file
 *   - pageCount: total pages (optional, from classify-pages)
 *
 * Returns: { storagePath, hash, pageCount, isDuplicate }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const supabase = await createServerSupabaseClient()

    // Auth check
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId } = await params

    // Verify project membership
    const { data: member, error: memberError } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (memberError || !member) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // Parse FormData
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const pageCountStr = formData.get('pageCount') as string | null

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    if (file.type !== 'application/pdf') {
      return NextResponse.json({ error: 'File must be a PDF' }, { status: 400 })
    }

    const pageCount = pageCountStr ? parseInt(pageCountStr, 10) : 0
    const fileBuffer = await file.arrayBuffer()

    const result = await uploadProjectPdf(projectId, fileBuffer, pageCount)

    return NextResponse.json({
      storagePath: result.storagePath,
      hash: result.hash,
      pageCount,
      isDuplicate: result.isDuplicate,
    })
  } catch (error) {
    console.error('PDF upload error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
