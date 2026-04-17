import type {
  ClassifyPageDetail,
  ClassifyPhaseData,
} from "@/lib/schemas/classify"

/**
 * Pure, testable sanity checks on the classify phase_data payload.
 *
 * Each heuristic flags something the user would probably want to
 * inspect before letting extraction run. Together they drive the
 * `concerned`-vs-`scanning` Darrin mood in StepQuestions and seed the
 * copy that nudges the user into the correction panel.
 *
 * Design notes:
 * - All functions are pure: they take data, return flags. No side
 *   effects, no React, no network. Matches the rescan-apply.ts pattern.
 * - Each flag carries enough context (pages, message, severity) for
 *   the UI to render without re-deriving anything.
 * - `flagCode` is a stable string for telemetry / test assertions; the
 *   `message` is human-facing and may be tweaked later without
 *   breaking tests.
 */

export type HeuristicSeverity = "info" | "warning"

export interface HeuristicFlag {
  /** Stable machine-readable identifier. */
  code:
    | "sequential_gap"
    | "small_job_overclassification"
    | "low_confidence"
    | "missing_hardware"
  severity: HeuristicSeverity
  /** Page numbers this flag points at, if applicable. */
  pages: number[]
  /** Single-sentence, user-facing description. */
  message: string
}

// ── Heuristic: sequential gap in schedule pages ─────────────────────

/**
 * Opening-list pages in a real submittal cluster together — they're
 * almost always a small contiguous block near the front. If we find
 * schedule pages scattered across the document with gaps larger than
 * GAP_THRESHOLD between them, the outliers are probably something else
 * (a stray QC sheet, a continuation page misclassified, etc.).
 *
 * We report the outliers specifically: anything whose gap to its
 * nearest schedule neighbor exceeds the threshold.
 */
const SCHEDULE_GAP_THRESHOLD = 2

export function detectSequentialGaps(schedulePages: number[]): number[] {
  if (schedulePages.length < 2) return []
  const sorted = [...schedulePages].sort((a, b) => a - b)
  const outliers: number[] = []
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i]
    const prevGap = i > 0 ? current - sorted[i - 1] : Infinity
    const nextGap =
      i < sorted.length - 1 ? sorted[i + 1] - current : Infinity
    // A page is an outlier if BOTH its neighbors are far away. That
    // way a tight cluster of 3-4 pages doesn't flag its own members
    // just because the cluster is far from another cluster.
    if (prevGap > SCHEDULE_GAP_THRESHOLD && nextGap > SCHEDULE_GAP_THRESHOLD) {
      outliers.push(current)
    }
  }
  return outliers
}

// ── Heuristic: small job with too many schedule pages ──────────────

/**
 * A 9-page submittal with 5 "schedule" pages is suspicious — typical
 * small jobs have 1-2. Flags the case where schedule page count looks
 * disproportionate to total page count. Uses a ratio rather than a
 * hard count so it scales gently.
 */
const SMALL_JOB_PAGE_CAP = 15
const SMALL_JOB_SCHEDULE_MAX = 3

export function detectSmallJobOverclassification(
  totalPages: number,
  schedulePages: number[],
): boolean {
  if (totalPages === 0) return false
  if (totalPages > SMALL_JOB_PAGE_CAP) return false
  return schedulePages.length > SMALL_JOB_SCHEDULE_MAX
}

// ── Heuristic: low-confidence pages ─────────────────────────────────

/**
 * The Python classifier emits a confidence per page. Anything below
 * 0.6 is "the rules matched but not strongly" — worth surfacing.
 * Excludes pages with no page_details entry (e.g., totally blank
 * pages where the classifier short-circuits).
 */
const LOW_CONFIDENCE_THRESHOLD = 0.6

export function detectLowConfidencePages(
  pageDetails: ClassifyPageDetail[],
): number[] {
  return pageDetails
    .filter((p) => p.confidence < LOW_CONFIDENCE_THRESHOLD)
    .map((p) => p.page)
}

// ── Heuristic: schedule pages with zero hardware pages ──────────────

/**
 * If the classifier found door schedules but zero hardware headings,
 * the headings were almost certainly misclassified (probably as
 * `reference` or `other`). This is a hard block on extraction
 * succeeding, so we flag it prominently.
 */
export function detectMissingHardware(
  schedulePages: number[],
  hardwarePages: number[],
): boolean {
  return schedulePages.length > 0 && hardwarePages.length === 0
}

// ── Top-level runner ────────────────────────────────────────────────

/**
 * Run every heuristic and return a flat list of flags. Order is
 * deterministic: most-severe first (missing_hardware, then the
 * two "might be misclassified" flags, then low-confidence info).
 */
export function runClassifyHeuristics(
  classify: ClassifyPhaseData,
): HeuristicFlag[] {
  const flags: HeuristicFlag[] = []

  if (detectMissingHardware(classify.schedule_pages, classify.hardware_pages)) {
    flags.push({
      code: "missing_hardware",
      severity: "warning",
      pages: [],
      message:
        "I found door schedules but no hardware headings — the headings may be misclassified.",
    })
  }

  const gapOutliers = detectSequentialGaps(classify.schedule_pages)
  if (gapOutliers.length > 0) {
    const pageList =
      gapOutliers.length <= 4
        ? gapOutliers.join(", ")
        : `${gapOutliers.slice(0, 3).join(", ")}, +${gapOutliers.length - 3} more`
    flags.push({
      code: "sequential_gap",
      severity: "warning",
      pages: gapOutliers,
      message: `Pages ${pageList} aren't near the other schedule pages — they might be misclassified.`,
    })
  }

  if (
    detectSmallJobOverclassification(
      classify.total_pages,
      classify.schedule_pages,
    )
  ) {
    flags.push({
      code: "small_job_overclassification",
      severity: "warning",
      pages: classify.schedule_pages,
      message:
        "This is a small submittal — I'd usually expect 1-2 schedule pages.",
    })
  }

  const lowConf = detectLowConfidencePages(classify.page_details ?? [])
  if (lowConf.length > 0) {
    const pageList =
      lowConf.length <= 4
        ? lowConf.join(", ")
        : `${lowConf.slice(0, 3).join(", ")}, +${lowConf.length - 3} more`
    flags.push({
      code: "low_confidence",
      severity: "info",
      pages: lowConf,
      message: `I'm not very confident about page${lowConf.length === 1 ? "" : "s"} ${pageList} — worth a look.`,
    })
  }

  return flags
}

// ── Set-id summary helper ───────────────────────────────────────────

/**
 * Collapse the list of hw_set_ids across hardware pages into a compact
 * display string like "H01, H02, H03 (+12 more)". Used by the Questions
 * message so users see what sets were actually found, not just page
 * numbers.
 */
const MAX_DISPLAYED_SETS = 6

export function summarizeHardwareSetIds(
  pageDetails: ClassifyPageDetail[],
): string {
  const ids = new Set<string>()
  for (const p of pageDetails) {
    if (p.type !== "hardware_set" && p.type !== "hardware_sets") continue
    for (const id of p.hw_set_ids) {
      if (id && id.trim()) ids.add(id.trim())
    }
  }
  if (ids.size === 0) return ""
  const sorted = Array.from(ids).sort()
  if (sorted.length <= MAX_DISPLAYED_SETS) return sorted.join(", ")
  const shown = sorted.slice(0, MAX_DISPLAYED_SETS - 1).join(", ")
  return `${shown}, +${sorted.length - (MAX_DISPLAYED_SETS - 1)} more`
}
