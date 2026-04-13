/**
 * Types for the reconciliation engine (Nuclear Option Phase C).
 *
 * The reconciliation engine merges results from two independent extraction
 * strategies — Strategy A (pdfplumber + regex) and Strategy B (vision model) —
 * using voting/agreement to produce a single high-confidence output with
 * per-field audit trails.
 */

// ── Agreement levels ────────────────────────────────────────────

export type AgreementLevel = 'full' | 'majority' | 'conflict' | 'single_source'

// ── Field-level reconciliation ──────────────────────────────────

export interface FieldReconciliation {
  /** The chosen/winning value */
  value: string | number
  /** Agreement level between strategies */
  confidence: AgreementLevel
  /** Raw values from each strategy */
  sources: {
    strategy_a?: string | number
    strategy_b?: string | number
  }
  /** Which strategy the winning value came from */
  chosen_from: 'a' | 'b' | 'agreed'
  /** Human-readable explanation of the reconciliation decision */
  reason: string
}

// ── Item-level reconciliation ───────────────────────────────────

export interface ReconciledItem {
  name: FieldReconciliation
  qty: FieldReconciliation
  manufacturer: FieldReconciliation
  model: FieldReconciliation
  finish: FieldReconciliation
  category: string
  /** Worst confidence across all fields */
  overall_confidence: AgreementLevel
}

// ── Set-level reconciliation ────────────────────────────────────

export interface ReconciledHardwareSet {
  set_id: string
  heading: FieldReconciliation
  items: ReconciledItem[]
  /** Reconciled door number assignments */
  door_numbers: FieldReconciliation
  qty_convention: FieldReconciliation
  is_pair: FieldReconciliation
  /** Worst confidence across heading, items, and set-level fields */
  overall_confidence: AgreementLevel
}

// ── Top-level result ────────────────────────────────────────────

export interface ReconciliationResult {
  hardware_sets: ReconciledHardwareSet[]
  summary: {
    total_sets: number
    total_items: number
    /** Percentage of fields where both strategies agreed */
    full_agreement_pct: number
    /** Number of fields where strategies disagreed */
    conflicts: number
    /** Number of fields only one strategy could extract */
    single_source_fields: number
    /** Overall confidence level */
    overall_confidence: AgreementLevel
    /** 0-100 numeric score */
    score: number
  }
  /** Human-readable log of reconciliation decisions */
  audit_log: string[]
}
