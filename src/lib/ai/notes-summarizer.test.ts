/**
 * Tests for the punch-notes AI summarizer.
 *
 * The Anthropic client is mocked at the createAnthropicClient boundary so
 * tests don't need a real API key and don't hit the network. Tests cover:
 *   - Short-circuit return when there are no notes (no API call).
 *   - Happy path: tool_use response → parsed summary string.
 *   - Malformed model response (no tool_use, missing field) → throws.
 *   - Infrastructure errors → Sentry.captureMessage with notes-specific
 *     fingerprint.
 *   - Prompt assembly: door number, item names, and all note text are
 *     present in the user prompt sent to the model.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as Sentry from '@sentry/nextjs'
import {
  summarizeOpeningNotes,
  summarizeProjectPunchNotes,
} from './notes-summarizer'
import type { Note } from '@/lib/types/notes'

// ── Mock setup ──────────────────────────────────────────────────────────

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
}))

const mockMessagesCreate = vi.fn()

vi.mock('@/lib/parse-pdf-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/parse-pdf-helpers')>()
  return {
    ...actual,
    createAnthropicClient: () => ({
      messages: { create: mockMessagesCreate },
    }),
  }
})

beforeEach(() => {
  mockMessagesCreate.mockReset()
  vi.mocked(Sentry.captureMessage).mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── Helpers ─────────────────────────────────────────────────────────────

function makeOpeningNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    project_id: 'p1',
    scope: 'opening',
    opening_id: 'op-A',
    hardware_item_id: null,
    leaf_side: null,
    original_text: 'Trim has visible gouge near top-right corner',
    ai_text: null,
    display_mode: 'original',
    created_by: 'u1',
    created_at: '2026-04-19T10:00:00Z',
    updated_at: '2026-04-19T10:00:00Z',
    ...overrides,
  } as Note
}

function makeItemNote(itemId: string, text: string, id = 'n-i'): Note {
  return {
    id,
    project_id: 'p1',
    scope: 'item',
    opening_id: 'op-A',
    hardware_item_id: itemId,
    leaf_side: null,
    original_text: text,
    ai_text: null,
    display_mode: 'original',
    created_by: 'u1',
    created_at: '2026-04-19T10:00:00Z',
    updated_at: '2026-04-19T10:00:00Z',
  } as Note
}

function makeLeafNote(side: 'active' | 'inactive' | 'shared', text: string, id = 'n-l'): Note {
  return {
    id,
    project_id: 'p1',
    scope: 'leaf',
    opening_id: 'op-A',
    hardware_item_id: null,
    leaf_side: side,
    original_text: text,
    ai_text: null,
    display_mode: 'original',
    created_by: 'u1',
    created_at: '2026-04-19T10:00:00Z',
    updated_at: '2026-04-19T10:00:00Z',
  } as Note
}

function makeToolResponse(summary: string, inputTokens = 100, outputTokens = 50) {
  return {
    content: [{ type: 'tool_use', name: 'write_summary', input: { summary_markdown: summary } }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  }
}

// ── summarizeOpeningNotes ────────────────────────────────────────────────

describe('summarizeOpeningNotes', () => {
  it('returns empty string and skips API call when notes array is empty', async () => {
    const result = await summarizeOpeningNotes('110-01A', [], {})
    expect(result.summary).toBe('')
    expect(result.tokenUsage).toEqual({ input_tokens: 0, output_tokens: 0 })
    expect(mockMessagesCreate).not.toHaveBeenCalled()
  })

  it('returns the model-supplied summary on a happy path', async () => {
    const expected = '## Findings\n- **Trim damage** noted on top-right corner.'
    mockMessagesCreate.mockResolvedValue(makeToolResponse(expected, 1234, 567))

    const result = await summarizeOpeningNotes('110-01A', [makeOpeningNote()], {})

    expect(result.summary).toBe(expected)
    expect(result.tokenUsage).toEqual({ input_tokens: 1234, output_tokens: 567 })
    expect(mockMessagesCreate).toHaveBeenCalledOnce()
  })

  it('passes the door number and all note text into the user prompt', async () => {
    mockMessagesCreate.mockResolvedValue(makeToolResponse('summary'))

    await summarizeOpeningNotes(
      '110-02C',
      [
        makeOpeningNote({ original_text: 'Opening note: hand confirmed' }),
        makeItemNote('hw-1', 'Hinge missing one screw'),
        makeLeafNote('active', 'Leaf gap measurable on hinge side'),
      ],
      { 'hw-1': 'Hinges' },
    )

    const call = mockMessagesCreate.mock.calls[0][0]
    const userContent = call.messages[0].content as string

    expect(userContent).toContain('Door: 110-02C')
    expect(userContent).toContain('Opening note: hand confirmed')
    expect(userContent).toContain('Hinge missing one screw')
    expect(userContent).toContain('Leaf gap measurable on hinge side')
    expect(userContent).toContain('Hinges') // item label
    expect(userContent).toContain('active leaf')
  })

  it('throws when the model returns no tool_use block', async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'sorry, here is some prose instead' }],
      usage: { input_tokens: 10, output_tokens: 10 },
    })

    await expect(
      summarizeOpeningNotes('110-01A', [makeOpeningNote()], {}),
    ).rejects.toThrow(/did not return a tool_use block/)
  })

  it('throws when the tool_use block lacks summary_markdown', async () => {
    mockMessagesCreate.mockResolvedValue({
      content: [{ type: 'tool_use', name: 'write_summary', input: { wrong_field: 'x' } }],
      usage: { input_tokens: 10, output_tokens: 10 },
    })

    await expect(
      summarizeOpeningNotes('110-01A', [makeOpeningNote()], {}),
    ).rejects.toThrow(/missing summary_markdown/)
  })

  it('emits a Sentry message and re-throws on credit_balance error', async () => {
    mockMessagesCreate.mockRejectedValue(
      new Error('400: Your credit balance is too low to access the Anthropic API'),
    )

    await expect(
      summarizeOpeningNotes('110-01A', [makeOpeningNote()], {}),
    ).rejects.toThrow(/credit balance/)

    expect(Sentry.captureMessage).toHaveBeenCalledOnce()
    const call = vi.mocked(Sentry.captureMessage).mock.calls[0]
    expect(call[0]).toMatch(/credit_balance.*opening/)
    expect(call[1]).toMatchObject({
      level: 'fatal',
      fingerprint: ['notes-summarizer-infra', 'credit_balance', 'opening'],
    })
  })

  it('does NOT emit Sentry for ordinary (non-infra) errors', async () => {
    mockMessagesCreate.mockRejectedValue(new Error('Network timeout'))

    await expect(
      summarizeOpeningNotes('110-01A', [makeOpeningNote()], {}),
    ).rejects.toThrow(/Network timeout/)

    expect(Sentry.captureMessage).not.toHaveBeenCalled()
  })
})

// ── summarizeProjectPunchNotes ───────────────────────────────────────────

describe('summarizeProjectPunchNotes', () => {
  it('returns empty when both opening summaries and project notes are empty', async () => {
    const result = await summarizeProjectPunchNotes('Acme HQ', [], [])
    expect(result.summary).toBe('')
    expect(mockMessagesCreate).not.toHaveBeenCalled()
  })

  it('passes project name, opening summaries, and project-scope notes to the prompt', async () => {
    mockMessagesCreate.mockResolvedValue(makeToolResponse('project rollup'))

    const projectNote = {
      ...makeOpeningNote(),
      scope: 'project' as const,
      opening_id: null,
      original_text: 'GC asked us to expedite all 14-day-rated assemblies.',
    } as Note

    await summarizeProjectPunchNotes(
      'Acme HQ',
      [
        { door_number: '110-01A', summary: 'Door A is fine.' },
        { door_number: '110-02C', summary: 'Door C has hinge damage.' },
      ],
      [projectNote],
    )

    const call = mockMessagesCreate.mock.calls[0][0]
    const userContent = call.messages[0].content as string

    expect(userContent).toContain('Project: Acme HQ')
    expect(userContent).toContain('Door 110-01A')
    expect(userContent).toContain('Door 110-02C')
    expect(userContent).toContain('Door A is fine.')
    expect(userContent).toContain('Door C has hinge damage.')
    expect(userContent).toContain('GC asked us to expedite')
  })

  it('emits Sentry with project surface tag on rate_limit error', async () => {
    mockMessagesCreate.mockRejectedValue(new Error('rate_limit_error: too many requests'))

    await expect(
      summarizeProjectPunchNotes(
        'Acme HQ',
        [{ door_number: '110-01A', summary: 'Door A is fine.' }],
        [],
      ),
    ).rejects.toThrow(/rate_limit/)

    expect(Sentry.captureMessage).toHaveBeenCalledOnce()
    const call = vi.mocked(Sentry.captureMessage).mock.calls[0]
    expect(call[1]).toMatchObject({
      level: 'error', // rate_limit is error, not fatal
      fingerprint: ['notes-summarizer-infra', 'rate_limit', 'project'],
    })
  })
})
