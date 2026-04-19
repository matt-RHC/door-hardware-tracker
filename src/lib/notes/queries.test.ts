/**
 * Tests for fetchProjectNotes — verifies the query shape and the
 * label-lookup join behavior. Mocks the Supabase chainable builder
 * (same pattern as src/lib/extraction-staging.test.ts).
 *
 * RLS, CHECK constraint, and the stale-flag trigger are exercised at
 * migration-apply time against the real DB; not unit-testable from
 * vitest without a Postgres harness.
 */

import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchProjectNotes } from './queries'
import type { Note } from '@/lib/types/notes'

type FakeNote = Partial<Note> & { id: string; project_id: string }

function makeSupabaseMock(opts: {
  notes: FakeNote[]
  openings?: Array<{ id: string; door_number: string | null }>
  items?: Array<{ id: string; name: string | null }>
}) {
  const calls = {
    from: vi.fn<(table: string) => unknown>(),
  }

  const notesBuilder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data: opts.notes, error: null }),
  }

  const openingsBuilder = {
    select: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue({ data: opts.openings ?? [], error: null }),
  }

  const itemsBuilder = {
    select: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue({ data: opts.items ?? [], error: null }),
  }

  const supabase = {
    from: (table: string) => {
      calls.from(table)
      if (table === 'notes') return notesBuilder
      if (table === 'openings') return openingsBuilder
      if (table === 'hardware_items') return itemsBuilder
      throw new Error(`unexpected table: ${table}`)
    },
  } as unknown as SupabaseClient

  return { supabase, calls, builders: { notesBuilder, openingsBuilder, itemsBuilder } }
}

describe('fetchProjectNotes', () => {
  it('queries the notes table filtered to project_id, ordered by created_at ASC', async () => {
    const { supabase, builders } = makeSupabaseMock({ notes: [] })
    await fetchProjectNotes(supabase, 'proj-1')
    expect(builders.notesBuilder.eq).toHaveBeenCalledWith('project_id', 'proj-1')
    expect(builders.notesBuilder.order).toHaveBeenCalledWith('created_at', { ascending: true })
  })

  it('returns empty bundles when the project has no notes', async () => {
    const { supabase } = makeSupabaseMock({ notes: [] })
    const bundle = await fetchProjectNotes(supabase, 'proj-empty')
    expect(bundle.notes).toEqual([])
    expect(bundle.doorNumbers).toEqual({})
    expect(bundle.itemNames).toEqual({})
  })

  it('skips the openings + items round-trips when no FK ids are referenced', async () => {
    // A project-scope-only project should not query openings/hardware_items.
    const { supabase, calls } = makeSupabaseMock({
      notes: [
        { id: 'n1', project_id: 'p1', scope: 'project', opening_id: null, hardware_item_id: null },
      ],
    })
    await fetchProjectNotes(supabase, 'p1')
    expect(calls.from).toHaveBeenCalledWith('notes')
    expect(calls.from).toHaveBeenCalledTimes(1)
  })

  it('builds doorNumbers map for opening/leaf/item-scope notes', async () => {
    const { supabase } = makeSupabaseMock({
      notes: [
        { id: 'n1', project_id: 'p1', scope: 'opening', opening_id: 'op-A', hardware_item_id: null },
        { id: 'n2', project_id: 'p1', scope: 'leaf', opening_id: 'op-B', hardware_item_id: null },
        { id: 'n3', project_id: 'p1', scope: 'item', opening_id: 'op-A', hardware_item_id: 'hw-1' },
      ],
      openings: [
        { id: 'op-A', door_number: '110-02C' },
        { id: 'op-B', door_number: '110-03A' },
      ],
      items: [{ id: 'hw-1', name: 'Hinges' }],
    })
    const bundle = await fetchProjectNotes(supabase, 'p1')
    expect(bundle.doorNumbers).toEqual({ 'op-A': '110-02C', 'op-B': '110-03A' })
    expect(bundle.itemNames).toEqual({ 'hw-1': 'Hinges' })
  })

  it('dedupes opening_ids when multiple notes share a parent', async () => {
    // 3 notes on the same opening — should only produce one entry in
    // openings.in() (verified by the resulting map having one entry).
    const { supabase, builders } = makeSupabaseMock({
      notes: [
        { id: 'n1', project_id: 'p1', scope: 'opening', opening_id: 'op-A', hardware_item_id: null },
        { id: 'n2', project_id: 'p1', scope: 'leaf', opening_id: 'op-A', hardware_item_id: null },
        { id: 'n3', project_id: 'p1', scope: 'item', opening_id: 'op-A', hardware_item_id: 'hw-1' },
      ],
      openings: [{ id: 'op-A', door_number: '110-02C' }],
      items: [{ id: 'hw-1', name: 'Hinges' }],
    })
    const bundle = await fetchProjectNotes(supabase, 'p1')
    expect(bundle.doorNumbers).toEqual({ 'op-A': '110-02C' })
    // The .in() was called once with a deduped array of length 1.
    const inCall = builders.openingsBuilder.in.mock.calls[0]
    expect(inCall[0]).toBe('id')
    expect(inCall[1]).toEqual(['op-A'])
  })

  it('throws a clear error when the notes query fails', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => Promise.resolve({ data: null, error: { message: 'rls denied' } }),
          }),
        }),
      }),
    } as unknown as SupabaseClient
    await expect(fetchProjectNotes(supabase, 'p1')).rejects.toThrow(/rls denied/)
  })

  it('handles missing labels gracefully (door_number=null)', async () => {
    const { supabase } = makeSupabaseMock({
      notes: [
        { id: 'n1', project_id: 'p1', scope: 'opening', opening_id: 'op-A', hardware_item_id: null },
      ],
      openings: [{ id: 'op-A', door_number: null }],
    })
    const bundle = await fetchProjectNotes(supabase, 'p1')
    expect(bundle.doorNumbers).toEqual({ 'op-A': null })
  })
})
