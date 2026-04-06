/**
 * Tests for the response transformation logic used by ImportWizard steps.
 * These are pure-function tests — no React rendering needed.
 */
import { describe, it, expect } from 'vitest'
import type { ClassifyPagesResponse, DetectMappingResponse, TriageResult } from '../types'

// ── Transform functions extracted from StepUpload ──

function transformClassifyResponse(raw: Record<string, unknown>): ClassifyPagesResponse {
  const pageClassifications = (raw.page_classifications ?? []) as Array<{
    index: number
    type: string
    confidence?: number
  }>
  return {
    pages: pageClassifications.map((p) => ({
      page_number: p.index,
      page_type: p.type as ClassifyPagesResponse['pages'][0]['page_type'],
      confidence: p.confidence ?? 1,
    })),
    summary: {
      total_pages: (raw.total_pages as number) ?? pageClassifications.length,
      door_schedule_pages: pageClassifications
        .filter((p) => p.type === 'door_schedule')
        .map((p) => p.index),
      hardware_set_pages: pageClassifications
        .filter((p) => p.type === 'hardware_set')
        .map((p) => p.index),
      submittal_pages: pageClassifications
        .filter((p) => p.type === 'reference')
        .map((p) => p.index),
      other_pages: pageClassifications
        .filter((p) => p.type === 'other' || p.type === 'cover')
        .map((p) => p.index),
    },
  }
}

// ── Transform from StepMapColumns ──

function transformDetectMappingResponse(raw: Record<string, unknown>): DetectMappingResponse {
  const headers = (raw.headers ?? []) as string[]
  const autoMapping = (raw.auto_mapping ?? {}) as Record<string, number>
  const confidenceScores = (raw.confidence_scores ?? {}) as Record<string, number>

  const indexToField = new Map<number, string>()
  for (const [field, colIdx] of Object.entries(autoMapping)) {
    indexToField.set(colIdx, field)
  }

  return {
    columns: headers.map((header, i) => {
      const mappedField = indexToField.get(i) ?? null
      const confidence = mappedField ? (confidenceScores[mappedField] ?? 0) : 0
      return {
        source_header: header,
        mapped_field: mappedField as keyof import('../types').DoorEntry | null,
        confidence,
      }
    }),
    best_door_schedule_page: (raw.page_index as number) ?? 0,
    raw_headers: headers,
  }
}

// ── Transform from StepTriage ──

interface RawTriageClassification {
  door_number: string
  class: string
  confidence: string
  reason: string
}

function transformTriageResponse(
  raw: { classifications?: RawTriageClassification[]; stats?: Record<string, number> },
  extractedDoors: Array<{ door_number: string }>,
): TriageResult {
  const classifications = raw.classifications ?? []
  const acceptedDoors = extractedDoors.filter((d) => {
    const c = classifications.find((cl) => cl.door_number === d.door_number)
    return !c || c.class === 'door'
  })
  // Flag by_others doors and low-confidence non-door classifications.
  // Don't flag class="door" items — if triage failed, all doors come back
  // as class="door" + confidence="low" and flagging them all is useless.
  const flagged = classifications
    .filter((c) => c.class === 'by_others' || (c.confidence === 'low' && c.class !== 'door'))
    .map((c) => ({
      door_number: c.door_number,
      reason: c.reason,
      confidence: c.confidence === 'high' ? 0.9 : c.confidence === 'medium' ? 0.6 : 0.3,
    }))

  return {
    doors_found: raw.stats?.total ?? extractedDoors.length,
    by_others: raw.stats?.by_others ?? 0,
    rejected: raw.stats?.rejected ?? 0,
    accepted: acceptedDoors as TriageResult['accepted'],
    flagged,
  }
}

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
    expect(result.summary.other_pages).toEqual([4]) // cover goes to other
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
})

describe('transformDetectMappingResponse', () => {
  it('maps headers to columns with auto-mapping', () => {
    const raw = {
      headers: ['Opening', 'Hdw Set', 'Door Type', 'Frame Type'],
      auto_mapping: { door_number: 0, hw_set: 1, door_type: 2, frame_type: 3 },
      confidence_scores: { door_number: 0.7, hw_set: 1.0, door_type: 1.0, frame_type: 1.0 },
      page_index: 2,
    }
    const result = transformDetectMappingResponse(raw)

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
    const result = transformDetectMappingResponse(raw)

    expect(result.columns[1].mapped_field).toBeNull()
    expect(result.columns[1].confidence).toBe(0)
  })

  it('handles empty headers', () => {
    const result = transformDetectMappingResponse({ headers: [], auto_mapping: {} })
    expect(result.columns).toHaveLength(0)
    expect(result.raw_headers).toEqual([])
  })
})

describe('transformTriageResponse', () => {
  const doors = [
    { door_number: '101' },
    { door_number: '102' },
    { door_number: '103' },
    { door_number: 'L9175' }, // product code, should be rejected
  ]

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
})
