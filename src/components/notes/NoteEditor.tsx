"use client"

import { useState, useRef, useEffect, type KeyboardEvent } from 'react'
import type { CreateNoteInput, Note } from '@/lib/types/notes'

/** The scope shape, but with original_text removed — the editor's textarea
 *  provides that. Passing CreateNoteInput directly forces callers to
 *  include a dummy original_text which is ignored. */
type EditorScope =
  | { scope: 'project'; project_id: string }
  | { scope: 'opening'; opening_id: string }
  | { scope: 'leaf'; opening_id: string; leaf_side: 'active' | 'inactive' | 'shared' }
  | { scope: 'item'; hardware_item_id: string }

interface Props {
  /** Where this note is being attached. Identifies the FK shape sent to POST /api/notes. */
  scope: EditorScope | CreateNoteInput
  /** Called after the API returns 201 with the new note. Parent can refresh its list. */
  onCreated?: (note: Note) => void
  /** Optional cancel button. When provided, shows a Cancel action and calls this on click. */
  onCancel?: () => void
  /** Initial textarea value. Useful when re-opening a partially-typed draft. */
  initialText?: string
  /** Display tweaks. */
  placeholder?: string
  autoFocus?: boolean
}

/**
 * Controlled textarea + save/cancel for creating a single note.
 *
 * Cmd/Ctrl + Enter saves; Esc cancels. The save is a single POST to
 * /api/notes; on success, parent gets the new note via onCreated and is
 * responsible for refreshing its list (the editor doesn't reach into
 * the parent's data).
 */
export function NoteEditor({
  scope,
  onCreated,
  onCancel,
  initialText = '',
  placeholder = 'Add a note…',
  autoFocus = true,
}: Props) {
  const [text, setText] = useState(initialText)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [autoFocus])

  const canSave = text.trim().length > 0 && !busy

  const handleSave = async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...scope, original_text: text.trim() }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Unknown error' }))
        setError(body.error ?? `Save failed (${res.status})`)
        return
      }
      const { note } = (await res.json()) as { note: Note }
      setText('')
      onCreated?.(note)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl + Enter saves; matches GitHub / Slack / most note UIs.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void handleSave()
    } else if (e.key === 'Escape' && onCancel) {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="space-y-2">
      <textarea
        ref={textareaRef}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={3}
        disabled={busy}
        className="w-full bg-surface border border-th-border rounded-md px-3 py-2 text-[13px] text-primary placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
      />
      {error && <div className="text-[12px] text-danger">{error}</div>}
      <div className="flex items-center gap-2 justify-end">
        <span className="text-[11px] text-tertiary mr-auto">⌘ + Enter to save</span>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="text-[12px] text-tertiary hover:text-secondary px-3 py-1 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!canSave}
          className="text-[12px] bg-accent text-background hover:opacity-90 px-3 py-1 rounded-md transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? 'Saving…' : 'Save note'}
        </button>
      </div>
    </div>
  )
}
