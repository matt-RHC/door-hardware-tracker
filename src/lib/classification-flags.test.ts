import { describe, it, expect } from 'vitest'
import {
  detectSequentialGaps,
  isSmallJobOverClassified,
  detectSuspiciousPageType,
  detectClassificationFlags,
  buildPageDetails,
  SCHEDULE_GAP_THRESHOLD,
  SMALL_JOB_PAGE_LIMIT,
  SMALL_JOB_SCHEDULE_THRESHOLD,
} from './classification-flags'
import type { PageClassification } from '@/lib/types'

// ── Helpers ────────────────────────────────────────────────────────

function makePage(
  overrides: Partial<PageClassification> & { page_number: number; page_type: PageClassification['page_type'] },
): PageClassification {
  return {
    confidence: 0.9,
    section_labels: [],
    hw_set_ids: [],
    has_door_numbers: false,
    is_scanned: false,
    ...overrides,
  }
}

// ── Sequential gap detection ───────────────────────────────────────

describe('detectSequentialGaps', () => {
  it('returns empty when schedule pages are consecutive', () => {
    expect(detectSequentialGaps([0, 1, 2])).toEqual([])
  })

  it('returns empty with fewer than 2 schedule pages', () => {
    expect(detectSequentialGaps([])).toEqual([])
    expect(detectSequentialGaps([5])).toEqual([])
  })

  it('flags non-sequential pages (Lyft/Waymo scenario: 55 pages, scatter)', () => {
    // pages 0, 1, 28, 48, 52, 54 — everything after the 0/1 cluster is suspect.
    const suspects = detectSequentialGaps([0, 1, 28, 48, 52, 54])
    expect(suspects).toEqual([28, 48, 52, 54])
  })

  it('allows a gap of exactly SCHEDULE_GAP_THRESHOLD (= 2)', () => {
    expect(SCHEDULE_GAP_THRESHOLD).toBe(2)
    // gap of 2 (page 2 → page 4) is allowed
    expect(detectSequentialGaps([2, 4])).toEqual([])
  })

  it('flags when gap exceeds threshold', () => {
    // gap of 3 (page 2 → page 5) exceeds the threshold
    expect(detectSequentialGaps([2, 5])).toEqual([5])
  })

  it('tolerates unsorted input', () => {
    expect(detectSequentialGaps([28, 0, 1, 48])).toEqual([28, 48])
  })
})

// ── Small job heuristic ────────────────────────────────────────────

describe('isSmallJobOverClassified', () => {
  it('fires when a small doc has more than the allowed schedule pages', () => {
    expect(isSmallJobOverClassified(10, SMALL_JOB_SCHEDULE_THRESHOLD + 1)).toBe(true)
  })

  it('does not fire when the doc is not small', () => {
    expect(isSmallJobOverClassified(SMALL_JOB_PAGE_LIMIT + 5, 10)).toBe(false)
  })

  it('does not fire when the schedule count is within expected range', () => {
    expect(isSmallJobOverClassified(8, 2)).toBe(false)
    expect(isSmallJobOverClassified(8, SMALL_JOB_SCHEDULE_THRESHOLD)).toBe(false)
  })
})

// ── Suspicious-page-type detection ─────────────────────────────────

describe('detectSuspiciousPageType', () => {
  it('flags schedule pages tagged as manufacturer list', () => {
    const pages = [
      makePage({
        page_number: 3,
        page_type: 'door_schedule',
        section_labels: ['manufacturer list'],
        confidence: 0.7,
      }),
    ]
    expect(detectSuspiciousPageType(pages)).toEqual([
      { page: 3, classified_as: 'door_schedule' },
    ])
  })

  it('flags hardware_set pages tagged as cut sheet', () => {
    const pages = [
      makePage({
        page_number: 40,
        page_type: 'hardware_set',
        section_labels: ['cut_sheet'],
      }),
    ]
    expect(detectSuspiciousPageType(pages)).toEqual([
      { page: 40, classified_as: 'hardware_set' },
    ])
  })

  it('ignores reference pages themselves', () => {
    const pages = [
      makePage({
        page_number: 3,
        page_type: 'reference',
        section_labels: ['manufacturer list'],
      }),
    ]
    expect(detectSuspiciousPageType(pages)).toEqual([])
  })

  it('flags low-confidence schedule pages with no door numbers', () => {
    const pages = [
      makePage({
        page_number: 7,
        page_type: 'door_schedule',
        confidence: 0.5,
        has_door_numbers: false,
      }),
    ]
    expect(detectSuspiciousPageType(pages)).toEqual([
      { page: 7, classified_as: 'door_schedule' },
    ])
  })

  it('does not flag high-confidence schedule pages with door numbers', () => {
    const pages = [
      makePage({
        page_number: 2,
        page_type: 'door_schedule',
        confidence: 0.9,
        has_door_numbers: true,
      }),
    ]
    expect(detectSuspiciousPageType(pages)).toEqual([])
  })
})

