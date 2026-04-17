-- Migration 017: Make attachments bucket private and enforce mime/size limits
--
-- Finding #8: attachments bucket was public=true with no mime type restrictions
-- and no file size limit. Any URL under the bucket was publicly readable without
-- authentication, and any authenticated user could upload any file type/size.
--
-- Changes:
--   - Set bucket to public=false (files require signed URLs to access)
--   - Restrict allowed_mime_types to images and PDFs only
--   - Set file_size_limit to 20MB (20 * 1024 * 1024 bytes)
--
-- NOTE: Existing file_url values stored in the attachments table are public URLs
-- (format: .../storage/v1/object/public/attachments/...). After this migration,
-- those URLs will return 403. The application has been updated to generate
-- signed URLs at read time via the attachments API route instead.
-- Existing URLs in the database are kept as storage paths for the transition
-- (handled by the application layer — see attachments/route.ts).

UPDATE storage.buckets
SET
  public = false,
  file_size_limit = 20971520,  -- 20MB in bytes
  allowed_mime_types = ARRAY[
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'application/pdf'
  ]
WHERE id = 'attachments';
