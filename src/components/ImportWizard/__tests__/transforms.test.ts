/**
 * Tests for the response transformation logic used by ImportWizard steps.
 * These are pure-function tests — no React rendering needed.
 */
import { describe, it, expect } from 'vitest'
import type { DoorEntry } from '../types'
import {
  transformClassifyResponse,
  transformDetectMappingResponse,
  transformTriageResponse,
} from '../transforms'

// ── Tests ──

describe('transformClassifyResponse', () => {
  it('converts page_classifications to pages with correct types', () => {
    const raw = {
      total_pages: 10,
      page_classifications: [
        { index: 0, type: 'cover', confidence: 0.95 },
        { index: 1, type: 'door_schedule', confidence: 0.88 },
        { index: 2, type: 'hardware_set', confidence: 0.92 },
        { index: 3, type: 'reference', confidence: 0.7 },
        { index: 4, type: 'other', confidence: 0.5 },
      ],
    }
    const result = transformClassifyResponse(raw)

    expect(result.pages).toHaveLength(5)
    expect(result.pages[1].page_type).toBe('door_schedule')
    expect(result.pages[1].page_number).toBe(1)
    expect(result.pages[1].confidence).toBe(0.88)
    expect(result.summary.total_pages).toBe(10)
  })

  it('builds summary arrays from page types', () => {
    const raw = {
      total_pages: 5,
      page_classifications: [
        { index: 0, type: 'door_schedule' },
        { index: 1, type: 'door_schedule' },
        { index: 2, type: 'hardware_set' },
        { index: 3, type: 'reference' },
        { index: 4, type: 'cover' },
      ],
    }
    const result = transformClassifyResponse(raw)

    expect(result.summary.door_schedule_pages).toEqual([0, 1])
    expect(result.summary.hardware_set_pages).toEqual([2])
    expect(result.summary.submittal_pages).toEqual([3])
    expect(result.summary.cover_pages).toEqual([4])
    expect(result.summary.other_pages).toEqual([])
  })

  it('handles empty classification', () => {
    const result = transformClassifyResponse({ total_pages: 0, page_classifications: [] })
    expect(result.pages).toHaveLength(0)
    expect(result.summary.door_schedule_pages).toEqual([])
  })

  it('defaults confidence to 1 when missing', () => {
    const raw = { page_classifications: [{ index: 0, type: 'other' }] }
    const result = transformClassifyResponse(raw)
    expect(result.pages[0].confidence).toBe(1)
  })

  // ── Tripwire: lock in superset fields that were silently dropped by the
  //    previous in-file copy of the transform. If any future edit removes
  //    these, these assertions will fail loudly.
  it('defaults superset page fields when absent from raw', () => {
    const raw = { page_classifications: [{ index: 0, type: 'door_schedule' }] }
    const result = transformClassifyResponse(raw)
    expect(result.pages[0].section_labels).toEqual([])
    expect(result.pages[0].hw_set_ids).toEqual([])
    expect(result.pages[0].has_door_numbers).toBe(false)
    expect(result.pages[0].is_scanned).toBe(false)
  })

  it('passes through superset page fields when present in raw', () => {
    const raw = {
      page_classifications: [
        {
          index: 0,
          type: 'door_schedule',
          section_labels: ['A1', 'A2'],
          hw_set_ids: ['HW-01'],
          has_door_numbers: true,
          is_scanned: true,
        },
      ],
    }
    const result = transformClassifyResponse(raw)
    expect(result.pages[0].section_labels).toEqual(['A1', 'A2'])
    expect(result.pages[0].hw_set_ids).toEqual(['HW-01'])
    expect(result.pages[0].has_door_numbers).toBe(true)
    expect(result.pages[0].is_scanned).toBe(true)
  })

  it('defaults summary.scanned_pages to 0 when absent', () => {
    const result = transformClassifyResponse({ page_classifications: [] })
    expect(result.summary.scanned_pages).toBe(0)
  })

  it('passes through summary.scanned_pages when present', () => {
    const raw = {
      page_classifications: [{ index: 0, type: 'door_schedule' }],
      summary: { scanned_pages: 3 },
    }
    const result = transformClassifyResponse(raw)
    expect(result.summary.scanned_pages).toBe(3)
  })

  it('round-trips profile and extraction_strategy from raw', () => {
    const profile = {
      source: 'python',
      heading_format: 'numbered',
      door_number_format: 'standard',
      table_strategy: 'grid',
      hw_set_count: 4,
      door_schedule_pages: 2,
      has_reference_tables: true,
    }
    const raw = {
      page_classifications: [{ index: 0, type: 'door_schedule' }],
      profile,
      extraction_strategy: 'deep',
    }
    const result = transformClassifyResponse(raw)
    expect(result.profile).toEqual(profile)
    expect(result.extraction_strategy).toBe('deep')
  })

  it('leaves profile and extraction_strategy undefined when absent', () => {
    const result = transformClassifyResponse({ page_classifications: [] })
    expect(result.profile).toBeUndefined()
    expect(result.extraction_strategy).toBeUndefined()
  })
})

