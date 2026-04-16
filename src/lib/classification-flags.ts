/**
 * Classification false-positive detection.
 *
 * After the Python classifier returns page_classifications, we run a second
 * pass of heuristics to spot cases where a page was *probably* mis-labelled
 * as a door schedule or hardware set. The flags produced here are surfaced
 * in the Questions step so Darrin can ask the user to confirm before the
 * pipeline commits to the classification.
 *
 * Design decisions:
 *   - Pure TypeScript, no PDF access. Everything here is derived from the
 *     classify-pages response so it can run in the job orchestrator and in
 *     unit tests without a pdfplumber dependency.
 *   - Heuristics are intentionally conservative. We *suggest* a page might
 *     be a false positive — we do not reclassify it automatically. The user
 *     still has the final call via the "Something's off" → page-by-page
 *     review flow.
 */
import type { PageClassification } from '@/lib/types'

// ── Thresholds ─────────────────────────────────────────────────────

/** Max gap between schedule pages before we consider them "non-sequential". */
export const SCHEDULE_GAP_THRESHOLD = 2

/** Document size below which we expect a compact door schedule (1-2 pages). */
export const SMALL_JOB_PAGE_LIMIT = 15

/** How many schedule pages trigger a small-job suspicion. */
export const SMALL_JOB_SCHEDULE_THRESHOLD = 3

// ── Types ──────────────────────────────────────────────────────────

export type ClassificationFlagType =
  | 'sequential_gap'
  | 'small_job_many_schedule'
  | 'suspicious_page_type'

export interface ClassificationFlag {
  type: ClassificationFlagType
  /** Human-readable message suitable for showing to the user. */
  message: string
  /** Page indices the flag applies to (0-indexed, matches classify output). */
  suspect_pages: number[]
  /** Page type being flagged. */
  classified_as: 'door_schedule' | 'hardware_set'
}

export interface ClassificationFlagsInput {
  total_pages: number
  pages: PageClassification[]
}

// ── Heuristics ─────────────────────────────────────────────────────

/**
 * Identify schedule pages that are non-sequential with large gaps between
 * them. Real door schedules are typically 1-3 consecutive pages at the
 * front of a submittal; pages scattered across the document (page 0, 1,
 * 28, 48, 52, 54 in a 55-page PDF) are almost always false positives —
 * usually cover sheets, notes pages, or cut sheets that happen to match
 * a heuristic.
 *
 * We keep the *first cluster* of schedule pages (pages <= first + gap)
 * and flag everything after a gap larger than the threshold.
 */
export function detectSequentialGaps(
  schedulePages: number[],
  gapThreshold: number = SCHEDULE_GAP_THRESHOLD,
): number[] {
  if (schedulePages.length < 2) return []
  const sorted = [...schedulePages].sort((a, b) => a - b)
  const suspect: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > gapThreshold) {
      // Everything from this point on is suspected of being a false positive.
      suspect.push(...sorted.slice(i))
      break
    }
  }
  return suspect
}

/**
 * Small-job heuristic: if the doc has fewer than ~15 pages, we expect at
 * most a couple of schedule pages. Anything more means the classifier is
 * lumping reference tables or cover sheets in with the schedule.
 */
export function isSmallJobOverClassified(
  totalPages: number,
  schedulePageCount: number,
): boolean {
  return (
    totalPages < SMALL_JOB_PAGE_LIMIT &&
    schedulePageCount > SMALL_JOB_SCHEDULE_THRESHOLD
  )
}

/**
 * Section-label based check. The Python classifier tags each page with
 * `section_labels` when it matches a known non-schedule pattern
 * (manufacturer list, finish list, cut sheet, notes, etc.) even when
 * the page was ultimately labelled door_schedule or hardware_set. If
 * any of those labels appear on a schedule/hardware page, flag it.
 *
 * Currently this catches continuation-labelled hardware_set pages only
 * if they show up *before* any set heading — otherwise they are
 * legitimate continuation pages. Known non-schedule labels that still
 * end up on a schedule page are always flagged.
 */
const NON_SCHEDULE_LABEL_PATTERNS = [
  /manufacturer\s*list/i,
  /finish\s*list/i,
  /option\s*list/i,
  /abbreviation/i,
  /legend/i,
  /cut[\s_]*sheet/i,
  /catalog/i,
  /notes?$/i,
  /general\s*notes?/i,
]

function hasNonScheduleLabel(labels: readonly string[]): boolean {
  return labels.some(label =>
    NON_SCHEDULE_LABEL_PATTERNS.some(pattern => pattern.test(label)),
  )
}

export function detectSuspiciousPageType(
  pages: PageClassification[],
): Array<{ page: number; classified_as: 'door_schedule' | 'hardware_set' }> {
  const suspects: Array<{
    page: number
    classified_as: 'door_schedule' | 'hardware_set'
  }> = []
  for (const page of pages) {
    if (page.page_type !== 'door_schedule' && page.page_type !== 'hardware_set') {
      continue
    }
    const labels = page.section_labels ?? []
    if (hasNonScheduleLabel(labels)) {
      suspects.push({
        page: page.page_number,
        classified_as: page.page_type,
      })
      continue
    }
    // Schedule page with no door numbers and very low confidence — this is
    // usually a text-heavy page that barely squeaked past the door-number
    // count heuristic. Worth double-checking.
    if (
      page.page_type === 'door_schedule' &&
      page.has_door_numbers === false &&
      (page.confidence ?? 1) < 0.6
    ) {
      suspects.push({
        page: page.page_number,
        classified_as: 'door_schedule',
      })
    }
  }
  return suspects
}

