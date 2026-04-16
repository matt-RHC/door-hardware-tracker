import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { fetchProjectPdfBase64 } from '@/lib/pdf-storage'
import { assertProjectMember } from '@/lib/auth-helpers'
import {
  callVisionExtraction,
  filterSchedulePages,
  createAnthropicClient,
} from '@/lib/parse-pdf-helpers'
import type { PageClassification } from '@/lib/types'

// Vision extraction is slow — allow 5 minutes
export const maxDuration = 300

function getPythonApiBaseUrl(): string {
  return process.env.PYTHON_API_URL
    || process.env.NEXT_PUBLIC_APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
}

async function callClassifyPages(pdfBase64: string): Promise<{ pages: PageClassification[] }> {
  const baseUrl = getPythonApiBaseUrl()
  const internalToken = process.env.PYTHON_INTERNAL_SECRET ?? ''
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)

  try {
    const response = await fetch(`${baseUrl}/api/classify-pages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(internalToken ? { 'X-Internal-Token': internalToken } : {}),
      },
      body: JSON.stringify({ pdf_base64: pdfBase64 }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`classify-pages failed (${response.status}): ${text.slice(0, 200)}`)
    }

    return await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
    }

    const body = await request.json()
    const { projectId, pageNumbers: requestedPages } = body as {
      projectId?: string
      pageNumbers?: number[]
      pdfBase64?: string
    }

    // Enforce project membership when projectId is provided (IDOR prevention)
    if (projectId) {
      try {
        await assertProjectMember(supabase, user.id, projectId)
      } catch {
        return NextResponse.json({ error: 'Access denied to this project' }, { status: 403 })
      }
    }

    // Resolve PDF
    let pdfBase64: string = body.pdfBase64 ?? ''
    if (!pdfBase64 && projectId) {
      try {
        pdfBase64 = await fetchProjectPdfBase64(projectId)
      } catch (err) {
        console.error('[vision-extract] Failed to fetch PDF:', err instanceof Error ? err.message : String(err))
      }
    }
    if (!pdfBase64) {
      return NextResponse.json({ error: 'Missing pdfBase64 or projectId' }, { status: 400 })
    }

    // Determine which pages to process
    let pageNumbers: number[]
    let skippedCount = 0

    if (requestedPages && requestedPages.length > 0) {
      pageNumbers = requestedPages
    } else {
      // Classify pages to find schedule pages
      const classifyResult = await callClassifyPages(pdfBase64)
      const pages: PageClassification[] = classifyResult.pages ?? []
      const { schedulePages, skippedPages } = filterSchedulePages(pages)
      pageNumbers = schedulePages
      skippedCount = skippedPages.length

      if (pageNumbers.length === 0) {
        return NextResponse.json({
          error: 'No schedule pages found in PDF',
          pages_classified: pages.length,
        }, { status: 422 })
      }
    }

    const client = createAnthropicClient()

    const result = await callVisionExtraction(client, pdfBase64, pageNumbers, {
      projectId,
    })

    result.pages_skipped = skippedCount

    console.debug(
      `[vision-extract] Processed ${result.pages_processed} pages, ` +
      `found ${result.hardware_sets.length} sets, ` +
      `skipped ${skippedCount} non-schedule pages, ` +
      `took ${result.total_processing_time_ms}ms`,
    )

    return NextResponse.json(result)
  } catch (error) {
    console.error('[vision-extract] Error:', error)
    const message = error instanceof Error ? error.message : 'Vision extraction failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
