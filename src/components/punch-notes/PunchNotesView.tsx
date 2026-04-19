"use client"

/**
 * Client component for the project punch-notes page. Renders:
 *
 *   - Project AI summary card at the top with regenerate/revert + stale
 *     indicator + last-regenerated timestamp.
 *   - One section per opening that has notes, each with its own AI summary
 *     card + a list of raw notes grouped (opening → leaf → item).
 *
 * Server fetch happens in the wrapping page; this component receives the
 * already-resolved data and owns all the post-mount mutation state
 * (regenerate / revert / error handling).
 *
 * Design choices
 *   - Optimistic updates: when a regenerate succeeds, we splice the
 *     returned summary into local state without re-fetching the page.
 *   - Per-section busy state: regenerating one opening doesn't lock the
 *     others. Project-level regen IS exclusive — see disabled props.
 *   - Errors surface inline per-card. The card error stays until the next
 *     successful action so the user can see what failed.
 */

import Link from 'next/link'
import { useMemo, useState } from 'react'
import type { Note } from '@/lib/types/notes'
import { Markdown } from './Markdown'

// ── Props ───────────────────────────────────────────────────────────────

export interface PunchNotesProjectState {
  id: string
  name: string
  summary: string | null
  previous: string | null
  generated_at: string | null
  stale: boolean
}

export interface PunchNotesOpeningState {
  id: string
  door_number: string
  summary: string | null
  previous: string | null
  generated_at: string | null
  stale: boolean
  notes: Note[]
}

interface Props {
  project: PunchNotesProjectState
  openings: PunchNotesOpeningState[]
  /** Project-scope notes (no opening_id). Render at the bottom of the
   *  project summary card so they don't get lost. */
  projectScopeNotes: Note[]
  /** itemNames keyed by hardware_item_id, used to label item-scope notes. */
  itemNames: Record<string, string | null>
}

// ── Component ───────────────────────────────────────────────────────────