// ── Top-level API ──────────────────────────────────────────────────

/**
 * Combine all heuristics into a list of flags ready for the UI.
 *
 * Returning an empty array means "we have no reason to suspect the
 * classification". The UI should only show the warning affordance
 * when the array is non-empty.
 */
export function detectClassificationFlags(
  input: ClassificationFlagsInput,
): ClassificationFlag[] {
  const { total_pages, pages } = input
  const schedulePages = pages
    .filter(p => p.page_type === 'door_schedule')
    .map(p => p.page_number)
    .sort((a, b) => a - b)

  const flags: ClassificationFlag[] = []

  // 1. Non-sequential schedule pages
  const gapSuspects = detectSequentialGaps(schedulePages)
  if (gapSuspects.length > 0) {
    flags.push({
      type: 'sequential_gap',
      classified_as: 'door_schedule',
      suspect_pages: gapSuspects,
      message:
        `Schedule pages aren't consecutive — pages ${gapSuspects.join(', ')} ` +
        `might not actually be schedule data. Real door schedules usually ` +
        `run 1-3 pages in a row.`,
    })
  }

  // 2. Small job with too many schedule pages
  if (isSmallJobOverClassified(total_pages, schedulePages.length)) {
    flags.push({
      type: 'small_job_many_schedule',
      classified_as: 'door_schedule',
      suspect_pages: schedulePages,
      message:
        `This is a small submittal (${total_pages} pages) but I flagged ` +
        `${schedulePages.length} as schedule pages. On a job this size I'd ` +
        `expect 1-2 schedule pages max.`,
    })
  }

  // 3. Known non-schedule labels landing on schedule/hardware pages
  const suspicious = detectSuspiciousPageType(pages)
  if (suspicious.length > 0) {
    const scheduleSuspects = suspicious
      .filter(s => s.classified_as === 'door_schedule')
      .map(s => s.page)
    const hardwareSuspects = suspicious
      .filter(s => s.classified_as === 'hardware_set')
      .map(s => s.page)

    if (scheduleSuspects.length > 0) {
      flags.push({
        type: 'suspicious_page_type',
        classified_as: 'door_schedule',
        suspect_pages: scheduleSuspects,
        message:
          `Page${scheduleSuspects.length > 1 ? 's' : ''} ` +
          `${scheduleSuspects.join(', ')} look${scheduleSuspects.length === 1 ? 's' : ''} ` +
          `like reference material (manufacturer/finish list, notes, cut sheet) ` +
          `rather than a door schedule.`,
      })
    }
    if (hardwareSuspects.length > 0) {
      flags.push({
        type: 'suspicious_page_type',
        classified_as: 'hardware_set',
        suspect_pages: hardwareSuspects,
        message:
          `Page${hardwareSuspects.length > 1 ? 's' : ''} ` +
          `${hardwareSuspects.join(', ')} look${hardwareSuspects.length === 1 ? 's' : ''} ` +
          `like reference material rather than hardware sets.`,
      })
    }
  }

  return flags
}

// ── Page detail builder ────────────────────────────────────────────

/**
 * Minimal per-page summary shown in the "Something's off" expandable
 * panel. We intentionally avoid shipping the full page text — just
 * enough context (type, short preview, detected set IDs / door number
 * signal) for the user to eyeball the classifier's decision.
 */
export interface PageDetail {
  page: number
  page_type: PageClassification['page_type']
  confidence: number
  /** Short text preview (≤ ~200 chars) if available from the classifier. */
  preview?: string
  hw_set_ids: string[]
  has_door_numbers: boolean
  section_labels: string[]
  /** True if any flag marks this page as a potential false positive. */
  is_false_positive_candidate: boolean
}

export function buildPageDetails(
  pages: PageClassification[],
  flags: ClassificationFlag[],
  textPreviews: Record<number, string> = {},
): PageDetail[] {
  const suspectSet = new Set<number>()
  for (const f of flags) {
    for (const p of f.suspect_pages) suspectSet.add(p)
  }

  // Only surface pages that were classified as schedule/hardware/reference
  // so the UI doesn't drown the user in cover/other detail.
  const relevantTypes: PageClassification['page_type'][] = [
    'door_schedule',
    'hardware_set',
    'hardware_sets',
    'reference',
  ]

  return pages
    .filter(p => relevantTypes.includes(p.page_type))
    .map(p => ({
      page: p.page_number,
      page_type: p.page_type,
      confidence: p.confidence ?? 0,
      preview: textPreviews[p.page_number],
      hw_set_ids: p.hw_set_ids ?? [],
      has_door_numbers: p.has_door_numbers ?? false,
      section_labels: p.section_labels ?? [],
      is_false_positive_candidate: suspectSet.has(p.page_number),
    }))
}
