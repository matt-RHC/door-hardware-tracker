import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { fetchProjectPdfBase64 } from '@/lib/pdf-storage'
import { assertProjectMember } from '@/lib/auth-helpers'
import { validateJson, errorResponse } from '@/lib/api-helpers/validate'
import { RegionExtractRequestSchema } from '@/lib/schemas/parse-pdf'

export const maxDuration = 120

/**
 * Upstream Python shape. Declared locally because the Python side returns a
 * pydantic `RegionExtractionResult` that we don't want to import across the
 * TS / Py boundary — the shape is intentionally narrow.
 *
 * Field mode adds `detected_field`, `detected_value`, `detection_confidence`,
 * and `sibling_fills` (populated when propagate=true) — all produced by the
 * shared Prompt 2 regexes so detection stays in one place.
 */
const PythonRegionResultSchema = z.object({
  success: z.boolean(),
  items: z
    .array(
      z.object({
        qty: z.number(),
        qty_source: z.string().optional(),
        name: z.string(),
        manufacturer: z.string(),
        model: z.string(),
        finish: z.string(),
      }),
    )
    .default([]),
  raw_text: z.string().default(''),
  detected_field: z.string().default(''),
  detected_value: z.string().default(''),
  detection_confidence: z.number().default(0),
  sibling_fills: z
    .record(
      z.string(),
      z.object({
        location: z.string().default(''),
        hand: z.string().default(''),
        fire_rating: z.string().default(''),
      }),
    )
    .default({}),
  error: z.string().default(''),
})
type PythonRegionResult = z.infer<typeof PythonRegionResultSchema>

/** Only these field names are writable by rescan — `door_number` is the
 *  primary key across the wizard's maps and must not be mutated via this
 *  path. `unknown` is surfaced so the UI can ask the user to pick manually. */
const ALLOWED_DETECTED_FIELDS = new Set([
  'hand',
  'location',
  'fire_rating',
  'unknown',
])

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return errorResponse('AUTH_REQUIRED', 'You must be signed in')
    }

    const parsed = await validateJson(request, RegionExtractRequestSchema)
    if (!parsed.ok) return parsed.response
    const {
      projectId,
      page,
      bbox,
      setId,
      mode,
      targetField,
      targetDoorNumbers,
      propagate,
    } = parsed.data

    try {
      await assertProjectMember(supabase, user.id, projectId)
    } catch {
      return errorResponse('ACCESS_DENIED', 'Access denied to this project')
    }

    // Fetch PDF from Supabase storage
    let pdfBase64: string
    try {
      pdfBase64 = await fetchProjectPdfBase64(projectId)
    } catch (err) {
      console.error('Failed to fetch PDF from storage:', err instanceof Error ? err.message : String(err))
      return errorResponse('INTERNAL_ERROR', 'Failed to fetch PDF from storage')
    }

    // Call Python endpoint with bbox + target_page
    // Use || not ?? — see classify-pages/route.ts for the explanation.
    const requestOrigin = new URL(request.url).origin
    const baseUrl = process.env.PYTHON_API_URL
      || (requestOrigin && requestOrigin !== 'null' ? requestOrigin : null)
      || process.env.NEXT_PUBLIC_APP_URL
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 120_000)

    const internalToken = process.env.PYTHON_INTERNAL_SECRET ?? ''

    try {
      const resolvedMode = mode ?? 'items'
      const response = await fetch(`${baseUrl}/api/extract-tables`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(internalToken ? { 'X-Internal-Token': internalToken } : {}),
        },
        body: JSON.stringify({
          pdf_base64: pdfBase64,
          target_page: page,
          bbox: { x0: bbox.x0, y0: bbox.y0, x1: bbox.x1, y1: bbox.y1 },
          mode: resolvedMode,
          propagate: resolvedMode === 'field' ? Boolean(propagate) : false,
          target_door_numbers: targetDoorNumbers ?? [],
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const rawText = await response.text()
        console.error('[region-extract] Python error:', response.status, rawText.slice(0, 500))
        return errorResponse('UPSTREAM_ERROR', `Region extraction failed: ${response.status}`)
      }

      const rawJson = (await response.json()) as unknown
      const pythonParsed = PythonRegionResultSchema.safeParse(rawJson)
      if (!pythonParsed.success) {
        console.error('[region-extract] Bad Python response shape:', pythonParsed.error.issues.slice(0, 5))
        return errorResponse('UPSTREAM_ERROR', 'Region extraction returned an unexpected shape')
      }
      const result: PythonRegionResult = pythonParsed.data

      // ── Field mode: forward server detection directly. No TS-side
      //    classification — the Python side ran _HEADING_DOOR_HAND_RE,
      //    _FIRE_RATING_RE, and parse_heading_door_metadata for us.
      if (resolvedMode === 'field') {
        const detectedField = ALLOWED_DETECTED_FIELDS.has(result.detected_field)
          ? (result.detected_field as 'hand' | 'location' | 'fire_rating' | 'unknown')
          : 'unknown'

        return NextResponse.json({
          mode: 'field',
          setId,
          rawText: result.raw_text,
          detectedField,
          detectedValue: result.detected_value,
          detectionConfidence: result.detection_confidence,
          targetField: targetField ?? null,
          targetDoorNumbers: targetDoorNumbers ?? [],
          siblingFills: result.sibling_fills,
        })
      }

      if (!result.success) {
        return NextResponse.json({
          items: [],
          setId,
          raw_text: result.raw_text,
          error: result.error || 'No items found in selected region',
        })
      }

      // Map items, setting qty_source to 'region_extract'
      const items = result.items.map(item => ({
        qty: item.qty ?? 1,
        name: item.name ?? '',
        manufacturer: item.manufacturer ?? '',
        model: item.model ?? '',
        finish: item.finish ?? '',
        qty_source: 'region_extract',
      }))

      console.debug(`[region-extract] setId=${setId}, page=${page}, items=${items.length}`)

      return NextResponse.json({ items, setId, raw_text: result.raw_text })
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    console.error('Region extract error:', error)
    const message = error instanceof Error ? error.message : 'Region extraction failed'
    return errorResponse('INTERNAL_ERROR', message)
  }
}
