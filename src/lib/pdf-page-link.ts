/**
 * Helper for opening the project's submittal PDF at a specific page.
 *
 * Fetches a short-lived signed URL from /api/projects/[projectId]/pdf-url
 * and opens `${signedUrl}#page={pageIndex + 1}` in a new browser tab. The
 * browser's built-in PDF viewer (and PDF.js) both honor the #page=N
 * fragment, so no client-side rendering is needed.
 *
 * Used by:
 * - Door detail page (the "View PDF page N" hero-card button)
 * - Project dashboard opening card (the small PDF icon button)
 */

export type PdfPageLinkResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Open the project's submittal PDF in a new tab, jumped to the given
 * 0-based page index. Returns an outcome so callers can surface failures
 * via toast.
 *
 * @param projectId  The project UUID.
 * @param pageIndex  0-based page index (matches openings.pdf_page). The
 *                   browser-facing #page fragment is 1-based, so this
 *                   function converts internally.
 */
export async function openProjectPdfAtPage(
  projectId: string,
  pageIndex: number,
): Promise<PdfPageLinkResult> {
  try {
    const resp = await fetch(`/api/projects/${projectId}/pdf-url`)
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}))
      return {
        ok: false,
        error: body?.error ?? `Could not load PDF (HTTP ${resp.status})`,
      }
    }
    const data = (await resp.json()) as { url?: string }
    if (!data.url) {
      return { ok: false, error: 'Server did not return a PDF URL' }
    }
    const pageNumber = Math.max(1, pageIndex + 1)
    const href = `${data.url}#page=${pageNumber}`
    // Open in a new tab — browsers handle #page for their built-in PDF viewer.
    window.open(href, '_blank', 'noopener,noreferrer')
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
