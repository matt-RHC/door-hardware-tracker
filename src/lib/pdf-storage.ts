/**
 * PDF Storage helpers.
 *
 * Upload submittal PDFs to Supabase Storage and fetch them server-side.
 * Uses the 'submittals' bucket (private — signed URLs only).
 * Runtime fallback creates the bucket if migration 008 hasn't been applied.
 */

import { createAdminSupabaseClient } from '@/lib/supabase/server'

const BUCKET = 'submittals'

/**
 * Ensure the submittals bucket exists (runtime fallback for environments
 * where migration 008 hasn't run yet).
 */
async function ensureBucket(): Promise<void> {
  const supabase = createAdminSupabaseClient()
  const { data: buckets } = await supabase.storage.listBuckets()
  const exists = (buckets ?? []).some(b => b.id === BUCKET)
  if (!exists) {
    await supabase.storage.createBucket(BUCKET, { public: false })
  }
}

/**
 * Compute SHA-256 hex digest of a buffer.
 */
async function sha256(buffer: ArrayBuffer): Promise<string> {
  const crypto = await import('crypto')
  return crypto.createHash('sha256').update(Buffer.from(buffer)).digest('hex')
}

/**
 * Upload a PDF to Supabase Storage for a project.
 *
 * - Computes SHA-256 hash for dedup (skips upload if hash matches projects.last_pdf_hash)
 * - Stores at submittals/{projectId}/{hash}.pdf
 * - Updates projects row with storage path, hash, page count, timestamp
 *
 * @returns { storagePath, hash, isDuplicate }
 */
export async function uploadProjectPdf(
  projectId: string,
  fileBuffer: ArrayBuffer,
  pageCount: number,
): Promise<{ storagePath: string; hash: string; isDuplicate: boolean }> {
  const supabase = createAdminSupabaseClient()

  // Compute hash
  const hash = await sha256(fileBuffer)

  // Check for duplicate
  const { data: projectRow } = await supabase
    .from('projects')
    .select('last_pdf_hash, pdf_storage_path')
    .eq('id', projectId)
    .single()

  const existingHash = (projectRow as Record<string, unknown> | null)?.last_pdf_hash as string | null
  const existingPath = (projectRow as Record<string, unknown> | null)?.pdf_storage_path as string | null
  if (existingHash === hash && existingPath) {
    return { storagePath: existingPath, hash, isDuplicate: true }
  }

  // Ensure bucket exists
  await ensureBucket()

  // Upload
  const storagePath = `${projectId}/${hash}.pdf`
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, fileBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    })

  if (uploadError) {
    throw new Error(`PDF upload failed: ${uploadError.message}`)
  }

  // Update project record
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updateError } = await (supabase.from('projects') as any)
    .update({
      pdf_storage_path: storagePath,
      last_pdf_hash: hash,
      pdf_page_count: pageCount,
      last_pdf_uploaded_at: new Date().toISOString(),
    })
    .eq('id', projectId)

  if (updateError) {
    console.error('Failed to update project PDF metadata:', updateError)
  }

  return { storagePath, hash, isDuplicate: false }
}

/**
 * Fetch a project's PDF from Supabase Storage as a Buffer.
 * Looks up the storage path from the projects table.
 */
export async function fetchProjectPdf(projectId: string): Promise<Buffer> {
  const supabase = createAdminSupabaseClient()

  const { data: projectRow, error: projectError } = await supabase
    .from('projects')
    .select('pdf_storage_path')
    .eq('id', projectId)
    .single()

  const storagePath = (projectRow as Record<string, unknown> | null)?.pdf_storage_path as string | null
  if (projectError || !storagePath) {
    throw new Error(`No PDF stored for project ${projectId}`)
  }

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .download(storagePath)

  if (error || !data) {
    throw new Error(`PDF download failed: ${error?.message ?? 'no data'}`)
  }

  return Buffer.from(await data.arrayBuffer())
}

/**
 * Fetch a project's PDF from Supabase Storage as a base64 string.
 * Convenience wrapper for API routes that need base64.
 */
export async function fetchProjectPdfBase64(projectId: string): Promise<string> {
  const buf = await fetchProjectPdf(projectId)
  return buf.toString('base64')
}
