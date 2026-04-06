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
export interface HardwareItem {
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
  items: HardwareItem[]
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

// ── Page classification ───────────────────────────────────────────

/** Classification of a single PDF page. */
export interface PageClassification {
  page_number: number
  page_type: 'door_schedule' | 'hardware_sets' | 'reference' | 'cover' | 'other'
  confidence: number
}
