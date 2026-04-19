"use client"

import { useState } from 'react'
import type { Note } from '@/lib/types/notes'

interface Props {
  notes: Note[]
  /** Current user's id — controls whether edit/delete affordances render
   *  per note. Pass null to render read-only for everyone. */
  currentUserId?: string | null
  /** Called after a note is updated via PATCH. Parent refreshes its list. */
  onUpdated?: (note: Note) => void
  /** Called after a note is deleted. Parent refreshes its list. */
  onDeleted?: (noteId: string) => void
  /** Display tweaks. */
  emptyMessage?: string
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  // Short relative-ish format; full timestamp shown in title attribute.
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/**
 * Read-only list of existing notes with optional inline edit + delete.
 *
 * Edit toggles the row into a textarea-based mini-editor (no separate
 * component yet — the volume per row is small and a dedicated editor
 * for the inline case would over-engineer it).
 */
export function NoteList({ notes, currentUserId, onUpdated, onDeleted, emptyMessage = 'No notes yet.' }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errorByNote, setErrorByNote] = useState<Record<string, string>>({})

  if (notes.length === 0) {
    return <div className="text-[12px] text-tertiary italic">{emptyMessage}</div>
  }

  const beginEdit = (note: Note) => {
    setEditingId(note.id)
    setEditText(note.original_text)
    setErrorByNote(prev => ({ ...prev, [note.id]: '' }))
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditText('')
  }

  const saveEdit = async (note: Note) => {
    if (editText.trim().length === 0) return
    setBusyId(note.id)
    try {
      const res = await fetch(`/api/notes/${note.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ original_text: editText.trim() }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Update failed' }))
        setErrorByNote(prev => ({ ...prev, [note.id]: body.error ?? 'Update failed' }))
        return
      }
      const { note: updated } = (await res.json()) as { note: Note }
      onUpdated?.(updated)
      setEditingId(null)
      setEditText('')
    } catch (err) {
      setErrorByNote(prev => ({ ...prev, [note.id]: err instanceof Error ? err.message : 'Update failed' }))
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (note: Note) => {
    if (!window.confirm('Delete this note? This cannot be undone.')) return
    setBusyId(note.id)
    try {
      const res = await fetch(`/api/notes/${note.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Delete failed' }))
        setErrorByNote(prev => ({ ...prev, [note.id]: body.error ?? 'Delete failed' }))
        return
      }
      onDeleted?.(note.id)
    } catch (err) {
      setErrorByNote(prev => ({ ...prev, [note.id]: err instanceof Error ? err.message : 'Delete failed' }))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <ul className="space-y-2">
      {notes.map(note => {
        const isEditing = editingId === note.id
        const isBusy = busyId === note.id
        const isOwner = currentUserId !== undefined && currentUserId !== null && note.created_by === currentUserId
        const error = errorByNote[note.id]
        return (
          <li
            key={note.id}
            className="border border-th-border rounded-md px-3 py-2 bg-surface/40"
          >
            {isEditing ? (
              <div className="space-y-2">
                <textarea
                  value={editText}
                  onChange={e => setEditText(e.target.value)}
                  rows={3}
                  disabled={isBusy}
                  className="w-full bg-background border border-th-border rounded-md px-2 py-1 text-[13px] text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <div className="flex items-center gap-2 justify-end">
                  <button
                    type="button"
                    onClick={cancelEdit}
                    disabled={isBusy}
                    className="text-[11px] text-tertiary hover:text-secondary px-2 py-1"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveEdit(note)}
                    disabled={isBusy || editText.trim().length === 0}
                    className="text-[11px] bg-accent text-background hover:opacity-90 px-2 py-1 rounded-md disabled:opacity-50"
                  >
                    {isBusy ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="text-[13px] text-primary whitespace-pre-wrap">{note.original_text}</div>
                <div className="flex items-center gap-3 mt-1 text-[11px] text-tertiary">
                  <span title={new Date(note.created_at).toLocaleString()}>
                    {formatTimestamp(note.created_at)}
                  </span>
                  {note.updated_at !== note.created_at && (
                    <span title={`Edited ${new Date(note.updated_at).toLocaleString()}`}>
                      (edited)
                    </span>
                  )}
                  {isOwner && (
                    <>
                      <button
                        type="button"
                        onClick={() => beginEdit(note)}
                        className="ml-auto text-tertiary hover:text-secondary"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(note)}
                        disabled={isBusy}
                        className="text-tertiary hover:text-danger disabled:opacity-50"
                      >
                        {isBusy ? 'Deleting…' : 'Delete'}
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
            {error && <div className="text-[11px] text-danger mt-1">{error}</div>}
          </li>
        )
      })}
    </ul>
  )
}
