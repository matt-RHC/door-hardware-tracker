import { z } from 'zod'
import { UuidSchema } from './common'

/**
 * Shape of a product variant stored in the `variants` JSONB column.
 * Mirrors `ProductVariant` in src/lib/product-dedup.ts.
 */
export const ProductVariantSchema = z.object({
  model: z.string(),
  normalizedModel: z.string(),
  name: z.string(),
  finish: z.string(),
  occurrences: z.number().int().nonnegative(),
  setIds: z.array(z.string()),
})
export type ProductVariant = z.infer<typeof ProductVariantSchema>

/**
 * A product family row as returned by the API (includes server fields).
 */
export const ProductFamilyRowSchema = z.object({
  id: UuidSchema,
  project_id: UuidSchema,
  manufacturer: z.string(),
  base_series: z.string(),
  canonical_model: z.string(),
  category: z.string().nullable(),
  variants: z.array(ProductVariantSchema),
  created_by: UuidSchema.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type ProductFamilyRow = z.infer<typeof ProductFamilyRowSchema>

/**
 * Request body for POST — upserts one family by (project_id, manufacturer, base_series).
 */
export const ProductFamilyUpsertRequestSchema = z.object({
  manufacturer: z.string().min(1),
  base_series: z.string().min(1),
  canonical_model: z.string().min(1),
  category: z.string().nullish(),
  variants: z.array(ProductVariantSchema).default([]),
})
export type ProductFamilyUpsertRequest = z.infer<typeof ProductFamilyUpsertRequestSchema>

/**
 * Request body for PATCH — partial update.
 */
export const ProductFamilyPatchRequestSchema = z
  .object({
    canonical_model: z.string().min(1).optional(),
    category: z.string().nullish(),
    variants: z.array(ProductVariantSchema).optional(),
  })
  .refine((val) => Object.keys(val).length > 0, {
    message: 'At least one field must be provided',
  })
export type ProductFamilyPatchRequest = z.infer<typeof ProductFamilyPatchRequestSchema>
