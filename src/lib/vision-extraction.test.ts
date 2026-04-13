import { describe, it, expect, vi } from 'vitest'
import {
  VISION_EXTRACTION_PROMPT,
  callVisionExtraction,
  filterSchedulePages,
  type VisionExtractionResult,
  type VisionHardwareSet,
} from './parse-pdf-helpers'
import type { PageClassification } from '@/lib/types'

// ── Prompt domain knowledge ──────────────────────────────────────

describe('VISION_EXTRACTION_PROMPT — domain knowledge', () => {
  it('includes hardware categories', () => {
    const categories = [
      'hinges', 'locksets', 'exit devices', 'closers', 'door stops',
      'kick plates', 'thresholds', 'weatherstripping', 'smoke seals',
      'flush bolts', 'coordinators', 'overhead stops', 'magnetic holders',
      'electric strikes', 'electric hinges', 'electric latch retraction',
      'card readers', 'keypads',
    ]
    for (const cat of categories) {
      expect(VISION_EXTRACTION_PROMPT.toLowerCase()).toContain(cat.toLowerCase())
    }
  })

  it('includes manufacturer abbreviations', () => {
    const abbreviations = [
      'IVE', 'Ives', 'VD', 'Von Duprin', 'SCH', 'Schlage',
      'LCN', 'SA', 'Sargent', 'MK', 'McKinney', 'RO', 'Rockwood',
      'PE', 'Pemko', 'NGP', 'HAG', 'Hager',
    ]
    for (const abbr of abbreviations) {
      expect(VISION_EXTRACTION_PROMPT).toContain(abbr)
    }
  })

  it('specifies the expected JSON schema fields', () => {
    expect(VISION_EXTRACTION_PROMPT).toContain('"hardware_sets"')
    expect(VISION_EXTRACTION_PROMPT).toContain('"set_id"')
    expect(VISION_EXTRACTION_PROMPT).toContain('"heading"')
    expect(VISION_EXTRACTION_PROMPT).toContain('"items"')
    expect(VISION_EXTRACTION_PROMPT).toContain('"door_numbers"')
    expect(VISION_EXTRACTION_PROMPT).toContain('"qty_convention"')
    expect(VISION_EXTRACTION_PROMPT).toContain('"is_pair"')
    expect(VISION_EXTRACTION_PROMPT).toContain('"page_type"')
    expect(VISION_EXTRACTION_PROMPT).toContain('"continuation"')
  })

  it('includes category enum values', () => {
    const categories = [
      'hinge', 'lockset', 'exit_device', 'closer', 'door_stop',
      'kick_plate', 'threshold', 'weatherstripping', 'smoke_seal',
      'flush_bolt', 'coordinator', 'overhead_stop', 'magnetic_holder',
      'electric_strike', 'electric_hinge', 'elr', 'card_reader', 'keypad',
    ]
    for (const cat of categories) {
      expect(VISION_EXTRACTION_PROMPT).toContain(cat)
    }
  })
})

// ── Vision result parsing ────────────────────────────────────────

