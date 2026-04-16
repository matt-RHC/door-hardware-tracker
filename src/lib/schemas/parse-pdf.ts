import { z } from 'zod'
import { UuidSchema } from './common'
import {
  DoorEntrySchema,
  HardwareSetSchema,
  ExtractedHardwareItemSchema,
} from './domain'

// ── Shared golden-sample shape ─────────────────────────────────────

export const GoldenSampleSchema = z.object({
  set_id: z.string(),
  items: z.array(
    z.object({
      qty: z.number(),
      name: z.string(),
      manufacturer: z.string().optional(),
      model: z.string().optional(),
      finish: z.string().optional(),
    }),
  ),
})

// ── POST /api/parse-pdf ────────────────────────────────────────────

/**
 * Either pdfBase64 or projectId must be supplied — the route falls back to
 * storage when pdfBase64 is absent. The route enforces this imperatively
 * because one-of-required is awkward to express inline and the route
 * produces a specific error message.
 */
export const ParsePdfRequestSchema = z.object({
  pdfBase64: z.string().optional(),
  filteredPdfBase64: z.string().optional(),
  userColumnMapping: z.record(z.string(), z.number()).nullable().optional(),
  projectId: UuidSchema.optional(),
  goldenSample: GoldenSampleSchema.optional(),
})
export type ParsePdfRequest = z.infer<typeof ParsePdfRequestSchema>

// ── POST /api/parse-pdf/save and /api/parse-pdf/compare ────────────

/**
 * save and compare share the same request shape: projectId + the wizard's
 * in-memory doors and hardware sets. Both require at least one door.
 */
export const ParsePdfSaveRequestSchema = z.object({
  projectId: UuidSchema,
  hardwareSets: z.array(HardwareSetSchema),
  doors: z.array(DoorEntrySchema).min(1, 'At least one door is required'),
})
export type ParsePdfSaveRequest = z.infer<typeof ParsePdfSaveRequestSchema>

export const ParsePdfCompareRequestSchema = ParsePdfSaveRequestSchema
export type ParsePdfCompareRequest = ParsePdfSaveRequest

// ── Python pipeline response (callPdfplumber) ──────────────────────

/**
 * Loose schema for the Python /api/extract-tables response. Values are
 * validated structurally but remain permissive for optional extensions the
 * Python service may add. The route uses this to replace the existing
 * `as any` cast in parse-pdf-helpers.ts.
 */
export const PdfplumberResultSchema = z.object({
  hardware_sets: z.array(HardwareSetSchema),
  openings: z.array(DoorEntrySchema).optional(),
  reference_codes: z.array(z.unknown()).optional(),
  flagged_doors: z.array(z.unknown()).optional(),
  tables_found: z.number().optional(),
  hw_sets_found: z.number().optional(),
  method: z.string().optional(),
  error: z.string().optional(),
}).passthrough()
export type PdfplumberResult = z.infer<typeof PdfplumberResultSchema>

// ── Region extract request ─────────────────────────────────────────

/** Used by InlineRescan → POST /api/parse-pdf/region-extract. */
export const RegionExtractRequestSchema = z.object({
  projectId: UuidSchema,
  setId: z.string(),
  page: z.number().int().nonnegative(),
  bbox: z.object({
    x0: z.number(),
    y0: z.number(),
    x1: z.number(),
    y1: z.number(),
  }),
})
export type RegionExtractRequest = z.infer<typeof RegionExtractRequestSchema>

/** Region extract response — the route returns `items` matching the item shape. */
export const RegionExtractResponseSchema = z.object({
  items: z.array(ExtractedHardwareItemSchema),
})
export type RegionExtractResponse = z.infer<typeof RegionExtractResponseSchema>
