/**
 * Canonical domain types for parsed PDF data.
 *
 * These represent data extracted from hardware submittal PDFs — NOT database
 * rows. For database row types, import from '@/lib/types/database'.
 */

// Re-export confidence types for convenience
export type {
  ConfidenceLevel,
  FieldConfidence,
  ItemConfidence,
  ExtractionConfidence,
} from './confidence'
import type { ItemConfidence } from './confidence'

// ── Core domain types ─────────────────────────────────────────────

/** A door/opening parsed from a PDF document. */
export interface DoorEntry {
  door_number: string
  hw_set: string
  hw_heading?: string
  location: string
  door_type: string
  frame_type: string
  fire_rating: string
  hand: string
  field_confidence?: Record<string, number>
  by_others?: boolean
  leaf_count?: number
}

/**
 * qty_source values form the contract between Python, TS, Punchy, and the DB.
 *
 * Values set by Python (extract-tables.py normalize_quantities):
 *   'parsed'         — raw PDF value, plausibly already per-opening, no action needed
 *   'needs_division' — Python recommends dividing by qty_door_count; TS must act
 *   'needs_cap'      — single-door set, qty exceeds category max; TS applies cap
 *   'needs_review'   — auto-operator + closer conflict; ambiguous, show user
 *   'rhr_lhr_pair'   — both RH and LH variants present; TS should set qty=1 each
 *
 * Values set by TS normalizeQuantities() (the single authoritative division pass):
 *   'divided'        — TS divided the raw PDF total; qty is now per-opening/per-leaf
 *   'flagged'        — TS divided but result was non-integer (rounded); needs user review
 *   'capped'         — TS applied category max cap on a single-door set
 *
 * Values set by Punchy / user interactions (NEVER re-normalized after this point):
 *   'llm_override'   — Punchy CP2 or CP3 explicitly corrected this qty
 *   'auto_corrected' — PunchyReview UI auto-applied a high-confidence correction
 *   'deep_extract'   — Claude vision pulled this qty from a targeted PDF region
 *   'region_extract' — same as deep_extract (older label)
 *   'propagated'     — apply-to-all copy of an already-normalized qty
 *   'reverted'       — user manually reverted an auto-correction
 *   'manual_placeholder' — triage-time placeholder, user will edit
 *
 * NEVER_RENORMALIZE (in parse-pdf-helpers.ts) contains all terminal values.
 * normalizeQuantities() must skip any item whose qty_source is terminal.
 */

/** A single hardware item within a hardware set. */
export interface ExtractedHardwareItem {
  qty: number
  qty_total?: number
  qty_door_count?: number
  qty_source?: string
  /** Original qty before Punchy auto-correction. Set when qty_source
   *  becomes 'auto_corrected'. Used by StepReview to show revert button. */
  qty_before_correction?: number
  name: string
  model: string
  finish: string
  manufacturer: string
  /** Product family identifier extracted from model string (e.g., "5BB1",
   *  "L9010", "4040XP"). Populated by Python extraction, validated/filled
   *  client-side if missing. Used for product family grouping in StepProducts. */
  base_series?: string
  /** Per-field confidence scores computed after the full extraction pipeline.
   *  Optional — only populated when confidence scoring is enabled. */
  confidence?: ItemConfidence
}

/** A hardware set grouping items for a set of doors. */
export interface HardwareSet {
  set_id: string
  generic_set_id?: string
  heading: string
  heading_door_count?: number
  heading_leaf_count?: number
  /** Specific door numbers listed under this sub-heading. Used to match
   *  openings to their exact sub-set when multiple sub-headings share a
   *  generic_set_id (e.g., DH4A.0 and DH4A.1 under "DH4A"). */
  heading_doors?: string[]
  /** Quantity convention detected from preamble text.
   *  "per_opening" = quantities are per-opening (e.g., "Each opening to have:")
   *  "aggregate"   = quantities are totals across all doors in the heading
   *  "unknown"     = could not determine (falls back to statistical heuristic) */
  qty_convention?: 'per_opening' | 'aggregate' | 'unknown'
  /** 0-based PDF page index where this set's definition lives. Populated
   *  at wizard extraction time via findPageForSet() and persisted to
   *  openings.pdf_page on save. null if the set could not be matched to a
   *  page in the classify-pages result. */
  pdf_page?: number | null
  items: ExtractedHardwareItem[]
}

// ── Flagged door types ────────────────────────────────────────────

/** A door flagged for review during triage (simple form). */
export interface FlaggedDoor {
  door_number: string
  reason: string
  confidence: number
}

