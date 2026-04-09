/**
 * Canonical domain types for parsed PDF data.
 *
 * These represent data extracted from hardware submittal PDFs — NOT database
 * rows. For database row types, import from '@/lib/types/database'.
 */

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
}

/** A single hardware item within a hardware set. */
export interface ExtractedHardwareItem {
  qty: number
  qty_total?: number
  qty_door_count?: number
  qty_source?: string
  name: string
  model: string
  finish: string
  manufacturer: string
}

/** A hardware set grouping items for a set of doors. */
export interface HardwareSet {
  set_id: string
  generic_set_id?: string
  heading: string
  heading_door_count?: number
  heading_leaf_count?: number
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
    heading: string
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
