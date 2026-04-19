/**
 * GET /api/projects/[projectId]/punch-notes/export-pdf
 *
 * Renders the project's punch-notes view as a client-quality PDF and
 * streams it back as an attachment download.
 *
 * Pipeline:
 *   1. Auth + RLS-gated project read.
 *   2. Fetch project metadata + AI summary state (one round-trip).
 *   3. Fetch all notes via fetchProjectNotes (one round-trip + label lookups).
 *   4. Fetch opening summary state via .in() (one round-trip).
 *   5. Assemble the PunchNotesPdfData object.
 *   6. renderToBuffer() — server-side React → PDF buffer.
 *   7. Return application/pdf with Content-Disposition: attachment.
 *   8. Fire-and-forget activity log entry.
 *
 * Vercel maxDuration is bumped to 60s in vercel.json for this route —
 * a project with hundreds of openings + long summaries can take a while
 * to render, and the default 30s leaves no headroom.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { logActivity } from '@/lib/activity-log'
import { ACTIVITY_ACTIONS } from '@/lib/constants/activity-actions'
import { fetchProjectNotes } from '@/lib/notes/queries'
import {
  PunchNotesDocument,
  type PunchNotesPdfData,
  type PunchNotesPdfOpening,
} from '@/lib/pdf/punch-notes-document'
import { renderToBuffer } from '@react-pdf/renderer'
import type { Note } from '@/lib/types/notes'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authErr } = await supabase.auth.getUser()
    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { projectId } = await params

    // Project metadata + summary in one round-trip. The select string MUST
    // be a single literal (not a concatenation) so Supabase's typed client
    // can infer the row shape.
    const { data: projectRow, error: projectErr } = await supabase
      .from('projects')
      .select('id, name, address, general_contractor, job_number, architect, punch_notes_ai_summary, punch_notes_ai_summary_at')
      .eq('id', projectId)
      .single()

    if (projectErr || !projectRow) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // All notes in the project + label lookups for door numbers + item names.
    const bundle = await fetchProjectNotes(supabase, projectId)

    // Group notes by opening; project-scope notes get split out.
    const projectScopeNotes: Note[] = []
    const notesByOpening = new Map<string, Note[]>()
    for (const n of bundle.notes) {
      if (n.scope === 'project') {
        projectScopeNotes.push(n)
      } else if (n.opening_id) {
        const arr = notesByOpening.get(n.opening_id) ?? []
        arr.push(n)
        notesByOpening.set(n.opening_id, arr)
      }
    }

    // Pull opening summary state for every opening that has notes.
    const openingIds = Array.from(notesByOpening.keys())
    let openings: PunchNotesPdfOpening[] = []

    if (openingIds.length > 0) {
      const { data: openingRows, error: openingsErr } = await supabase
        .from('openings')
        .select('id, door_number, notes_ai_summary')
        .in('id', openingIds)

      if (openingsErr) {
        console.error(
          '[punch-notes/export-pdf] opening summary fetch failed:',
          openingsErr.message,
        )
        // Non-fatal — fall through with whatever we have. Render without
        // opening AI summaries rather than failing the whole export.
      }

      const summaryById = new Map((openingRows ?? []).map(r => [r.id, r]))

      openings = openingIds.map(openingId => {
        const summary = summaryById.get(openingId)
        const doorNumber = summary?.door_number ?? bundle.doorNumbers[openingId] ?? '(unknown)'
        return {
          id: openingId,
          door_number: doorNumber,
          summary: summary?.notes_ai_summary ?? null,
          notes: notesByOpening.get(openingId) ?? [],
        }
      })

      // Natural sort by door_number — matches the on-screen view's ordering.
      const collator = new Intl.Collator(undefined, { numeric: true })
      openings.sort((a, b) => collator.compare(a.door_number, b.door_number))
    }

    // Resolve "prepared by" — prefer full name from user_metadata, fall back
    // to email. Both are commonly present on a Supabase auth.users row;
    // anything else gets the generic null path which the PDF skips.
    const preparedBy =
      (user.user_metadata?.full_name as string | undefined) ??
      user.email ??
      null

    const generatedAt = new Date().toISOString()

    const data: PunchNotesPdfData = {
      project: {
        name: projectRow.name,
        address: projectRow.address,
        general_contractor: projectRow.general_contractor,
        job_number: projectRow.job_number,
        architect: projectRow.architect,
        summary_generated_at: projectRow.punch_notes_ai_summary_at,
        summary: projectRow.punch_notes_ai_summary,
      },
      openings,
      projectScopeNotes,
      itemNames: bundle.itemNames,
      generatedAt,
      preparedBy,
    }

    const buffer = await renderToBuffer(<PunchNotesDocument data={data} />)

    // Activity log — fire-and-forget so a slow logActivity doesn't delay
    // the response. Includes opening + note counts for cost auditing.
    void logActivity({
      projectId,
      userId: user.id,
      action: ACTIVITY_ACTIONS.PUNCH_NOTES_EXPORTED,
      entityType: 'project',
      entityId: projectId,
      details: {
        scope: 'project',
        openings_included: openings.length,
        project_scope_notes: projectScopeNotes.length,
        total_notes: bundle.notes.length,
        bytes: buffer.byteLength,
      },
    })

    const filename = buildFilename(projectRow.name, generatedAt)

    return new NextResponse(buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(buffer.byteLength),
      },
    })
  } catch (err) {
    console.error('[punch-notes/export-pdf] error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    )
  }
}

/** "Acme HQ — punch notes — 2026-04-19.pdf" with safe-for-disk chars. */
function buildFilename(projectName: string, generatedAt: string): string {
  const safe = projectName.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const date = generatedAt.split('T')[0] // YYYY-MM-DD
  return `${safe || 'project'}_punch-notes_${date}.pdf`
}