/** A door flagged by pdfplumber with full context (expanded form). */
export interface PdfplumberFlaggedDoor {
  door: DoorEntry
  reason: string
  pattern: string
  dominant_pattern: string
}

// ── Punchy AI review types ────────────────────────────────────────

/** Confidence level for a Punchy observation or correction. */
export type PunchyConfidence = 'high' | 'medium' | 'low'

/**
 * Coerce an unknown value (typically a raw LLM string) to a valid
 * PunchyConfidence. Punchy's JSON is free-text at runtime — casting a
 * surprise value like "fair" to the union pollutes downstream UI logic
 * (colored pills, sort order) that assumes high/medium/low. Defaults to
 * 'medium' when the value isn't recognized.
 */
export function toPunchyConfidence(
  value: unknown,
  fallback: PunchyConfidence = 'medium',
): PunchyConfidence {
  return value === 'high' || value === 'medium' || value === 'low' ? value : fallback
}

/** A single observation from Punchy at a pipeline checkpoint. */
export interface PunchyObservation {
  checkpoint: 'column_mapping' | 'post_extraction' | 'quantity_check'
  message: string
  confidence: PunchyConfidence
  /** Field-level suggestions (e.g., unmapped column found elsewhere) */
  field_suggestions?: Array<{
    field: string
    suggestion: string
    column?: string
    pages?: string
    confidence: PunchyConfidence
  }>
}

/** Corrections returned by Punchy's post-extraction review (Checkpoint 2).
 *  Confidence fields are optional because LLM output is not guaranteed to include them. */
export interface PunchyCorrections {
  hardware_sets_corrections?: Array<{
    set_id: string
    heading?: string
    items_to_add?: ExtractedHardwareItem[]
    items_to_remove?: string[]
    items_to_fix?: Array<{
      name: string
      field: string
      old_value: string
      new_value: string
      confidence?: PunchyConfidence
    }>
  }>
  doors_corrections?: Array<{
    door_number: string
    field: string
    old_value: string
    new_value: string
    confidence?: PunchyConfidence
  }>
  missing_doors?: Array<DoorEntry & { confidence?: PunchyConfidence }>
  missing_sets?: Array<{
    set_id: string
    /** Optional parent/generic set id when Punchy detects a sub-variant. */
    generic_set_id?: string
    heading: string
    /** Openings assigned to this set in the heading block (if known). */
    heading_door_count?: number
    /** Total leaves across those openings (pairs count as 2). */
    heading_leaf_count?: number
    /** Quantity convention detected from preamble text. */
    qty_convention?: 'per_opening' | 'aggregate' | 'unknown'
    items: ExtractedHardwareItem[]
    confidence?: PunchyConfidence
  }>
  notes?: string
  overall_confidence?: PunchyConfidence
}

/** Column mapping review result from Punchy (Checkpoint 1). */
export interface PunchyColumnReview {
  unmapped_fields: Array<{
    field: string
    found_location: string
    confidence: PunchyConfidence
    suggestion: string
  }>
  mapping_issues: Array<{
    field: string
    issue: string
    confidence: PunchyConfidence
  }>
  notes?: string
}

/** Quantity sanity check result from Punchy (Checkpoint 3). */
export interface PunchyQuantityCheck {
  /** HIGH confidence corrections — safe to auto-apply. */
  auto_corrections?: Array<{
    set_id: string
    item_name: string
    from_qty: number
    to_qty: number
    reason: string
    confidence: 'high'
  }>
  /** MEDIUM confidence issues — need user input. */
  questions?: Array<{
    id: string
    set_id: string
    item_name: string
    text: string
    options: string[]
    current_qty: number
    context: string
  }>
  /** LOW confidence observations (backward-compat). */
  flags: Array<{
    set_id: string
    item_name: string
    current_qty?: number
    expected_qty?: number
    message: string
    reason?: string
    regulation?: string
    confidence?: PunchyConfidence
  }>
  /** Code/regulation compliance issues. */
  compliance_issues: Array<{
    set_id: string
    issue: string
    regulation: string
    severity: 'error' | 'warning' | 'info'
    confidence?: PunchyConfidence
  }>
  notes?: string
}

// ── Page classification ───────────────────────────────────────────

/** Classification of a single PDF page. */
export interface PageClassification {
  page_number: number
  page_type: 'door_schedule' | 'hardware_set' | 'hardware_sets' | 'reference' | 'cover' | 'other'
  confidence: number
  section_labels?: string[]
  hw_set_ids?: string[]
  has_door_numbers?: boolean
  is_scanned?: boolean
}
