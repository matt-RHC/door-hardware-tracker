-- Migration 041: Storage RLS — add company check on top of project check.
--
-- Tightens the storage.objects policies from 020 so accessing a file at
-- <project_id>/<opening_id>/<file> requires BOTH project_members and
-- company_members to match for the current auth.uid().
--
-- CI assertion (run after migration applies):
--   SELECT id, public FROM storage.buckets
--   WHERE id IN ('attachments','submittals') AND public = true;
--   -- must return zero rows. A public bucket bypasses every RLS policy
--   -- below and silently exposes every file.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Drop the project-only policies created in migration 020.
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Project members can read attachments"     ON storage.objects;
DROP POLICY IF EXISTS "Project members can upload attachments"   ON storage.objects;
DROP POLICY IF EXISTS "Project members can update attachments"   ON storage.objects;
DROP POLICY IF EXISTS "Project members can delete attachments"   ON storage.objects;
DROP POLICY IF EXISTS "Project members can read submittals"      ON storage.objects;
DROP POLICY IF EXISTS "Project members can upload submittals"    ON storage.objects;
DROP POLICY IF EXISTS "Project members can update submittals"    ON storage.objects;
DROP POLICY IF EXISTS "Project members can delete submittals"    ON storage.objects;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Attachments bucket — project + company check.
-- ─────────────────────────────────────────────────────────────────────────
CREATE POLICY "Project+company members can read attachments"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'attachments'
    AND EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.projects p ON p.id = pm.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE pm.project_id = ((storage.foldername(name))[1])::uuid
        AND pm.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Project+company members can upload attachments"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'attachments'
    AND EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.projects p ON p.id = pm.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE pm.project_id = ((storage.foldername(name))[1])::uuid
        AND pm.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Project+company members can update attachments"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'attachments'
    AND EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.projects p ON p.id = pm.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE pm.project_id = ((storage.foldername(name))[1])::uuid
        AND pm.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Project+company members can delete attachments"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'attachments'
    AND EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.projects p ON p.id = pm.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE pm.project_id = ((storage.foldername(name))[1])::uuid
        AND pm.user_id = (SELECT auth.uid())
    )
  );

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Submittals bucket — same shape.
-- ─────────────────────────────────────────────────────────────────────────
CREATE POLICY "Project+company members can read submittals"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'submittals'
    AND EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.projects p ON p.id = pm.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE pm.project_id = ((storage.foldername(name))[1])::uuid
        AND pm.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Project+company members can upload submittals"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'submittals'
    AND EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.projects p ON p.id = pm.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE pm.project_id = ((storage.foldername(name))[1])::uuid
        AND pm.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Project+company members can update submittals"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'submittals'
    AND EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.projects p ON p.id = pm.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE pm.project_id = ((storage.foldername(name))[1])::uuid
        AND pm.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Project+company members can delete submittals"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'submittals'
    AND EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.projects p ON p.id = pm.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE pm.project_id = ((storage.foldername(name))[1])::uuid
        AND pm.user_id = (SELECT auth.uid())
    )
  );

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Sanity: both buckets must be private. Fail loudly if anyone has
--    flipped them to public through the dashboard.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_public int;
BEGIN
  SELECT count(*) INTO v_public
  FROM storage.buckets
  WHERE id IN ('attachments','submittals') AND public = true;

  IF v_public > 0 THEN
    RAISE EXCEPTION 'storage.buckets public=true for attachments or submittals — abort';
  END IF;
END $$;
