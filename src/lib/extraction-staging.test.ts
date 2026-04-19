/**
 * Tests for extraction-staging helpers.
 *
 * Coverage focus: predicate guards on destructive paths. The Supabase
 * builder is mocked rather than wired to a real Postgres because the
 * value of these tests is "the WHERE clause is exactly what we said it
 * is" — a future refactor that drops or broadens a predicate would
 * silently widen the blast radius without this guard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { reapStuckExtractionRuns, writeStagingData, type StagingOpening } from './extraction-staging'

// ── reapStuckExtractionRuns ──────────────────────────────────────────

describe('reapStuckExtractionRuns', () => {
  beforeEach(() => {
    // Freeze time so cutoff math is deterministic. Date.now() is what the
    // helper uses to derive the cutoff ISO string.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-19T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Build a chainable supabase-builder mock that records every call. */
  function makeSupabaseMock(reapedRows: Array<{ id: string; started_at: string | null }>) {
    const calls = {
      from: vi.fn(),
      update: vi.fn(),
      eq: vi.fn(),
      lt: vi.fn(),
      select: vi.fn(),
    }
    // Each chain step returns the same builder so .eq().lt().select() works.
    // The final await resolves to { data, error } via .select()'s return.
    const builder = {
      update: (...args: unknown[]) => {
        calls.update(...args)
        return builder
      },
      eq: (...args: unknown[]) => {
        calls.eq(...args)
        return builder
      },
      lt: (...args: unknown[]) => {
        calls.lt(...args)
        return builder
      },
      select: (...args: unknown[]) => {
        calls.select(...args)
        return Promise.resolve({ data: reapedRows, error: null })
      },
    }
    const supabase = {
      from: (table: string) => {
        calls.from(table)
        return builder
      },
    } as unknown as SupabaseClient
    return { supabase, calls }
  }

  it('targets the extraction_runs table', () => {
    const { supabase, calls } = makeSupabaseMock([])
    return reapStuckExtractionRuns(supabase, 30).then(() => {
      expect(calls.from).toHaveBeenCalledWith('extraction_runs')
    })
  })

  it('filters strictly to status=extracting (no broader reap window)', () => {
    const { supabase, calls } = makeSupabaseMock([])
    return reapStuckExtractionRuns(supabase, 30).then(() => {
      // The PR review specifically called this out — a future refactor
      // that drops this predicate would mark, e.g. 'reviewing' rows as
      // failed too. Assert it loudly so that diff fails CI.
      expect(calls.eq).toHaveBeenCalledWith('status', 'extracting')
      expect(calls.eq).toHaveBeenCalledTimes(1)
    })
  })

  it('uses started_at < (now − ageMinutes) as the cutoff', () => {
    const { supabase, calls } = makeSupabaseMock([])
    return reapStuckExtractionRuns(supabase, 30).then(() => {
      // Now is frozen at 2026-04-19T12:00:00.000Z; 30 minutes earlier is
      // 11:30:00.000Z. Anything started before that is reapable.
      expect(calls.lt).toHaveBeenCalledWith('started_at', '2026-04-19T11:30:00.000Z')
      expect(calls.lt).toHaveBeenCalledTimes(1)
    })
  })

  it('cutoff scales with ageMinutes', () => {
    const { supabase, calls } = makeSupabaseMock([])
    return reapStuckExtractionRuns(supabase, 5).then(() => {
      expect(calls.lt).toHaveBeenCalledWith('started_at', '2026-04-19T11:55:00.000Z')
    })
  })

  it('writes status=failed + error_message + completed_at on update', () => {
    const { supabase, calls } = makeSupabaseMock([])
    return reapStuckExtractionRuns(supabase, 30).then(() => {
      expect(calls.update).toHaveBeenCalledTimes(1)
      const updatePayload = calls.update.mock.calls[0][0] as Record<string, string>
      expect(updatePayload.status).toBe('failed')
      expect(updatePayload.completed_at).toBe('2026-04-19T12:00:00.000Z')
      // Error message must include the threshold so reaped rows are
      // self-explanatory in the DB without cross-referencing the cron.
      expect(updatePayload.error_message).toContain('30')
      expect(updatePayload.error_message).toMatch(/reaped/i)
    })
  })

  it('returns the reaped rows verbatim (id + started_at)', async () => {
    const reaped = [
      { id: 'run-aaa', started_at: '2026-04-19T10:00:00.000Z' },
      { id: 'run-bbb', started_at: '2026-04-19T09:30:00.000Z' },
    ]
    const { supabase } = makeSupabaseMock(reaped)
    const result = await reapStuckExtractionRuns(supabase, 30)
    expect(result).toEqual(reaped)
  })

  it('returns empty array when nothing was stuck', async () => {
    const { supabase } = makeSupabaseMock([])
    const result = await reapStuckExtractionRuns(supabase, 30)
    expect(result).toEqual([])
  })

  it('throws when supabase returns an error (caller decides retry policy)', async () => {
    const supabase = {
      from: () => ({
        update: () => ({
          eq: () => ({
            lt: () => ({
              select: () =>
                Promise.resolve({ data: null, error: { message: 'rls denied' } }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient
    await expect(reapStuckExtractionRuns(supabase, 30)).rejects.toThrow(/rls denied/)
  })
})

// ── writeStagingData field-level pre-stage guards ───────────────────────────
//
// These guards run in-memory BEFORE the supabase RPC call. They catch the
// silent-default failure modes that produced the 2026-04-18 Radius DC
// regression (parser emitting blank door_number, missing leaf_count silently
// defaulting to 1). The supabase mock here would only be touched if the
// guard let the call through — every assertion below proves it didn't.

describe('writeStagingData field-level pre-stage guards', () => {
  // Supabase mock that throws if it's reached — proves the guard fired
  // BEFORE the RPC, not after. The previous code's `?? 1` silent default
  // would have let these through.
  const supabaseMustNotBeCalled = {
    rpc: () => {
      throw new Error('TEST FAILURE: writeStagingData called supabase.rpc despite invalid input')
    },
  } as unknown as SupabaseClient

  function makeOpening(overrides: Partial<StagingOpening> = {}): StagingOpening {
    return {
      door_number: '101',
      hw_set: 'DH1',
      leaf_count: 1,
      ...overrides,
    }
  }

  it('throws on empty door_number', async () => {
    const openings = [makeOpening({ door_number: '' })]
    await expect(
      writeStagingData(supabaseMustNotBeCalled, 'run-1', 'proj-1', openings, []),
    ).rejects.toThrow(/empty\/invalid door_number/)
  })

  it('throws on whitespace-only door_number', async () => {
    const openings = [makeOpening({ door_number: '   ' })]
    await expect(
      writeStagingData(supabaseMustNotBeCalled, 'run-1', 'proj-1', openings, []),
    ).rejects.toThrow(/empty\/invalid door_number/)
  })

  it('throws on null door_number (defensive — type says string but JS reality is fluid)', async () => {
    const openings = [makeOpening({ door_number: null as unknown as string })]
    await expect(
      writeStagingData(supabaseMustNotBeCalled, 'run-1', 'proj-1', openings, []),
    ).rejects.toThrow(/empty\/invalid door_number/)
  })

  it('throws when leaf_count is missing — Radius DC regression class', async () => {
    const openings = [makeOpening({ leaf_count: undefined })]
    await expect(
      writeStagingData(supabaseMustNotBeCalled, 'run-1', 'proj-1', openings, []),
    ).rejects.toThrow(/missing leaf_count/)
  })

  it('throws when leaf_count is null', async () => {
    const openings = [makeOpening({ leaf_count: null as unknown as number })]
    await expect(
      writeStagingData(supabaseMustNotBeCalled, 'run-1', 'proj-1', openings, []),
    ).rejects.toThrow(/missing leaf_count/)
  })

  it('reports the offending door_number in the leaf_count error', async () => {
    const openings = [makeOpening({ door_number: 'A1', leaf_count: undefined })]
    await expect(
      writeStagingData(supabaseMustNotBeCalled, 'run-1', 'proj-1', openings, []),
    ).rejects.toThrow(/A1/)
  })

  it('passes valid input through to supabase.rpc', async () => {
    // Now we DO want supabase to be called — wire up a minimal happy-path mock.
    const rpcCalls: unknown[] = []
    const supabase = {
      rpc: (...args: unknown[]) => {
        rpcCalls.push(args)
        return Promise.resolve({
          data: { success: true, openings_count: 1, items_count: 0 },
          error: null,
        })
      },
    } as unknown as SupabaseClient

    const openings = [makeOpening({ door_number: '101', leaf_count: 1 })]
    const result = await writeStagingData(supabase, 'run-1', 'proj-1', openings, [])
    expect(result).toEqual({ openingsCount: 1, itemsCount: 0 })
    expect(rpcCalls).toHaveLength(1)
  })
})