describe('callVisionExtraction — result parsing', () => {
  it('parses a well-formed vision model response', async () => {
    const mockResponse = {
      hardware_sets: [
        {
          set_id: 'DH1',
          heading: 'Hardware Set DH1 — Single Doors',
          items: [
            { name: 'Butt Hinge', qty: 3, manufacturer: 'McKinney', model: 'TA2314', finish: '652', category: 'hinge' },
            { name: 'Cylindrical Lock', qty: 1, manufacturer: 'Schlage', model: 'L9010', finish: '626', category: 'lockset' },
          ],
          door_numbers: ['101', '102', '103'],
          qty_convention: 'per_opening',
          is_pair: false,
        },
      ],
      page_type: 'schedule',
      continuation: false,
    }

    // Mock the Anthropic client
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: JSON.stringify(mockResponse) }],
          usage: {},
        }),
      },
    }

    const result = await callVisionExtraction(
      mockClient as never,
      'dummyBase64',
      [1],
      { projectId: 'test-project' },
    )

    expect(result.hardware_sets).toHaveLength(1)
    expect(result.hardware_sets[0].set_id).toBe('DH1')
    expect(result.hardware_sets[0].items).toHaveLength(2)
    expect(result.hardware_sets[0].items[0].name).toBe('Butt Hinge')
    expect(result.hardware_sets[0].items[0].qty).toBe(3)
    expect(result.hardware_sets[0].door_numbers).toEqual(['101', '102', '103'])
    expect(result.hardware_sets[0].qty_convention).toBe('per_opening')
    expect(result.hardware_sets[0].is_pair).toBe(false)
    expect(result.pages_processed).toBe(1)
    expect(result.model_used).toBe('claude-sonnet-4-20250514')
  })

  it('defaults qty to 1 when missing or invalid', async () => {
    const mockResponse = {
      hardware_sets: [
        {
          set_id: 'DH2',
          heading: 'Set DH2',
          items: [
            { name: 'Closer', qty: 0, manufacturer: 'LCN', model: '4040XP', finish: '689', category: 'closer' },
            { name: 'Kick Plate', manufacturer: 'Ives', model: '8400', finish: '630', category: 'kick_plate' },
          ],
          door_numbers: [],
          qty_convention: 'unknown',
          is_pair: false,
        },
      ],
      page_type: 'schedule',
      continuation: false,
    }

    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: JSON.stringify(mockResponse) }],
          usage: {},
        }),
      },
    }

    const result = await callVisionExtraction(
      mockClient as never,
      'dummyBase64',
      [1],
      {},
    )

    expect(result.hardware_sets[0].items[0].qty).toBe(1) // 0 → 1
    expect(result.hardware_sets[0].items[1].qty).toBe(1) // undefined → 1
  })

  it('handles empty response gracefully', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: '{"hardware_sets": [], "page_type": "cover", "continuation": false}' }],
          usage: {},
        }),
      },
    }

    const result = await callVisionExtraction(
      mockClient as never,
      'dummyBase64',
      [1],
      {},
    )

    expect(result.hardware_sets).toHaveLength(0)
    expect(result.pages_processed).toBe(1)
  })

  it('handles LLM error without crashing', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error('rate_limit')),
      },
    }

    const result = await callVisionExtraction(
      mockClient as never,
      'dummyBase64',
      [1],
      {},
    )

    expect(result.hardware_sets).toHaveLength(0)
    expect(result.page_results[0].sets_found).toBe(0)
  })
})

// ── Page batching ────────────────────────────────────────────────

describe('callVisionExtraction — page batching', () => {
  it('batches 20 pages into groups of 5', async () => {
    const callArgs: string[][] = []

    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async (params: { messages: Array<{ content: Array<{ type: string; text?: string }> }> }) => {
          // Capture which pages were requested
          const textBlock = params.messages[0].content.find(
            (b: { type: string }) => b.type === 'text',
          ) as { type: string; text?: string } | undefined
          if (textBlock?.text) {
            const pageMatch = textBlock.text.match(/pages? ([\d, ]+)/)
            if (pageMatch) callArgs.push(pageMatch[1].split(',').map(s => s.trim()))
          }
          return {
            content: [{ type: 'text', text: '{"hardware_sets": [], "page_type": "schedule", "continuation": false}' }],
            usage: {},
          }
        }),
      },
    }

    const pages = Array.from({ length: 20 }, (_, i) => i + 1)

    await callVisionExtraction(
      mockClient as never,
      'dummyBase64',
      pages,
      {},
      5,
    )

    // Should have made 4 calls (20 / 5 = 4 batches)
    expect(mockClient.messages.create).toHaveBeenCalledTimes(4)
    expect(callArgs).toHaveLength(4)
    expect(callArgs[0]).toEqual(['1', '2', '3', '4', '5'])
    expect(callArgs[1]).toEqual(['6', '7', '8', '9', '10'])
    expect(callArgs[2]).toEqual(['11', '12', '13', '14', '15'])
    expect(callArgs[3]).toEqual(['16', '17', '18', '19', '20'])
  })

  it('handles remainder batch correctly', async () => {
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: '{"hardware_sets": [], "page_type": "schedule", "continuation": false}' }],
          usage: {},
        }),
      },
    }

    const pages = [1, 2, 3, 4, 5, 6, 7]

    await callVisionExtraction(
      mockClient as never,
      'dummyBase64',
      pages,
      {},
      5,
    )

    // 7 pages with batch size 5: 2 batches (5 + 2)
    expect(mockClient.messages.create).toHaveBeenCalledTimes(2)
  })
})