describe('transformDetectMappingResponse', () => {
  it('maps headers to columns with auto-mapping', () => {
    const raw = {
      headers: ['Opening', 'Hdw Set', 'Door Type', 'Frame Type'],
      auto_mapping: { door_number: 0, hw_set: 1, door_type: 2, frame_type: 3 },
      confidence_scores: { door_number: 0.7, hw_set: 1.0, door_type: 1.0, frame_type: 1.0 },
      page_index: 2,
    }
    const result = transformDetectMappingResponse(raw, 0)

    expect(result.columns).toHaveLength(4)
    expect(result.columns[0].source_header).toBe('Opening')
    expect(result.columns[0].mapped_field).toBe('door_number')
    expect(result.columns[0].confidence).toBe(0.7)
    expect(result.columns[1].mapped_field).toBe('hw_set')
    expect(result.best_door_schedule_page).toBe(2)
    expect(result.raw_headers).toEqual(['Opening', 'Hdw Set', 'Door Type', 'Frame Type'])
  })

  it('leaves unmapped columns with null and zero confidence', () => {
    const raw = {
      headers: ['Opening', 'Unknown Col', 'Hdw Set'],
      auto_mapping: { door_number: 0, hw_set: 2 },
      confidence_scores: { door_number: 0.9, hw_set: 0.95 },
    }
    const result = transformDetectMappingResponse(raw, 0)

    expect(result.columns[1].mapped_field).toBeNull()
    expect(result.columns[1].confidence).toBe(0)
  })

  it('handles empty headers', () => {
    const result = transformDetectMappingResponse({ headers: [], auto_mapping: {} }, 0)
    expect(result.columns).toHaveLength(0)
    expect(result.raw_headers).toEqual([])
  })

  // ── Tripwire: fallbackPage is REQUIRED (no default). When raw.page_index
  //    is missing, the caller's fallback must be used — defaulting to 0
  //    would silently route the wizard to a cover page.
  it('uses fallbackPage when raw.page_index is missing', () => {
    const raw = {
      headers: ['Opening'],
      auto_mapping: { door_number: 0 },
      confidence_scores: { door_number: 0.9 },
    }
    const result = transformDetectMappingResponse(raw, 7)
    expect(result.best_door_schedule_page).toBe(7)
  })

  it('prefers raw.page_index over fallbackPage when present', () => {
    const raw = {
      headers: ['Opening'],
      auto_mapping: { door_number: 0 },
      confidence_scores: { door_number: 0.9 },
      page_index: 3,
    }
    const result = transformDetectMappingResponse(raw, 7)
    expect(result.best_door_schedule_page).toBe(3)
  })
})

describe('transformTriageResponse', () => {
  const doors = [
    { door_number: '101' },
    { door_number: '102' },
    { door_number: '103' },
    { door_number: 'L9175' }, // product code, should be rejected
  ] as DoorEntry[]

  it('accepts doors classified as "door"', () => {
    const raw = {
      classifications: [
        { door_number: '101', class: 'door', confidence: 'high', reason: 'valid' },
        { door_number: '102', class: 'door', confidence: 'medium', reason: 'valid' },
        { door_number: '103', class: 'by_others', confidence: 'high', reason: 'NH' },
        { door_number: 'L9175', class: 'reject', confidence: 'high', reason: 'product code' },
      ],
      stats: { total: 4, doors: 2, by_others: 1, rejected: 1 },
    }
    const result = transformTriageResponse(raw, doors)

    expect(result.doors_found).toBe(4)
    expect(result.by_others).toBe(1)
    expect(result.rejected).toBe(1)
    expect(result.accepted).toHaveLength(2) // 101, 102
    expect(result.accepted.map((d) => d.door_number)).toEqual(['101', '102'])
  })

  it('flags by_others and low-confidence non-door items', () => {
    const raw = {
      classifications: [
        { door_number: '101', class: 'door', confidence: 'high', reason: 'valid' },
        { door_number: '102', class: 'by_others', confidence: 'high', reason: 'ALBO' },
        { door_number: '103', class: 'door', confidence: 'low', reason: 'uncertain' },
        { door_number: 'L9175', class: 'reject', confidence: 'low', reason: 'product code' },
      ],
    }
    const result = transformTriageResponse(raw, doors)

    // 102 (by_others) + L9175 (low-confidence reject). Door 103 is NOT flagged
    // because class="door" + confidence="low" should not flag (triage fail-open).
    expect(result.flagged).toHaveLength(2)
    expect(result.flagged[0].door_number).toBe('102')
    expect(result.flagged[0].confidence).toBe(0.9) // high → 0.9
    expect(result.flagged[1].door_number).toBe('L9175')
    expect(result.flagged[1].confidence).toBe(0.3) // low → 0.3
  })

  it('accepts all doors when no classifications returned', () => {
    const result = transformTriageResponse({}, doors)
    expect(result.accepted).toHaveLength(4) // all accepted by default
    expect(result.flagged).toHaveLength(0)
  })

  // ── Tripwire: lock in triage_error / triage_error_message / retryable
  //    superset fields. These were silently dropped by the previous in-file
  //    copy — they must now flow through.
  it('forwards triage_error / triage_error_message / retryable when present', () => {
    const raw = {
      classifications: [],
      stats: { total: 0 },
      triage_error: true,
      triage_error_message: 'timeout',
      retryable: true,
    }
    const result = transformTriageResponse(raw, doors)
    expect(result.triage_error).toBe(true)
    expect(result.triage_error_message).toBe('timeout')
    expect(result.retryable).toBe(true)
  })

  it('defaults triage_error / retryable to false and message to undefined when absent', () => {
    const result = transformTriageResponse({}, doors)
    expect(result.triage_error).toBe(false)
    expect(result.triage_error_message).toBeUndefined()
    expect(result.retryable).toBe(false)
  })
})
