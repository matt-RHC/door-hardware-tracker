import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { logActivity } from '@/lib/activity-log'
import { parseEmail } from '@/lib/ai/issue-parser'
import { computeDueAt } from '@/lib/utils/sla'
import type { IssueSeverity } from '@/lib/types/database'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId } = await params

    const { data: membership } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single()

    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    const body = await request.json()

    if (!body.email_body) {
      return NextResponse.json({ error: 'Missing required field: email_body' }, { status: 400 })
    }

    // Call Haiku parser
    const parseResult = await parseEmail(body.email_body, body.email_from, body.email_subject)

    if (parseResult.issues.length === 0) {
      return NextResponse.json({
        issues_created: 0,
        issues: [],
        low_confidence_count: 0,
        token_usage: parseResult.token_usage,
      })
    }

    // Fetch project openings for fuzzy matching
    const { data: openings } = await (supabase as any)
      .from('openings')
      .select('id, name')
      .eq('project_id', projectId)

    const openingMap = new Map<string, string>()
    for (const o of openings ?? []) {
      if (o.name) {
        // Index by normalized name (lowercase, trimmed)
        openingMap.set(o.name.toLowerCase().trim(), o.id)
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createdIssues: any[] = []
    let lowConfidenceCount = 0

    for (const parsed of parseResult.issues) {
      // Try to match opening_identifier to an actual opening
      let matchedOpeningId: string | null = null
      if (parsed.opening_identifier) {
        const normalized = parsed.opening_identifier.toLowerCase().trim()
          .replace(/^(door|rm|d-|#)\s*/i, '')
          .trim()

        // Exact match first
        matchedOpeningId = openingMap.get(normalized)
          ?? openingMap.get(parsed.opening_identifier.toLowerCase().trim())
          ?? null

        // Fuzzy: check if any opening name contains the identifier
        if (!matchedOpeningId) {
          for (const [name, id] of openingMap) {
            if (name.includes(normalized) || normalized.includes(name)) {
              matchedOpeningId = id
              break
            }
          }
        }
      }

      const severity = parsed.severity as IssueSeverity
      const now = new Date()
      const dueAt = computeDueAt(severity, now)

      const isLowConfidence = parsed.confidence < 0.75
      if (isLowConfidence) lowConfidenceCount++

      const { data: issue, error } = await (supabase as any)
        .from('issues')
        .insert({
          project_id: projectId,
          opening_id: matchedOpeningId,
          category: parsed.item_name || 'other',
          issue_type: parsed.issue_type,
          severity,
          status: 'created',
          title: parsed.issue_title,
          description: parsed.description,
          reported_by: user.id,
          source: 'email',
          source_data: {
            email_body: body.email_body,
            email_from: body.email_from || null,
            email_subject: body.email_subject || null,
            parsed_opening_identifier: parsed.opening_identifier,
            parsed_item_name: parsed.item_name,
            parsed_evidence: parsed.evidence,
            parsed_requested_action: parsed.requested_action,
            parsed_assignee_hint: parsed.assignee_hint,
            parse_notes: parsed.parse_notes,
          },
          parse_confidence: parsed.confidence,
          due_at: dueAt.toISOString(),
        })
        .select()
        .single()

      if (error) {
        console.error('[parse-email] Failed to create issue:', error)
        continue
      }

      createdIssues.push(issue)

      // Fire-and-forget activity log
      logActivity({
        projectId,
        userId: user.id,
        action: 'issue_created',
        entityType: 'issue',
        entityId: issue.id,
        details: {
          title: parsed.issue_title,
          category: parsed.item_name || 'other',
          issue_type: parsed.issue_type,
          severity,
          source: 'email',
          parse_confidence: parsed.confidence,
        },
      })
    }

    return NextResponse.json({
      issues_created: createdIssues.length,
      issues: createdIssues,
      low_confidence_count: lowConfidenceCount,
      token_usage: parseResult.token_usage,
    })
  } catch (error) {
    console.error('Parse email error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
