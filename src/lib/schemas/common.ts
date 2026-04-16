import { z } from 'zod'

export const ApiErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'AUTH_REQUIRED',
  'ACCESS_DENIED',
  'NOT_FOUND',
  'CONFLICT',
  'UPSTREAM_ERROR',
  'INTERNAL_ERROR',
])
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>

export const ApiErrorSchema = z.object({
  error: z.string(),
  code: ApiErrorCodeSchema,
  details: z.unknown().optional(),
})
export type ApiError = z.infer<typeof ApiErrorSchema>

export const UuidSchema = z.string().uuid()

export const Base64Schema = z
  .string()
  .min(1)
  .refine((s) => /^[A-Za-z0-9+/=\s]+$/.test(s), {
    message: 'Must be a base64-encoded string',
  })