export function PunchNotesView({ project: projectProp, openings: openingsProp, projectScopeNotes, itemNames }: Props) {
  const [project, setProject] = useState(projectProp)
  const [openings, setOpenings] = useState(openingsProp)
  const [projectBusy, setProjectBusy] = useState<'idle' | 'summarize' | 'revert'>('idle')
  const [openingBusy, setOpeningBusy] = useState<Record<string, 'idle' | 'summarize' | 'revert'>>({})
  const [projectError, setProjectError] = useState<string | null>(null)
  const [openingErrors, setOpeningErrors] = useState<Record<string, string | null>>({})
  /** Transient inline notice — used to surface the server's `debounced:true`
   *  response so the user knows the click was a no-op rather than a fresh
   *  regen. Cleared on next action. */
  const [projectNotice, setProjectNotice] = useState<string | null>(null)
  const [openingNotices, setOpeningNotices] = useState<Record<string, string | null>>({})

  const totalNotes = useMemo(
    () => openings.reduce((sum, o) => sum + o.notes.length, 0) + projectScopeNotes.length,
    [openings, projectScopeNotes],
  )

  const updateOpening = (id: string, patch: Partial<PunchNotesOpeningState>) => {
    setOpenings(prev => prev.map(o => o.id === id ? { ...o, ...patch } : o))
  }
  const setOpeningBusyFor = (id: string, value: 'idle' | 'summarize' | 'revert') => {
    setOpeningBusy(prev => ({ ...prev, [id]: value }))
  }
  const setOpeningErrorFor = (id: string, value: string | null) => {
    setOpeningErrors(prev => ({ ...prev, [id]: value }))
  }
  const setOpeningNoticeFor = (id: string, value: string | null) => {
    setOpeningNotices(prev => ({ ...prev, [id]: value }))
  }

  // ── Project summary actions ───────────────────────────────────────────

  const regenerateProject = async () => {
    setProjectBusy('summarize')
    setProjectError(null)
    setProjectNotice(null)
    try {
      const res = await fetch(`/api/projects/${project.id}/punch-notes/summarize`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setProjectError(body.error ?? `Regenerate failed (${res.status})`)
        return
      }
      // Server returns { debounced: true } when called within 5s of the last
      // regen — avoids double-spending tokens. Surface so the user knows the
      // click was a no-op rather than a silent re-render of the same content.
      if (body.debounced) {
        setProjectNotice('Already up to date — recently regenerated.')
        return
      }
      setProject(prev => ({
        ...prev,
        summary: body.summary ?? null,
        previous: body.previous ?? prev.summary,
        generated_at: body.generated_at ?? new Date().toISOString(),
        stale: false,
      }))
      // The project regen also refreshes stale opening summaries server-side.
      // Mirror that locally by clearing the stale flag on each opening.
      setOpenings(prev => prev.map(o => ({ ...o, stale: false })))
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : 'Regenerate failed')
    } finally {
      setProjectBusy('idle')
    }
  }

  const revertProject = async () => {
    setProjectBusy('revert')
    setProjectError(null)
    try {
      const res = await fetch(`/api/projects/${project.id}/punch-notes/revert`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setProjectError(body.error ?? `Revert failed (${res.status})`)
        return
      }
      setProject(prev => ({
        ...prev,
        summary: body.summary ?? null,
        previous: body.previous ?? null,
        generated_at: body.reverted_at ?? new Date().toISOString(),
      }))
    } catch (err) {
      setProjectError(err instanceof Error ? err.message : 'Revert failed')
    } finally {
      setProjectBusy('idle')
    }
  }

  // ── Opening summary actions ───────────────────────────────────────────

  const regenerateOpening = async (id: string) => {
    setOpeningBusyFor(id, 'summarize')
    setOpeningErrorFor(id, null)
    setOpeningNoticeFor(id, null)
    try {
      const res = await fetch(`/api/openings/${id}/notes/summarize`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setOpeningErrorFor(id, body.error ?? `Regenerate failed (${res.status})`)
        return
      }
      if (body.debounced) {
        setOpeningNoticeFor(id, 'Already up to date — recently regenerated.')
        return
      }
      updateOpening(id, {
        summary: body.summary ?? null,
        previous: body.previous ?? null,
        generated_at: body.generated_at ?? new Date().toISOString(),
        stale: false,
      })
    } catch (err) {
      setOpeningErrorFor(id, err instanceof Error ? err.message : 'Regenerate failed')
    } finally {
      setOpeningBusyFor(id, 'idle')
    }
  }

  const revertOpening = async (id: string) => {
    setOpeningBusyFor(id, 'revert')
    setOpeningErrorFor(id, null)
    try {
      const res = await fetch(`/api/openings/${id}/notes/revert`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setOpeningErrorFor(id, body.error ?? `Revert failed (${res.status})`)
        return
      }
      updateOpening(id, {
        summary: body.summary ?? null,
        previous: body.previous ?? null,
        generated_at: body.reverted_at ?? new Date().toISOString(),
      })
    } catch (err) {
      setOpeningErrorFor(id, err instanceof Error ? err.message : 'Revert failed')
    } finally {
      setOpeningBusyFor(id, 'idle')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-[18px] font-semibold text-primary">Punch notes</h1>
        <div className="text-[12px] text-tertiary tabular-nums">
          {totalNotes} note{totalNotes === 1 ? '' : 's'} · {openings.length} opening{openings.length === 1 ? '' : 's'}
        </div>
      </div>

      <ProjectSummaryCard
        project={project}
        projectScopeNotes={projectScopeNotes}
        busy={projectBusy}
        error={projectError}
        notice={projectNotice}
        onRegenerate={regenerateProject}
        onRevert={revertProject}
      />

      <div className="space-y-4">
        {openings.length === 0 ? (
          <div className="text-[13px] text-tertiary italic">
            No openings have notes yet. Add a note from any door page to get started.
          </div>
        ) : (
          openings.map(o => (
            <OpeningCard
              key={o.id}
              projectId={project.id}
              opening={o}
              itemNames={itemNames}
              busy={openingBusy[o.id] ?? 'idle'}
              error={openingErrors[o.id] ?? null}
              notice={openingNotices[o.id] ?? null}
              onRegenerate={() => regenerateOpening(o.id)}
              onRevert={() => revertOpening(o.id)}
            />
          ))
        )}
      </div>
    </div>
  )
}

// ── ProjectSummaryCard ──────────────────────────────────────────────────

interface ProjectSummaryCardProps {
  project: PunchNotesProjectState
  projectScopeNotes: Note[]
  busy: 'idle' | 'summarize' | 'revert'
  error: string | null
  notice: string | null
  onRegenerate: () => void
  onRevert: () => void
}

