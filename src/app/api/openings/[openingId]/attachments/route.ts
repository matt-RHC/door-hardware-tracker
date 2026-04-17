import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { v4 as uuidv4 } from 'uuid'
import { assertProjectInUserCompany, CompanyAccessError } from '@/lib/companies'

// Signed URL expiry: 10 minutes. Mobile playback and image display on
// slow connections need room; RLS + the per-request company assertion
// still gate access, so a short TTL is cheap defense-in-depth.
const SIGNED_URL_EXPIRES_IN = 600

/**
 * Derive the storage path from a file_url value.
 *
 * Handles both formats that may exist in the database:
 *   1. Legacy public URL:
 *      https://<project>.supabase.co/storage/v1/object/public/attachments/<path>
 *   2. New storage path (stored directly after this migration):
 *      <project_id>/<opening_id>/<file_id>.<ext>
 */
function storagePathFromUrl(fileUrl: string): string {
  // Already a plain path (no slashes from a domain)
  if (!fileUrl.startsWith('http')) return fileUrl

  // Strip the bucket prefix from legacy public URLs
  const marker = '/object/public/attachments/'
  const idx = fileUrl.indexOf(marker)
  if (idx !== -1) return fileUrl.slice(idx + marker.length)

  // Fallback: return as-is (createSignedUrl will fail gracefully)
  return fileUrl
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ openingId: string }> }
) {
  try {
    const supabase = await createServerSupabaseClient()

    // Check authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { openingId } = await params

    // Verify opening exists and user has access
    const { data: opening, error: openingError } = await supabase
      .from('openings')
      .select('project_id')
      .eq('id', openingId)
      .single()

    if (openingError || !opening) {
      return NextResponse.json(
        { error: 'Opening not found' },
        { status: 404 }
      )
    }

    // Strict company + project membership check. This replaces the
    // previous project_members-only check and is load-bearing on any
    // future route that signs URLs (RLS + the assertion together).
    try {
      await assertProjectInUserCompany(supabase, (opening as any).project_id)
    } catch (err) {
      if (err instanceof CompanyAccessError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    // Get attachments (raw rows — file_url may be a storage path or legacy public URL)
    const { data: attachments, error: attachmentsError } = await supabase
      .from('attachments')
      .select('id, opening_id, file_name, file_url, file_type, category, created_at, uploaded_by, uploaded_at')
      .eq('opening_id', openingId)
      .order('created_at', { ascending: false })

    if (attachmentsError) {
      console.error('Error fetching attachments:', attachmentsError)
      return NextResponse.json(
        { error: 'Failed to fetch attachments' },
        { status: 500 }
      )
    }

    // Generate signed URLs for each attachment (bucket is now private).
    // Replace file_url with a short-lived signed URL so the client can
    // render images and PDFs without exposing the bucket publicly.
    const withSignedUrls = await Promise.all(
      (attachments ?? []).map(async (att: any) => {
        const storagePath = storagePathFromUrl(att.file_url)
        const { data: signed, error: signError } = await supabase.storage
          .from('attachments')
          .createSignedUrl(storagePath, SIGNED_URL_EXPIRES_IN)

        if (signError || !signed?.signedUrl) {
          console.error(`Failed to sign URL for attachment ${att.id}:`, signError?.message)
          // Return without a usable URL rather than failing the whole request
          return { ...att, file_url: null, signed_url_error: true }
        }

        return { ...att, file_url: signed.signedUrl }
      })
    )

    return NextResponse.json(withSignedUrls)
  } catch (error) {
    console.error('Attachments GET error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ openingId: string }> }
) {
  try {
    const supabase = await createServerSupabaseClient()

    // Check authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { openingId } = await params

    // Verify opening exists and user has access
    const { data: opening, error: openingError } = await supabase
      .from('openings')
      .select('project_id')
      .eq('id', openingId)
      .single()

    if (openingError || !opening) {
      return NextResponse.json(
        { error: 'Opening not found' },
        { status: 404 }
      )
    }

    try {
      await assertProjectInUserCompany(supabase, (opening as any).project_id)
    } catch (err) {
      if (err instanceof CompanyAccessError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    // Parse form data
    const formData = await request.formData()
    const file = formData.get('file') as File
    const category = (formData.get('category') as string) || 'general'

    if (!file) {
      return NextResponse.json(
        { error: 'No file provided' },
        { status: 400 }
      )
    }

    // Generate unique file path
    const fileId = uuidv4()
    const fileExtension = file.name.split('.').pop()
    const storagePath = `${(opening as any).project_id}/${openingId}/${fileId}.${fileExtension}`

    // Upload to storage
    const buffer = await file.arrayBuffer()
    const { error: uploadError } = await supabase.storage
      .from('attachments')
      .upload(storagePath, buffer, {
        contentType: file.type,
      })

    if (uploadError) {
      console.error('Error uploading file:', uploadError)
      return NextResponse.json(
        { error: 'Failed to upload file' },
        { status: 500 }
      )
    }

    // Store the storage path (not a public URL) in file_url.
    // The bucket is now private — the GET handler generates signed URLs
    // at read time. Storing the path keeps file_url portable across
    // project URL changes and avoids leaking expiring tokens to the DB.
    const { data: attachment, error: recordError } = await supabase
      .from('attachments')
      .insert([{
        opening_id: openingId,
        file_name: file.name,
        file_type: file.type,
        file_url: storagePath,
        category,
        uploaded_by: user.id,
      } as any] as any)
      .select()
      .single()

    if (recordError) {
      console.error('Error creating attachment record:', recordError)
      return NextResponse.json(
        { error: 'Failed to create attachment record' },
        { status: 500 }
      )
    }

    // Generate a signed URL for the immediate response so the client
    // can display the uploaded file without a separate GET request.
    const { data: signed } = await supabase.storage
      .from('attachments')
      .createSignedUrl(storagePath, SIGNED_URL_EXPIRES_IN)

    return NextResponse.json(
      { ...(attachment as any), file_url: signed?.signedUrl ?? null },
      { status: 201 }
    )
  } catch (error) {
    console.error('Attachments POST error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
