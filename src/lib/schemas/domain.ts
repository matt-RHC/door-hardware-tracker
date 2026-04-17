import { z } from 'zod'

// ── Confidence ─────────────────────────────────────────────────────

export const ConfidenceLevelSchema = z.enum(['high', 'medium', 'low', 'unverified'])

export const FieldConfidenceSchema = z.object({
  level: ConfidenceLevelSchema,
  reason: z.string(),
})

export const ItemConfidenceSchema = z.object({
  name: FieldConfidenceSchema,
  qty: FieldConfidenceSchema,
  manufacturer: FieldConfidenceSchema,
  model: FieldConfidenceSchema,
  finish: FieldConfidenceSchema,
  overall: ConfidenceLevelSchema,
})

export const ExtractionConfidenceSchema = z.object({
  overall: ConfidenceLevelSchema,
  score: z.number(),
  signals: z.array(z.string()),
  item_confidence: z.record(z.string(), ItemConfidenceSchema),
  suggest_deep_extraction: z.boolean(),
  deep_extraction_reasons: z.array(z.string()),
})

// ── Darrin ─────────────────────────────────────────────────────────

export const DarrinConfidenceSchema = z.enum(['high', 'medium', 'low'])

export const DarrinObservationSchema = z.object({
  checkpoint: z.enum(['column_mapping', 'post_extraction', 'quantity_check']),
  message: z.string(),
  confidence: DarrinConfidenceSchema,
  field_suggestions: z
    .array(
      z.object({
        field: z.string(),
        suggestion: z.string(),
        column: z.string().optional(),
        pages: z.string().optional(),
        confidence: DarrinConfidenceSchema,
      }),
    )
    .optional(),
})

// ── Core domain ────────────────────────────────────────────────────

export const DoorEntrySchema = z.object({
  door_number: z.string(),
  hw_set: z.string(),
  hw_heading: z.string().optional(),
  location: z.string(),
  door_type: z.string(),
  frame_type: z.string(),
  fire_rating: z.string(),
  hand: z.string(),
  field_confidence: z.record(z.string(), z.number()).optional(),
  by_others: z.boolean().optional(),
  leaf_count: z.number().optional(),
})

export const ExtractedHardwareItemSchema = z.object({
  qty: z.number(),
  qty_total: z.number().optional(),
  qty_door_count: z.number().optional(),
  qty_source: z.string().optional(),
  qty_before_correction: z.number().optional(),
  name: z.string(),
  model: z.string(),
  finish: z.string(),
  manufacturer: z.string(),
  base_series: z.string().optional(),
  confidence: ItemConfidenceSchema.optional(),
})

export const HardwareSetSchema = z.object({
  set_id: z.string(),
  generic_set_id: z.string().optional(),
  heading: z.string(),
  heading_door_count: z.number().optional(),
  heading_leaf_count: z.number().optional(),
  heading_doors: z.array(z.string()).optional(),
  qty_convention: z.enum(['per_opening', 'aggregate', 'unknown']).optional(),
  pdf_page: z.number().nullable().optional(),
  items: z.array(ExtractedHardwareItemSchema),
})

// ── Quantity check ─────────────────────────────────────────────────

export const DarrinQuantityCheckSchema = z.object({
  auto_corrections: z
    .array(
      z.object({
        set_id: z.string(),
        item_name: z.string(),
        from_qty: z.number(),
        to_qty: z.number(),
        reason: z.string(),
        confidence: z.literal('high'),
      }),
    )
    .optional(),
  questions: z
    .array(
      z.object({
        id: z.string(),
        set_id: z.string(),
        item_name: z.string(),
        text: z.string(),
        options: z.array(z.string()),
        current_qty: z.number(),
        context: z.string(),
      }),
    )
    .optional(),
  flags: z.array(
    z.object({
      set_id: z.string(),
      item_name: z.string(),
      current_qty: z.number().optional(),
      expected_qty: z.number().optional(),
      message: z.string(),
      reason: z.string().optional(),
      regulation: z.string().optional(),
      confidence: DarrinConfidenceSchema.optional(),
    }),
  ),
  compliance_issues: z.array(
    z.object({
      set_id: z.string(),
      issue: z.string(),
      regulation: z.string(),
      severity: z.enum(['error', 'warning', 'info']),
      confidence: DarrinConfidenceSchema.optional(),
    }),
  ),
  notes: z.string().optional(),
})

// ── Reconciliation ─────────────────────────────────────────────────

export const AgreementLevelSchema = z.enum([
  'full',
  'majority',
  'conflict',
  'single_source',
])

export const FieldReconciliationSchema = z.object({
  value: z.union([z.string(), z.number()]),
  confidence: AgreementLevelSchema,
  sources: z.object({
    strategy_a: z.union([z.string(), z.number()]).optional(),
    strategy_b: z.union([z.string(), z.number()]).optional(),
  }),
  chosen_from: z.enum(['a', 'b', 'agreed', 'merged']),
  reason: z.string(),
})

export const ReconciledItemSchema = z.object({
  name: FieldReconciliationSchema,
  qty: FieldReconciliationSchema,
  manufacturer: FieldReconciliationSchema,
  model: FieldReconciliationSchema,
  finish: FieldReconciliationSchema,
  category: z.string(),
  overall_confidence: AgreementLevelSchema,
})

export const ReconciledHardwareSetSchema = z.object({
  set_id: z.string(),
  heading: FieldReconciliationSchema,
  items: z.array(ReconciledItemSchema),
  door_numbers: FieldReconciliationSchema,
  qty_convention: FieldReconciliationSchema,
  is_pair: FieldReconciliationSchema,
  overall_confidence: AgreementLevelSchema,
})

export const ReconciliationResultSchema = z.object({
  hardware_sets: z.array(ReconciledHardwareSetSchema),
  summary: z.object({
    total_sets: z.number(),
    total_items: z.number(),
    full_agreement_pct: z.number(),
    conflicts: z.number(),
    single_source_fields: z.number(),
    overall_confidence: AgreementLevelSchema,
    score: z.number(),
  }),
  audit_log: z.array(z.string()),
})

// ── Page classification ────────────────────────────────────────────

export const PageClassificationSchema = z.object({
  page_number: z.number(),
  page_type: z.enum([
    'door_schedule',
    'hardware_set',
    'hardware_sets',
    'reference',
    'cover',
    'other',
  ]),
  confidence: z.number(),
  section_labels: z.array(z.string()).optional(),
  hw_set_ids: z.array(z.string()).optional(),
  has_door_numbers: z.boolean().optional(),
  is_scanned: z.boolean().optional(),
})

// ── Inferred types (re-export for convenience) ────────────────────

export type DoorEntry = z.infer<typeof DoorEntrySchema>
export type HardwareSet = z.infer<typeof HardwareSetSchema>
export type ExtractedHardwareItem = z.infer<typeof ExtractedHardwareItemSchema>
export type ItemConfidence = z.infer<typeof ItemConfidenceSchema>
export type ExtractionConfidence = z.infer<typeof ExtractionConfidenceSchema>
