/**
 * Field-level and extraction-level confidence types for the extraction pipeline.
 *
 * Phase A of the "nuclear option" deep extraction design: add confidence scoring
 * to the fast extraction pipeline so we can (a) show users which fields are
 * reliable and (b) trigger auto-fallback to deep extraction when confidence is low.
 */

// ── Field-level confidence ───────────────────────────────────────

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'unverified'

export interface FieldConfidence {
  level: ConfidenceLevel
  /** Human-readable explanation, e.g. "pdfplumber extracted cleanly" or
   *  "Darrin corrected this value" */
  reason: string
}

export interface ItemConfidence {
  name: FieldConfidence
  qty: FieldConfidence
  manufacturer: FieldConfidence
  model: FieldConfidence
  finish: FieldConfidence
  /** Worst of all fields */
  overall: ConfidenceLevel
}

// ── Extraction-level confidence ──────────────────────────────────

export interface ExtractionConfidence {
  /** Overall extraction confidence */
  overall: ConfidenceLevel
  /** 0-100 numeric score */
  score: number
  /** List of reasons affecting confidence */
  signals: string[]
  /** Per set_id:item_name → ItemConfidence */
  item_confidence: Record<string, ItemConfidence>
  /** Whether the system suggests falling back to deep extraction */
  suggest_deep_extraction: boolean
  /** Reasons for suggesting deep extraction (empty if not suggested) */
  deep_extraction_reasons: string[]
}

// ── Auto-trigger thresholds ────────────────────────────────────

/**
 * Thresholds for auto-triggering deep extraction (Strategy B).
 * Deep extraction fires when ANY of these conditions are met.
 *
 * These align with the critical-signal checks in calculateExtractionConfidence()
 * (parse-pdf-helpers.ts). The function checks the same conditions but uses
 * inline constants — these are the canonical values for reference and testing.
 */
export const DEEP_EXTRACTION_AUTO_TRIGGER_THRESHOLD = {
  /** Auto-trigger if >30% of items have empty manufacturer + model */
  empty_field_pct: 0.30,
  /** Auto-trigger if >50% of Darrin corrections used fuzzy matching (tier 3+) */
  fuzzy_correction_pct: 0.50,
  /** Auto-trigger if >20% of items were flagged by Darrin */
  darrin_flag_pct: 0.20,
  /** Auto-trigger if overall confidence score < 40 */
  overall_score_below: 40,
} as const

/**
 * Check whether an ExtractionConfidence result warrants auto-triggering
 * deep extraction. Returns true if the confidence is low enough to justify it.
 *
 * This is the single source of truth for the auto-trigger decision.
 * Used by interactive routes (to set the response flag) and by the
 * background job route (to upgrade jobs in-place).
 */
export function shouldAutoTriggerDeepExtraction(
  confidence: ExtractionConfidence,
): boolean {
  // If the confidence calculation already suggests it, honour that
  if (confidence.suggest_deep_extraction) return true
  // Additional score-based threshold (catches edge cases where individual
  // signals didn't fire but the overall score is still poor)
  if (confidence.score < DEEP_EXTRACTION_AUTO_TRIGGER_THRESHOLD.overall_score_below) return true
  return false
}