// ── filterSchedulePages ──────────────────────────────────────────

describe('filterSchedulePages — cut sheet filtering', () => {
  it('skips cut sheets and covers, includes schedule pages', () => {
    const pages: PageClassification[] = [
      { page_number: 1, page_type: 'cover', confidence: 0.95 },
      { page_number: 2, page_type: 'door_schedule', confidence: 0.9 },
      { page_number: 3, page_type: 'hardware_sets', confidence: 0.85 },
      { page_number: 4, page_type: 'other', confidence: 0.6 },
      { page_number: 5, page_type: 'hardware_set', confidence: 0.8 },
      { page_number: 6, page_type: 'reference', confidence: 0.75 },
    ]

    const { schedulePages, skippedPages } = filterSchedulePages(pages)

    expect(schedulePages).toEqual([2, 3, 5])
    expect(skippedPages).toEqual([1, 4, 6])
  })

  it('returns empty when no schedule pages exist', () => {
    const pages: PageClassification[] = [
      { page_number: 1, page_type: 'cover', confidence: 0.95 },
      { page_number: 2, page_type: 'reference', confidence: 0.8 },
      { page_number: 3, page_type: 'other', confidence: 0.5 },
    ]

    const { schedulePages, skippedPages } = filterSchedulePages(pages)

    expect(schedulePages).toEqual([])
    expect(skippedPages).toEqual([1, 2, 3])
  })
})

// ── Continuation merging ─────────────────────────────────────────

describe('callVisionExtraction — continuation page merging', () => {
  it('merges sets that span multiple pages via continuation flag', async () => {
    let callCount = 0

    const mockClient = {
      messages: {
        create: vi.fn().mockImplementation(async () => {
          callCount++
          if (callCount === 1) {
            return {
              content: [{ type: 'text', text: JSON.stringify({
                hardware_sets: [{
                  set_id: 'DH5',
                  heading: 'Hardware Set DH5',
                  items: [
                    { name: 'Butt Hinge', qty: 3, manufacturer: 'McKinney', model: 'TA2314', finish: '652', category: 'hinge' },
                    { name: 'Closer', qty: 1, manufacturer: 'LCN', model: '4040XP', finish: '689', category: 'closer' },
                  ],
                  door_numbers: ['201', '202'],
                  qty_convention: 'per_opening',
                  is_pair: false,
                }],
                page_type: 'schedule',
                continuation: false,
              }) }],
              usage: {},
            }
          }
          // Second batch: continuation of DH5
          return {
            content: [{ type: 'text', text: JSON.stringify({
              hardware_sets: [{
                set_id: 'DH5',
                heading: 'Hardware Set DH5 (continued)',
                items: [
                  { name: 'Closer', qty: 1, manufacturer: 'LCN', model: '4040XP', finish: '689', category: 'closer' },
                  { name: 'Kick Plate', qty: 1, manufacturer: 'Ives', model: '8400', finish: '630', category: 'kick_plate' },
                ],
                door_numbers: ['203'],
                qty_convention: 'per_opening',
                is_pair: false,
              }],
              page_type: 'schedule',
              continuation: true,
            }) }],
            usage: {},
          }
        }),
      },
    }

    const result = await callVisionExtraction(
      mockClient as never,
      'dummyBase64',
      [1, 2, 3, 4],
      {},
      2,
    )

    // Should merge DH5 into one set instead of duplicating
    const dh5Sets = result.hardware_sets.filter(s => s.set_id === 'DH5')
    expect(dh5Sets).toHaveLength(1)

    // Items should be merged (Closer is deduplicated, Kick Plate added)
    expect(dh5Sets[0].items).toHaveLength(3)
    expect(dh5Sets[0].items.map(i => i.name).sort()).toEqual(['Butt Hinge', 'Closer', 'Kick Plate'])

    // Door numbers should be merged
    expect(dh5Sets[0].door_numbers).toContain('201')
    expect(dh5Sets[0].door_numbers).toContain('202')
    expect(dh5Sets[0].door_numbers).toContain('203')

    // Source pages should include both batches
    expect(dh5Sets[0].source_pages.length).toBeGreaterThan(0)
  })
})
