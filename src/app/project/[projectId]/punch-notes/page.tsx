/**
 * /project/[projectId]/punch-notes
 *
 * Server component. Fetches everything the punch-notes view needs in one
 * RSC tick (project + summary state, all notes, opening summaries, label
 * lookups) then hands off to <PunchNotesView /> for client interaction.
 *
 * RLS gates membership — the createServerSupabaseClient is user-scoped, so
 * a non-member loading this URL gets a 404 from the project query.
 */

import { notFound, redirect } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { fetchProjectNotes } from '@/lib/notes/queries'
import {
  PunchNotesView,
  type PunchNotesProjectState,
  type PunchNotesOpeningState,
} from '@/components/punch-notes/PunchNotesView'
import type { Note } from '@/lib/types/notes'

interface PageProps {
  params: Promise<{ projectId: string }>
}

export default async function PunchNotesPage({ params }: PageProps) {
  const { projectId } = await params

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    redirect(`/login?redirectTo=/project/${projectId}/punch-notes`)
  }

  // Project + summary state.
  const { data: projectRow, error: projectErr } = await supabase
    .from('projects')
    .select('id, name, punch_notes_ai_summary, punch_notes_ai_summary_previous, punch_notes_ai_summary_at, punch_notes_ai_summary_stale')
    .eq('id', projectId)
    .single()

  if (projectErr || !projectRow) {
    notFound()
  }

  const project: PunchNotesProjectState = {
    id: projectRow.id,
    name: projectRow.name,
    summary: projectRow.punch_notes_ai_summary,
    previous: projectRow.punch_notes_ai_summary_previous,
    generated_at: projectRow.punch_notes_ai_summary_at,
    stale: projectRow.punch_notes_ai_summary_stale,
  }

  // All notes in the project + label lookups for door numbers + item names.
  const bundle = await fetchProjectNotes(supabase, projectId)

  // Group notes by opening (project-scope notes get split out separately).
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

  // Pull opening-level summary state for every opening that has notes.
  const openingIds = Array.from(notesByOpening.keys())
  let openings: PunchNotesOpeningState[] = []

  if (openingIds.length > 0) {
    const { data: openingRows, error: openingsErr } = await supabase
      .from('openings')
      .select('id, door_number, notes_ai_summary, notes_ai_summary_previous, notes_ai_summary_at, notes_ai_summary_stale')
      .in('id', openingIds)

    if (openingsErr) {
      // Non-fatal — fall through with the IDs we have, summary state empty.
      console.error('[punch-notes page] opening summary fetch failed:', openingsErr.message)
    }

    const summaryById = new Map((openingRows ?? []).map(r => [r.id, r]))

    openings = openingIds.map(openingId => {
      const summary = summaryById.get(openingId)
      const doorNumber = summary?.door_number ?? bundle.doorNumbers[openingId] ?? '(unknown)'
      return {
        id: openingId,
        door_number: doorNumber,
        summary: summary?.notes_ai_summary ?? null,
        previous: summary?.notes_ai_summary_previous ?? null,
        generated_at: summary?.notes_ai_summary_at ?? null,
        // notes_ai_summary_stale is `BOOLEAN NOT NULL DEFAULT FALSE` (mig 051);
        // the only way `summary?.notes_ai_summary_stale` is undefined is if
        // `summary` itself is undefined, which collapses to `false` here.
        stale: summary?.notes_ai_summary_stale ?? false,
        notes: notesByOpening.get(openingId) ?? [],
      }
    })

    // Natural sort by door_number so 1, 2, 10 don't sort as 1, 10, 2 for
    // un-padded numbers. Padded numbers ("001") were already correct.
    const collator = new Intl.Collator(undefined, { numeric: true })
    openings.sort((a, b) => collator.compare(a.door_number, b.door_number))
  }

  return (
    <main className="max-w-4xl mx-auto px-4 py-6 md:px-6 md:py-8">
      <PunchNotesView
        project={project}
        openings={openings}
        projectScopeNotes={projectScopeNotes}
        itemNames={bundle.itemNames}
      />
    </main>
  )
}
