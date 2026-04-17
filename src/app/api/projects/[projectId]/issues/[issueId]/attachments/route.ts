import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { v4 as uuidv4 } from 'uuid'

const SIGNED_URL_EXPIRES_IN = 3600

type RouteParams = { params: Promise<{ projectId: string; issueId: string }> }

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId, issueId } = await params

    const { data: membership } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // Verify issue belongs to project
    const { data: issue } = await (supabase as any)
      .from('issues')
      .select('id')
      .eq('id', issueId)
      .eq('project_id', projectId)
      .single()

    if (!issue) {
      return NextResponse.json({ error: 'Issue not found' }, { status: 404 })
    }

    const { data: attachments, error } = await (supabase as any)
      .from('issue_attachments')
      .select('*')
      .eq('issue_id', issueId)
      .order('uploaded_at', { ascending: false })

    if (error) {
      console.error('Attachments GET error:', error)
      return NextResponse.json({ error: 'Failed to fetch attachments' }, { status: 500 })
    }

    // Generate signed URLs for each attachment
    const withSignedUrls = await Promise.all(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (attachments ?? []).map(async (att: any) => {
        const { data: signed, error: signError } = await supabase.storage
          .from('issue-evidence')
          .createSignedUrl(att.storage_path, SIGNED_URL_EXPIRES_IN)

        if (signError || !signed?.signedUrl) {
          console.error(`Failed to sign URL for attachment ${att.id}:`, signError?.message)
          return { ...att, signed_url: null }
        }

        return { ...att, signed_url: signed.signedUrl }
      })
    )

    return NextResponse.json(withSignedUrls)
  } catch (error) {
    console.error('Attachments GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId, issueId } = await params

    const { data: membership } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    // Verify issue belongs to project
    const { data: issue } = await (supabase as any)
      .from('issues')
      .select('id')
      .eq('id', issueId)
      .eq('project_id', projectId)
      .single()

    if (!issue) {
      return NextResponse.json({ error: 'Issue not found' }, { status: 404 })
    }

    const formData = await request.formData()
    const file = formData.get('file') as File
    const fileType = (formData.get('file_type') as string) || 'document'
    const transcript = formData.get('transcript') as string | null
    const transcriptSource = formData.get('transcript_source') as string | null

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    // Generate unique storage path
    const fileId = uuidv4()
    const fileExtension = file.name.split('.').pop()
    const timestamp = Date.now()
    const storagePath = `issues/${projectId}/${issueId}/${timestamp}-${fileId}.${fileExtension}`

    // Upload to Supabase Storage
    const buffer = await file.arrayBuffer()
    const { error: uploadError } = await supabase.storage
      .from('issue-evidence')
      .upload(storagePath, buffer, { contentType: file.type })

    if (uploadError) {
      console.error('Error uploading file:', uploadError)
      return NextResponse.json({ error: 'Failed to upload file' }, { status: 500 })
    }

    // Create attachment record
    const { data: attachment, error: recordError } = await (supabase as any)
      .from('issue_attachments')
      .insert({
        issue_id: issueId,
        file_name: file.name,
        file_type: fileType,
        file_size_bytes: file.size,
        content_type: file.type,
        storage_path: storagePath,
        transcript: transcript || null,
        transcript_source: transcriptSource || null,
        uploaded_by: user.id,
      })
      .select()
      .single()

    if (recordError) {
      console.error('Error creating attachment record:', recordError)
      return NextResponse.json({ error: 'Failed to create attachment record' }, { status: 500 })
    }

    // Generate signed URL for immediate response
    const { data: signed } = await supabase.storage
      .from('issue-evidence')
      .createSignedUrl(storagePath, SIGNED_URL_EXPIRES_IN)

    return NextResponse.json(
      { ...attachment, signed_url: signed?.signedUrl ?? null },
      { status: 201 }
    )
  } catch (error) {
    console.error('Attachments POST error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
