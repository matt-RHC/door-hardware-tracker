import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { fetchProjectPdfBase64 } from '@/lib/pdf-storage'

export const maxDuration = 120

interface RegionExtractRequest {
  projectId: string
  page: number // 0-based page index
  bbox: {
    x0: number // 0-1 percentage from left
    y0: number // 0-1 percentage from top
    x1: number // 0-1 percentage from left
    y1: number // 0-1 percentage from top
  }
  setId: string
}

interface PythonRegionResult {
  success: boolean
  items: Array<{
    qty: number
    qty_source?: string
    name: string
    manufacturer: string
    model: string
    finish: string
  }>
  raw_text?: string
  error: string
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
    }

    const body = (await request.json()) as RegionExtractRequest
    const { projectId, page, bbox, setId } = body

    if (!projectId) {
      return NextResponse.json({ error: 'Missing projectId' }, { status: 400 })
    }
    if (page == null || page < 0) {
      return NextResponse.json({ error: 'Invalid page number' }, { status: 400 })
    }
    if (!bbox || bbox.x0 == null || bbox.y0 == null || bbox.x1 == null || bbox.y1 == null) {
      return NextResponse.json({ error: 'Missing or invalid bbox' }, { status: 400 })
    }

    // Fetch PDF from Supabase storage
    let pdfBase64: string
    try {
      pdfBase64 = await fetchProjectPdfBase64(projectId)
    } catch (err) {
      console.error('Failed to fetch PDF from storage:', err instanceof Error ? err.message : String(err))
      return NextResponse.json({ error: 'Failed to fetch PDF from storage' }, { status: 500 })
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
      const response = await fetch(`${baseUrl}/api/extract-tables`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(internalToken ? { 'X-Internal-Token': internalToken } : {}),
        },
        body: JSON.stringify({
          pdf_base64: pdfBase64,
          target_page: page,
          bbox: {
            x0: bbox.x0,
            y0: bbox.y0,
            x1: bbox.x1,
            y1: bbox.y1,
          },
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const rawText = await response.text()
        console.error('[region-extract] Python error:', response.status, rawText.slice(0, 500))
        return NextResponse.json(
          { error: `Region extraction failed: ${response.status}` },
          { status: 502 },
        )
      }

      const result: PythonRegionResult = await response.json()

      if (!result.success) {
        return NextResponse.json({
          items: [],
          setId,
          raw_text: result.raw_text || '',
          error: result.error ?? 'No items found in selected region',
        })
      }

      // Map items, setting qty_source to 'region_extract'
      const items = (result.items ?? []).map(item => ({
        qty: item.qty ?? 1,
        name: item.name ?? '',
        manufacturer: item.manufacturer ?? '',
        model: item.model ?? '',
        finish: item.finish ?? '',
        qty_source: 'region_extract',
      }))

      console.debug(`[region-extract] setId=${setId}, page=${page}, items=${items.length}`)

      return NextResponse.json({ items, setId, raw_text: result.raw_text || '' })
    } finally {
      clearTimeout(timeout)
    }
  } catch (error) {
    console.error('Region extract error:', error)
    const message = error instanceof Error ? error.message : 'Region extraction failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
