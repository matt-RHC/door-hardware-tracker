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
   *  "Punchy corrected this value" */
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
