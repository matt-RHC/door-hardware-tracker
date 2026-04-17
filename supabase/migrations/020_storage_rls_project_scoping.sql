-- Migration 020: Project-scoped storage RLS policies
--
-- Security fix (P0 §7.1): Storage bucket policies previously only checked
-- auth.role() = 'authenticated', allowing any authenticated user to
-- read/modify/delete files belonging to ANY project. This migration drops
-- the old policies and replaces them with ones that verify the requesting
-- user is a member of the project that owns the file.
--
-- Storage path convention: {project_id}/...
-- The project_id is extracted as the first path segment via:
--   (storage.foldername(name))[1]::uuid
--
-- Uses (select auth.uid()) pattern for single-evaluation per query.

-- ──────────────────────────────────────────────────────────────────────
-- 1. DROP old attachments policies (from 001_initial_schema.sql)
-- ──────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Public Access"
  ON storage.objects;

DROP POLICY IF EXISTS "Authenticated users can upload attachments"
  ON storage.objects;

DROP POLICY IF EXISTS "Authenticated users can update attachments"
  ON storage.objects;

DROP POLICY IF EXISTS "Project admins can delete attachments"
  ON storage.objects;

-- ──────────────────────────────────────────────────────────────────────
-- 2. DROP old submittals policies (from 008_pdf_storage.sql)
-- ──────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Authenticated users can upload submittals"
  ON storage.objects;

DROP POLICY IF EXISTS "Authenticated users can read submittals"
  ON storage.objects;

DROP POLICY IF EXISTS "Authenticated users can delete submittals"
  ON storage.objects;

-- ──────────────────────────────────────────────────────────────────────
-- 3. NEW project-scoped policies for the ATTACHMENTS bucket
-- ──────────────────────────────────────────────────────────────────────

CREATE POLICY "Project members can read attachments"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'attachments'
    AND EXISTS (
      SELECT 1 FROM public.project_members
      WHERE project_members.project_id = ((storage.foldername(name))[1])::uuid
        AND project_members.user_id = (select auth.uid())
    )
  );

CREATE POLICY "Project members can upload attachments"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'attachments'
    AND EXISTS (
      SELECT 1 FROM public.project_members
      WHERE project_members.project_id = ((storage.foldername(name))[1])::uuid
        AND project_members.user_id = (select auth.uid())
    )
  );

CREATE POLICY "Project members can update attachments"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'attachments'
    AND EXISTS (
      SELECT 1 FROM public.project_members
      WHERE project_members.project_id = ((storage.foldername(name))[1])::uuid
        AND project_members.user_id = (select auth.uid())
    )
  );

CREATE POLICY "Project members can delete attachments"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'attachments'
    AND EXISTS (
      SELECT 1 FROM public.project_members
      WHERE project_members.project_id = ((storage.foldername(name))[1])::uuid
        AND project_members.user_id = (select auth.uid())
    )
  );

-- ──────────────────────────────────────────────────────────────────────
-- 4. NEW project-scoped policies for the SUBMITTALS bucket
-- ──────────────────────────────────────────────────────────────────────

CREATE POLICY "Project members can read submittals"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'submittals'
    AND EXISTS (
      SELECT 1 FROM public.project_members
      WHERE project_members.project_id = ((storage.foldername(name))[1])::uuid
        AND project_members.user_id = (select auth.uid())
    )
  );

CREATE POLICY "Project members can upload submittals"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'submittals'
    AND EXISTS (
      SELECT 1 FROM public.project_members
      WHERE project_members.project_id = ((storage.foldername(name))[1])::uuid
        AND project_members.user_id = (select auth.uid())
    )
  );

CREATE POLICY "Project members can update submittals"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'submittals'
    AND EXISTS (
      SELECT 1 FROM public.project_members
      WHERE project_members.project_id = ((storage.foldername(name))[1])::uuid
        AND project_members.user_id = (select auth.uid())
    )
  );

CREATE POLICY "Project members can delete submittals"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'submittals'
    AND EXISTS (
      SELECT 1 FROM public.project_members
      WHERE project_members.project_id = ((storage.foldername(name))[1])::uuid
        AND project_members.user_id = (select auth.uid())
    )
  );
