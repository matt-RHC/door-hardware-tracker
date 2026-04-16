import { z } from 'zod'

/**
 * Shared Zod schemas for the enriched classify phase_data payload and
 * for the user-override path that lets the Questions wizard step
 * correct misclassifications before extraction consumes the page lists.
 *
 * The Python classifier already produces rich per-page data
 * (confidence, section_labels, hw_set_ids). Prompt 4 forwards that data
 * through the orchestrator into phase_data.classify so StepQuestions can
 * render it and offer targeted corrections. These schemas are the
 * contract between the orchestrator writer and the UI reader.
 */

// ── Page type enum ──────────────────────────────────────────────────

/**
 * The set of page types the Python classifier emits. `hardware_sets`
 * (plural) is kept here for parity with PageClassification in
 * src/lib/types/index.ts — some older pipeline outputs use that label.
 * Both map to the same bucket when grouping.
 */
export const ClassifyPageTypeSchema = z.enum([
  'door_schedule',
  'hardware_set',
  'hardware_sets',
  'reference',
  'cover',
  'other',
])
export type ClassifyPageType = z.infer<typeof ClassifyPageTypeSchema>

// ── Per-page detail ─────────────────────────────────────────────────

/**
 * Compact shape of one page's classification, safe to store in
 * phase_data.classify.page_details. We copy just the fields the
 * Questions UI needs — full PageClassification lives in classify_result
 * for any downstream consumer that needs has_door_numbers / is_scanned.
 */
export const ClassifyPageDetailSchema = z.object({
  page: z.number().int().nonnegative(),
  type: ClassifyPageTypeSchema,
  confidence: z.number().min(0).max(1),
  labels: z.array(z.string()).default([]),
  hw_set_ids: z.array(z.string()).default([]),
})
export type ClassifyPageDetail = z.infer<typeof ClassifyPageDetailSchema>

// ── User overrides ──────────────────────────────────────────────────

/**
 * A single user correction. Either `excluded: true` (drop this page
 * from extraction entirely) or `type_override` (reclassify the page as
 * a different type). Both fields are optional because an override row
 * may carry only one intent; the orchestrator and UI both treat absent
 * fields as "no change from the classifier's verdict".
 */
export const ClassifyOverrideSchema = z.object({
  page: z.number().int().nonnegative(),
  excluded: z.boolean().optional(),
  type_override: ClassifyPageTypeSchema.optional(),
})
export type ClassifyOverride = z.infer<typeof ClassifyOverrideSchema>

export const ClassifyUserOverridesSchema = z.array(ClassifyOverrideSchema)
export type ClassifyUserOverrides = z.infer<typeof ClassifyUserOverridesSchema>

// ── Full phase_data.classify payload ────────────────────────────────

/**
 * The enriched shape the orchestrator writes after classification.
 *
 * Backward compatibility: the original three page-index arrays
 * (schedule_pages, hardware_pages, skipped_pages) remain. `skipped_pages`
 * now contains ONLY `other` pages (not cover+other as before) — cover
 * pages live in their own array. StepQuestions owns the one call site
 * that read skipped_pages; if any external consumer relied on the old
 * combined meaning it should switch to cover_pages + skipped_pages.
 */
export const ClassifyPhaseDataSchema = z.object({
  total_pages: z.number().int().nonnegative(),
  schedule_pages: z.array(z.number().int().nonnegative()),
  hardware_pages: z.array(z.number().int().nonnegative()),
  reference_pages: z.array(z.number().int().nonnegative()).default([]),
  cover_pages: z.array(z.number().int().nonnegative()).default([]),
  skipped_pages: z.array(z.number().int().nonnegative()),
  page_details: z.array(ClassifyPageDetailSchema).default([]),
  user_overrides: ClassifyUserOverridesSchema.optional(),
})
export type ClassifyPhaseData = z.infer<typeof ClassifyPhaseDataSchema>

// ── Override submission request ─────────────────────────────────────

/**
 * Body for POST /api/jobs/[id]/classify-overrides. The endpoint applies
 * overrides to the stored classify_result, rewrites the derived arrays
 * in phase_data.classify so downstream readers see the corrected state,
 * and keeps the raw overrides around so the orchestrator can re-apply
 * them deterministically when extraction starts.
 */
export const ClassifyOverridesRequestSchema = z.object({
  overrides: ClassifyUserOverridesSchema,
})
export type ClassifyOverridesRequest = z.infer<typeof ClassifyOverridesRequestSchema>

// ── Override application helper ─────────────────────────────────────

/**
 * Apply a set of user overrides to a per-page classification list and
 * return both the corrected page_details and the derived page-index
 * arrays. Pure function, safe to call from the route handler and the
 * orchestrator. Last override wins when two rows target the same page
 * (matches upsert semantics).
 */
export function applyClassifyOverrides(
  pageDetails: ClassifyPageDetail[],
  overrides: ClassifyUserOverrides,
): {
  pageDetails: ClassifyPageDetail[]
  schedule_pages: number[]
  hardware_pages: number[]
  reference_pages: number[]
  cover_pages: number[]
  skipped_pages: number[]
  excluded_pages: number[]
} {
  const byPage = new Map<number, ClassifyOverride>()
  for (const o of overrides) byPage.set(o.page, o)

  const excluded: number[] = []
  const corrected: ClassifyPageDetail[] = []
  for (const p of pageDetails) {
    const ov = byPage.get(p.page)
    if (ov?.excluded) {
      excluded.push(p.page)
      continue
    }
    if (ov?.type_override) {
      corrected.push({ ...p, type: ov.type_override })
    } else {
      corrected.push(p)
    }
  }

  const bucket = (type: ClassifyPageType) =>
    corrected.filter((p) => p.type === type).map((p) => p.page)

  // `hardware_sets` (plural) is a legacy label — merge it with
  // `hardware_set` so downstream extraction finds all hw pages.
  const hardware_pages = corrected
    .filter((p) => p.type === 'hardware_set' || p.type === 'hardware_sets')
    .map((p) => p.page)

  return {
    pageDetails: corrected,
    schedule_pages: bucket('door_schedule'),
    hardware_pages,
    reference_pages: bucket('reference'),
    cover_pages: bucket('cover'),
    skipped_pages: bucket('other'),
    excluded_pages: excluded,
  }
}
