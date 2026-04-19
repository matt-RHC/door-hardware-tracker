/**
 * Tests for the punch-notes PDF document.
 *
 * Renders the document to a Buffer with @react-pdf/renderer and uses
 * pdf-parse to extract text. We assert structural facts (project name,
 * door numbers, summary content, page footer markers) appear — not the
 * pixel layout, which @react-pdf doesn't expose for inspection.
 *
 * Manual smoke is the real gate (download + open in Preview/Acrobat to
 * confirm typography + layout look client-ready). This test guards
 * against regressions like a missing field in the cover header or an
 * accidental crash on empty data.
 */

import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { PDFParse } from 'pdf-parse'
import {
  PunchNotesDocument,
  type PunchNotesPdfData,
} from './punch-notes-document'
import type { Note } from '@/lib/types/notes'

// ── Fixtures ────────────────────────────────────────────────────────────

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n-' + Math.random().toString(36).slice(2),
    project_id: 'p1',
    scope: 'opening',
    opening_id: 'op-1',
    hardware_item_id: null,
    leaf_side: null,
    original_text: 'A note about something on this opening.',
    ai_text: null,
    display_mode: 'original',
    created_by: 'u1',
    created_at: '2026-04-19T10:00:00Z',
    updated_at: '2026-04-19T10:00:00Z',
    ...overrides,
  } as Note
}

function makeData(overrides: Partial<PunchNotesPdfData> = {}): PunchNotesPdfData {
  return {
    project: {
      name: 'Test Project HQ',
      address: '123 Main St, Springfield IL',
      general_contractor: 'Acme Construction',
      job_number: 'JOB-1234',
      architect: 'Smith & Co Architects',
      summary_generated_at: '2026-04-19T12:00:00Z',
      summary:
        '## Findings\n- **Hinges damaged** on three openings.\n- Closer cycles low on Door 110-02C.',
    },
    openings: [
      {
        id: 'op-A',
        door_number: '110-01A',
        summary: '## Door A status\n- Receiving complete.\n- No issues noted.',
        notes: [
          makeNote({ id: 'n-A1', opening_id: 'op-A', original_text: 'Confirmed hand on site.' }),
        ],
      },
      {
        id: 'op-B',
        door_number: '110-02C',
        summary: null,
        notes: [
          makeNote({
            id: 'n-B1',
            opening_id: 'op-B',
            scope: 'item',
            hardware_item_id: 'hw-1',
            original_text: 'Hinge damaged top-right.',
          }),
        ],
      },
    ],
    projectScopeNotes: [
      makeNote({
        id: 'n-P1',
        scope: 'project',
        opening_id: null,
        original_text: 'GC asked for fire-rated assemblies expedited.',
      }),
    ],
    itemNames: { 'hw-1': 'Hinges' },
    generatedAt: '2026-04-19T18:00:00Z',
    preparedBy: 'Matt Feagin',
    ...overrides,
  }
}

async function renderAndParse(data: PunchNotesPdfData) {
  const buffer = await renderToBuffer(<PunchNotesDocument data={data} />)
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  const result = await parser.getText()
  await parser.destroy()
  // PDFParse.getText() returns { pages: Array<{ text: string }>, ... }
  // Concatenate all page text into one string for substring assertions.
  const text = result.pages.map(p => p.text).join('\n')
  return { buffer, text, numpages: result.pages.length }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('PunchNotesDocument', () => {
  it('renders a non-empty PDF buffer for typical input', async () => {
    const { buffer } = await renderAndParse(makeData())
    expect(buffer.byteLength).toBeGreaterThan(1000)
  }, 10_000)

  it('includes the project name, GC, and address in the cover header', async () => {
    const { text } = await renderAndParse(makeData())
    expect(text).toContain('Test Project HQ')
    expect(text).toContain('Acme Construction')
    expect(text).toContain('123 Main St, Springfield IL')
    expect(text).toContain('JOB-1234')
    expect(text).toContain('Matt Feagin')
  }, 10_000)

  it('includes door numbers and per-opening summaries', async () => {
    const { text } = await renderAndParse(makeData())
    expect(text).toContain('Door 110-01A')
    expect(text).toContain('Door 110-02C')
    expect(text).toContain('Door A status')
    expect(text).toContain('Receiving complete')
  }, 10_000)

  it('includes project-scope notes inline', async () => {
    const { text } = await renderAndParse(makeData())
    expect(text).toContain('GC asked for fire-rated assemblies')
  }, 10_000)

  it('strips **bold** markers from markdown rather than printing them literally', async () => {
    const { text } = await renderAndParse(makeData())
    expect(text).toContain('Hinges damaged') // text content survives
    expect(text).not.toContain('**Hinges damaged**') // markers stripped
  }, 10_000)

  it('renders a placeholder when an opening has no AI summary', async () => {
    const { text } = await renderAndParse(makeData())
    expect(text).toContain('No summary generated for this opening')
  }, 10_000)

  it('handles a project with no openings and no summary without crashing', async () => {
    const minimal = makeData({
      project: {
        name: 'Empty Project',
        address: null,
        general_contractor: null,
        job_number: null,
        architect: null,
        summary_generated_at: null,
        summary: null,
      },
      openings: [],
      projectScopeNotes: [],
    })
    const { buffer, text } = await renderAndParse(minimal)
    expect(buffer.byteLength).toBeGreaterThan(500)
    expect(text).toContain('Empty Project')
    expect(text).toContain('No project summary has been generated')
  }, 10_000)

  it('groups item-scope notes by their item name when itemNames is provided', async () => {
    const { text } = await renderAndParse(makeData())
    // The item-scope note on op-B should appear under the "Hinges" group label.
    expect(text).toContain('Hinges')
    expect(text).toContain('Hinge damaged top-right')
  }, 10_000)
})
