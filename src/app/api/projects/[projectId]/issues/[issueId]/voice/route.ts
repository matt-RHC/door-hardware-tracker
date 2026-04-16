import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { v4 as uuidv4 } from 'uuid'
import { summarizeTranscript } from '@/lib/ai/issue-parser'

const SIGNED_URL_EXPIRES_IN = 3600
const MAX_VOICE_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB
const ALLOWED_AUDIO_TYPES = [
  'audio/wav', 'audio/wave', 'audio/x-wav',
  'audio/mpeg', 'audio/mp3',
  'audio/mp4', 'audio/x-m4a', 'audio/m4a',
]

type RouteParams = { params: Promise<{ projectId: string; issueId: string }> }

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
    const transcript = formData.get('transcript') as string | null
    const transcriptSource = formData.get('transcript_source') as string | null

    if (!file) {
      return NextResponse.json({ error: 'No audio file provided' }, { status: 400 })
    }

    if (file.size > MAX_VOICE_SIZE_BYTES) {
      return NextResponse.json(
        { error: 'Audio file too large (max 10 MB)' },
        { status: 400 }
      )
    }

    if (!ALLOWED_AUDIO_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: 'Unsupported audio format. Accepted: WAV, MP3, M4A' },
        { status: 400 }
      )
    }

    // Determine file extension from type
    const extMap: Record<string, string> = {
      'audio/wav': 'wav', 'audio/wave': 'wav', 'audio/x-wav': 'wav',
      'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
      'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a',
    }
    const ext = extMap[file.type] || file.name.split('.').pop() || 'wav'

    const fileId = uuidv4()
    const timestamp = Date.now()
    const storagePath = `issue-evidence/${projectId}/${issueId}/voice-${timestamp}-${fileId}.${ext}`

    // Upload to Supabase Storage
    const buffer = await file.arrayBuffer()
    const { error: uploadError } = await supabase.storage
      .from('issue-evidence')
      .upload(storagePath, buffer, { contentType: file.type })

    if (uploadError) {
      console.error('Error uploading voice file:', uploadError)
      return NextResponse.json({ error: 'Failed to upload audio file' }, { status: 500 })
    }

    // Create attachment record
    const { data: attachment, error: recordError } = await (supabase as any)
      .from('issue_attachments')
      .insert({
        issue_id: issueId,
        file_name: file.name || `voice-${timestamp}.${ext}`,
        file_type: 'voice',
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
      console.error('Error creating voice attachment record:', recordError)
      return NextResponse.json({ error: 'Failed to create attachment record' }, { status: 500 })
    }

    // If transcript provided, optionally summarize with Haiku and add as comment
    let aiSummaryComment = null
    if (transcript && process.env.ANTHROPIC_API_KEY) {
      const summary = await summarizeTranscript(transcript)
      if (summary) {
        const { data: comment } = await (supabase as any)
          .from('issue_comments')
          .insert({
            issue_id: issueId,
            author_id: user.id,
            comment_type: 'ai_summary',
            visibility: 'internal',
            body: summary,
            mentions: [],
          })
          .select()
          .single()
        aiSummaryComment = comment
      }
    }

    // Generate signed URL for response
    const { data: signed } = await supabase.storage
      .from('issue-evidence')
      .createSignedUrl(storagePath, SIGNED_URL_EXPIRES_IN)

    return NextResponse.json(
      {
        attachment: { ...attachment, signed_url: signed?.signedUrl ?? null },
        ai_summary_comment: aiSummaryComment,
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('Voice upload error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
