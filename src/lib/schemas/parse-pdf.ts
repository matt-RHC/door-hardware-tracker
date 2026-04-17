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

/**
 * Used by InlineRescan → POST /api/parse-pdf/region-extract.
 *
 * `mode: 'items'` (default) — legacy path: extract hardware items from a
 * table region. Returns an `items[]` response.
 *
 * `mode: 'field'` — extract raw text from the region and return it along
 * with auto-detected field classification (location/hand/fire_rating/...).
 * Used when the user rescans to fill in missing per-door metadata.
 * `targetField` and `targetDoorNumbers` are advisory — they let the UI
 * round-trip caller intent back to itself so the response includes enough
 * context to stage the next UI step (field assignment) without relying on
 * component-local state.
 */
export const RegionExtractModeSchema = z.enum(['items', 'field'])
export type RegionExtractMode = z.infer<typeof RegionExtractModeSchema>

/**
 * Field kinds the rescan flow can reference.
 *
 * `door_number` is here for TYPE completeness — the Python detector
 * (_detect_field_from_text) never returns it because door numbers are
 * the primary key across the wizard's maps and must not be mutated via
 * rescan. The API route narrows it out of detection responses
 * (ALLOWED_DETECTED_FIELDS in region-extract/route.ts), and
 * applyFieldToDoors / applyPropagationSuggestions silently drop it.
 * It stays in the enum so diagnostic callers have a named value for
 * it instead of a magic string.
 */
export const RegionExtractFieldSchema = z.enum([
  'location',
  'hand',
  'fire_rating',
  'door_number',
])
export type RegionExtractField = z.infer<typeof RegionExtractFieldSchema>

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
  mode: RegionExtractModeSchema.optional(),
  targetField: RegionExtractFieldSchema.optional(),
  targetDoorNumbers: z.array(z.string()).optional(),
  /**
   * Field-mode only. When true AND targetDoorNumbers is non-empty, the
   * server additionally re-runs the shared heading-page parser on the
   * target page and returns `siblingFills` for each requested door it
   * could resolve. The UI then filters to still-missing siblings and
   * offers them for confirmation — the Darrin propagation flow.
   *
   * Server-side ignored when mode !== 'field'.
   */
  propagate: z.boolean().optional(),
})
export type RegionExtractRequest = z.infer<typeof RegionExtractRequestSchema>

/** Region extract response (items mode) — the route returns `items` matching the item shape. */
export const RegionExtractResponseSchema = z.object({
  items: z.array(ExtractedHardwareItemSchema),
})
export type RegionExtractResponse = z.infer<typeof RegionExtractResponseSchema>

/**
 * Region extract response (field mode).
 *
 * `detectedField` is narrowed to the writable set (`door_number` is never
 * returned because the server treats it as read-only — see
 * ALLOWED_DETECTED_FIELDS in region-extract/route.ts).
 *
 * `siblingFills` is populated only when the request passed
 * `propagate: true` AND server-side parsing found matches for the
 * requested door numbers. Each entry carries the three propagatable
 * fields (empty strings for missing ones).
 */
export const RegionExtractFieldResponseSchema = z.object({
  mode: z.literal('field'),
  setId: z.string(),
  rawText: z.string(),
  detectedField: z.enum(['location', 'hand', 'fire_rating', 'unknown']),
  detectedValue: z.string(),
  detectionConfidence: z.number(),
  targetField: RegionExtractFieldSchema.nullable(),
  targetDoorNumbers: z.array(z.string()),
  siblingFills: z.record(
    z.string(),
    z.object({
      location: z.string(),
      hand: z.string(),
      fire_rating: z.string(),
    }),
  ).default({}),
})
export type RegionExtractFieldResponse = z.infer<typeof RegionExtractFieldResponseSchema>