function ProjectSummaryCard({ project, projectScopeNotes, busy, error, notice, onRegenerate, onRevert }: ProjectSummaryCardProps) {
  return (
    <section className="border border-th-border rounded-md bg-surface/30 p-4 space-y-3">
      <header className="flex items-baseline justify-between gap-4">
        <div className="space-y-0.5">
          <div className="text-[11px] uppercase tracking-wider text-tertiary">Project summary</div>
          <h2 className="text-[15px] font-semibold text-primary">{project.name}</h2>
        </div>
        <div className="flex items-center gap-3">
          {project.stale && project.summary && (
            <span
              title="Notes have changed since this summary was generated"
              className="text-[11px] px-2 py-0.5 rounded-full font-medium"
              style={{ background: 'var(--yellow-dim, rgba(234, 179, 8, 0.15))', color: 'var(--yellow, #eab308)' }}
            >
              Out of date
            </span>
          )}
          {project.previous && (
            <button
              type="button"
              onClick={onRevert}
              disabled={busy !== 'idle'}
              className="text-[12px] text-tertiary hover:text-secondary disabled:opacity-50"
            >
              {busy === 'revert' ? 'Reverting…' : 'Revert'}
            </button>
          )}
          <button
            type="button"
            onClick={onRegenerate}
            disabled={busy !== 'idle'}
            className="text-[12px] bg-accent text-background hover:opacity-90 px-3 py-1 rounded-md disabled:opacity-50"
          >
            {busy === 'summarize' ? 'Generating…' : project.summary ? 'Regenerate' : 'Generate summary'}
          </button>
        </div>
      </header>

      {project.generated_at && (
        <div className="text-[11px] text-tertiary">
          Last generated {formatTimestamp(project.generated_at)}
        </div>
      )}

      {error && <div className="text-[12px] text-danger">{error}</div>}
      {notice && <div className="text-[12px] text-tertiary">{notice}</div>}

      {busy === 'summarize' ? (
        <div className="text-[13px] text-tertiary italic flex items-center gap-2">
          <span className="inline-block w-3 h-3 rounded-full border-2 border-tertiary border-t-transparent animate-spin" />
          Generating summary{project.summary ? ' (this may take 30-60 seconds for large projects)' : ' (this may take 30-60 seconds)'}…
        </div>
      ) : project.summary ? (
        <Markdown source={project.summary} />
      ) : (
        <div className="text-[13px] text-tertiary italic">
          No project summary yet. Click <span className="font-semibold">Generate summary</span> to create one.
        </div>
      )}

      {projectScopeNotes.length > 0 && (
        <div className="border-t border-th-border pt-3 space-y-2">
          <div className="text-[11px] uppercase tracking-wider text-tertiary">
            Project-scope notes ({projectScopeNotes.length})
          </div>
          <ul className="space-y-1.5">
            {projectScopeNotes.map(n => (
              <li key={n.id} className="text-[13px] text-primary whitespace-pre-wrap">
                {n.original_text}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

// ── OpeningCard ─────────────────────────────────────────────────────────

interface OpeningCardProps {
  projectId: string
  opening: PunchNotesOpeningState
  itemNames: Record<string, string | null>
  busy: 'idle' | 'summarize' | 'revert'
  error: string | null
  notice: string | null
  onRegenerate: () => void
  onRevert: () => void
}

function OpeningCard({ projectId, opening, itemNames, busy, error, notice, onRegenerate, onRevert }: OpeningCardProps) {
  const grouped = useMemo(() => groupNotesForDisplay(opening.notes, itemNames), [opening.notes, itemNames])

  return (
    <section className="border border-th-border rounded-md bg-surface/20 p-4 space-y-3">
      <header className="flex items-baseline justify-between gap-4">
        <div className="space-y-0.5 min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-tertiary">Opening</div>
          <div className="flex items-baseline gap-2 flex-wrap">
            <h3 className="text-[14px] font-semibold text-primary">Door {opening.door_number}</h3>
            <Link
              href={`/project/${projectId}/door/${opening.id}`}
              className="text-[11px] text-tertiary hover:text-accent transition-colors"
              title="Open the door detail page"
            >
              View door →
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {opening.stale && opening.summary && (
            <span
              title="Notes have changed since this opening's summary was generated"
              className="text-[11px] px-2 py-0.5 rounded-full font-medium"
              style={{ background: 'var(--yellow-dim, rgba(234, 179, 8, 0.15))', color: 'var(--yellow, #eab308)' }}
            >
              Out of date
            </span>
          )}
          {opening.previous && (
            <button
              type="button"
              onClick={onRevert}
              disabled={busy !== 'idle'}
              className="text-[11px] text-tertiary hover:text-secondary disabled:opacity-50"
            >
              {busy === 'revert' ? 'Reverting…' : 'Revert'}
            </button>
          )}
          <button
            type="button"
            onClick={onRegenerate}
            disabled={busy !== 'idle'}
            className="text-[11px] bg-accent text-background hover:opacity-90 px-2.5 py-1 rounded-md disabled:opacity-50"
          >
            {busy === 'summarize' ? 'Generating…' : opening.summary ? 'Regenerate' : 'Generate'}
          </button>
        </div>
      </header>

      {opening.generated_at && (
        <div className="text-[11px] text-tertiary">
          Last generated {formatTimestamp(opening.generated_at)}
        </div>
      )}

      {error && <div className="text-[12px] text-danger">{error}</div>}
      {notice && <div className="text-[12px] text-tertiary">{notice}</div>}

      {busy === 'summarize' ? (
        <div className="text-[13px] text-tertiary italic flex items-center gap-2">
          <span className="inline-block w-3 h-3 rounded-full border-2 border-tertiary border-t-transparent animate-spin" />
          Generating summary…
        </div>
      ) : opening.summary ? (
        <Markdown source={opening.summary} />
      ) : (
        <div className="text-[13px] text-tertiary italic">
          No summary yet for this opening. Click Generate to create one.
        </div>
      )}

      <div className="border-t border-th-border pt-3 space-y-3">
        <div className="text-[11px] uppercase tracking-wider text-tertiary">
          Raw notes ({opening.notes.length})
        </div>
        {grouped.openingScope.length > 0 && (
          <NoteGroup label="Opening" notes={grouped.openingScope} />
        )}
        {(['active', 'inactive', 'shared'] as const).map(side => {
          const sideNotes = grouped.byLeafSide[side]
          if (!sideNotes || sideNotes.length === 0) return null
          return <NoteGroup key={side} label={`${capitalize(side)} leaf`} notes={sideNotes} />
        })}
        {grouped.byItem.map(({ itemId, itemName, notes }) => (
          <NoteGroup key={itemId} label={itemName ?? '(unknown item)'} notes={notes} />
        ))}
      </div>
    </section>
  )
}

// ── NoteGroup ───────────────────────────────────────────────────────────

function NoteGroup({ label, notes }: { label: string; notes: Note[] }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-semibold text-secondary uppercase tracking-wide">{label}</div>
      <ul className="space-y-1.5 pl-1">
        {notes.map(n => (
          <li key={n.id} className="text-[13px] text-primary whitespace-pre-wrap border-l-2 border-th-border pl-3">
            {n.original_text}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Grouping + formatting helpers ───────────────────────────────────────

interface GroupedNotes {
  openingScope: Note[]
  byLeafSide: Record<'active' | 'inactive' | 'shared', Note[]>
  byItem: Array<{ itemId: string; itemName: string | null; notes: Note[] }>
}

function groupNotesForDisplay(notes: Note[], itemNames: Record<string, string | null>): GroupedNotes {
  const openingScope: Note[] = []
  const byLeafSide: Record<'active' | 'inactive' | 'shared', Note[]> = { active: [], inactive: [], shared: [] }
  const byItemMap = new Map<string, Note[]>()
  for (const n of notes) {
    if (n.scope === 'opening') {
      openingScope.push(n)
    } else if (n.scope === 'leaf' && n.leaf_side) {
      byLeafSide[n.leaf_side].push(n)
    } else if (n.scope === 'item' && n.hardware_item_id) {
      const arr = byItemMap.get(n.hardware_item_id) ?? []
      arr.push(n)
      byItemMap.set(n.hardware_item_id, arr)
    } else {
      // Defensive: an item-scope note with null hardware_item_id violates
      // the DB CHECK constraint (notes_scope_fk_consistency in mig 051), so
      // this branch should be unreachable. If it ever fires (a row sneaks
      // through, an upstream type drift, etc.) we'd rather surface the note
      // at the opening level than silently drop it. The console.warn flags
      // the data integrity issue without hard-failing the page.
      console.warn(
        '[PunchNotesView] orphan note with no usable scope/leaf/item key — surfacing at opening level',
        { id: n.id, scope: n.scope, leaf_side: n.leaf_side, hardware_item_id: n.hardware_item_id },
      )
      openingScope.push(n)
    }
  }
  const byItem = Array.from(byItemMap.entries()).map(([itemId, list]) => ({
    itemId,
    itemName: itemNames[itemId] ?? null,
    notes: list,
  }))
  return { openingScope, byLeafSide, byItem }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}