// ── Combined detectClassificationFlags ─────────────────────────────

describe('detectClassificationFlags', () => {
  it('returns no flags for a clean small-job classification', () => {
    const pages = [
      makePage({ page_number: 0, page_type: 'cover' }),
      makePage({ page_number: 1, page_type: 'door_schedule', has_door_numbers: true }),
      makePage({ page_number: 2, page_type: 'hardware_set', hw_set_ids: ['A'] }),
      makePage({ page_number: 3, page_type: 'hardware_set', hw_set_ids: ['B'] }),
    ]
    const flags = detectClassificationFlags({ total_pages: 4, pages })
    expect(flags).toEqual([])
  })

  it('produces sequential_gap flag for the Lyft/Waymo scenario', () => {
    const schedulePageNums = [0, 1, 28, 48, 52, 54]
    const pages: PageClassification[] = [
      ...schedulePageNums.map(n =>
        makePage({
          page_number: n,
          page_type: 'door_schedule',
          has_door_numbers: true,
        }),
      ),
    ]
    // Pad out to 55 pages to make totals match the scenario.
    for (let i = 0; i < 55; i++) {
      if (!schedulePageNums.includes(i)) {
        pages.push(makePage({ page_number: i, page_type: 'other' }))
      }
    }
    const flags = detectClassificationFlags({ total_pages: 55, pages })
    const gapFlag = flags.find(f => f.type === 'sequential_gap')
    expect(gapFlag).toBeDefined()
    expect(gapFlag?.suspect_pages).toEqual([28, 48, 52, 54])
  })

  it('produces small_job flag when a small doc has many schedule pages', () => {
    const pages: PageClassification[] = []
    for (let i = 0; i < 10; i++) {
      pages.push(
        makePage({
          page_number: i,
          page_type: i < 5 ? 'door_schedule' : 'other',
          has_door_numbers: i < 5,
        }),
      )
    }
    const flags = detectClassificationFlags({ total_pages: 10, pages })
    const smallFlag = flags.find(f => f.type === 'small_job_many_schedule')
    expect(smallFlag).toBeDefined()
    expect(smallFlag?.suspect_pages).toEqual([0, 1, 2, 3, 4])
  })

  it('produces suspicious_page_type when a reference label lands on a schedule page', () => {
    const pages = [
      makePage({
        page_number: 3,
        page_type: 'door_schedule',
        section_labels: ['Manufacturer List'],
        has_door_numbers: true,
      }),
    ]
    const flags = detectClassificationFlags({ total_pages: 10, pages })
    expect(flags.some(f => f.type === 'suspicious_page_type')).toBe(true)
  })
})

// ── buildPageDetails ───────────────────────────────────────────────

describe('buildPageDetails', () => {
  it('filters out cover/other pages and marks flagged pages as suspect', () => {
    const pages = [
      makePage({ page_number: 0, page_type: 'cover' }),
      makePage({ page_number: 1, page_type: 'other' }),
      makePage({ page_number: 2, page_type: 'door_schedule', has_door_numbers: true }),
      makePage({ page_number: 3, page_type: 'reference' }),
      makePage({
        page_number: 4,
        page_type: 'hardware_set',
        hw_set_ids: ['A1'],
      }),
    ]
    const flags = [
      {
        type: 'sequential_gap' as const,
        classified_as: 'door_schedule' as const,
        suspect_pages: [2],
        message: 'test',
      },
    ]
    const details = buildPageDetails(pages, flags, { 2: 'Opening List header…' })
    expect(details.map(d => d.page)).toEqual([2, 3, 4])
    const p2 = details.find(d => d.page === 2)!
    expect(p2.is_false_positive_candidate).toBe(true)
    expect(p2.preview).toBe('Opening List header…')
    const p3 = details.find(d => d.page === 3)!
    expect(p3.is_false_positive_candidate).toBe(false)
  })
})
