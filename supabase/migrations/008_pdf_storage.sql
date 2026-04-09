-- Migration 008: PDF Storage
-- Adds PDF storage path + page count to projects table.
-- Creates private 'submittals' storage bucket for uploaded PDFs.
-- Hash and uploaded_at already exist from migration 005.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS pdf_storage_path TEXT,
  ADD COLUMN IF NOT EXISTS pdf_page_count INTEGER;

COMMENT ON COLUMN projects.pdf_storage_path IS 'Supabase Storage path for the most recently uploaded submittal PDF';
COMMENT ON COLUMN projects.pdf_page_count IS 'Total page count of the most recently uploaded submittal PDF';

-- Create submittals storage bucket (PRIVATE — use signed URLs, not public)
INSERT INTO storage.buckets (id, name, public)
VALUES ('submittals', 'submittals', false)
ON CONFLICT (id) DO NOTHING;

-- RLS: Only authenticated users can upload submittals
CREATE POLICY "Authenticated users can upload submittals"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'submittals' AND auth.role() = 'authenticated');

-- RLS: Only authenticated users can read submittals (via signed URLs)
CREATE POLICY "Authenticated users can read submittals"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'submittals' AND auth.role() = 'authenticated');

-- RLS: Only authenticated users can delete submittals
CREATE POLICY "Authenticated users can delete submittals"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'submittals' AND auth.role() = 'authenticated');
