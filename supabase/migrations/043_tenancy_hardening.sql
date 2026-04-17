-- Migration 043: Tenancy hardening — issue-evidence RLS + has_password_identity RPC.
--
-- Three things land here, all required to close gaps in PR #277:
--
-- 1. Storage RLS for the `issue-evidence` bucket. 041 hardened
--    `attachments` and `submittals` but skipped this one. The voice and
--    issue-attachment routes upload here, so without RLS any signed URL
--    leak — or a future flip to `public = true` — exposes evidence
--    cross-tenant. Same project + company EXISTS shape as 041.
--
-- 2. Loud assertion that no legacy-prefixed objects remain. The previous
--    upload paths put a literal string in segment 1
--    (`issue-evidence/...` and `issues/...`); the new RLS casts segment 1
--    to uuid, so legacy objects must be normalized first via
--    `node scripts/migrate-issue-evidence-paths.mjs` before this
--    migration can apply.
--
-- 3. has_password_identity(text) SECURITY DEFINER RPC. /api/auth/resolve
--    needs to know whether an email has a password identity in
--    `auth.identities`; the supabase-js admin SDK has no `filter` on
--    listUsers (that argument was silently ignored), and `auth` schema
--    isn't exposed to PostgREST by default. RPC is the clean path.

-- ─────────────────────────────────────────────────────────────────────────
-- 0. Ensure the bucket exists before we declare policies on it. Production
--    already has this row from a manual dashboard creation (032 only
--    documented the bucket name in a comment), so ON CONFLICT DO NOTHING
--    makes this statement a true no-op there. Fresh environments (CI,
--    restored backups) need the explicit INSERT — the policies below
--    would otherwise reference a bucket that doesn't exist, and the
--    rls-tenancy test suite would 404 on upload before any RLS check.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('issue-evidence', 'issue-evidence', false)
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Drop any pre-existing issue-evidence policies (defensive — none
--    expected, but a previous attempt to land this migration could have
--    left fragments).
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Project+company members can read issue-evidence"   ON storage.objects;
DROP POLICY IF EXISTS "Project+company members can upload issue-evidence" ON storage.objects;
DROP POLICY IF EXISTS "Project+company members can update issue-evidence" ON storage.objects;
DROP POLICY IF EXISTS "Project+company members can delete issue-evidence" ON storage.objects;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. issue-evidence RLS — same shape as 041's attachments/submittals.
-- ─────────────────────────────────────────────────────────────────────────
CREATE POLICY "Project+company members can read issue-evidence"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'issue-evidence'
    AND EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.projects p ON p.id = pm.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE pm.project_id = ((storage.foldername(name))[1])::uuid
        AND pm.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Project+company members can upload issue-evidence"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'issue-evidence'
    AND EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.projects p ON p.id = pm.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE pm.project_id = ((storage.foldername(name))[1])::uuid
        AND pm.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Project+company members can update issue-evidence"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'issue-evidence'
    AND EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.projects p ON p.id = pm.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE pm.project_id = ((storage.foldername(name))[1])::uuid
        AND pm.user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Project+company members can delete issue-evidence"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'issue-evidence'
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
-- 3. Legacy-path assertion. The new RLS expects every issue-evidence
--    object's first path segment to be a project UUID. Any object whose
--    segment 1 doesn't match the UUID shape is from the old layout
--    (`issue-evidence/<project>/...` or `issues/<project>/...`) and would
--    silently fail every RLS check. Refuse to apply rather than leaving
--    dead objects behind.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_legacy int;
BEGIN
  SELECT count(*) INTO v_legacy
  FROM storage.objects
  WHERE bucket_id = 'issue-evidence'
    AND (storage.foldername(name))[1] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  IF v_legacy > 0 THEN
    -- Keep the literal command in the message so the operator can
    -- copy-paste from the failure log without hunting for the runbook.
    RAISE EXCEPTION
      'issue-evidence has % legacy-prefixed objects. Run: node scripts/migrate-issue-evidence-paths.mjs',
      v_legacy;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Bucket-must-be-private assertion (mirror of 041 §4 for this bucket).
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_public int;
BEGIN
  SELECT count(*) INTO v_public
  FROM storage.buckets
  WHERE id = 'issue-evidence' AND public = true;

  IF v_public > 0 THEN
    RAISE EXCEPTION 'storage.buckets public=true for issue-evidence — abort';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. has_password_identity(p_email) — used by /api/auth/resolve to
--    decide whether the inline password field should slide in. Returns
--    true only when the user has an `email` row in `auth.identities`,
--    so an OAuth-only user does NOT trigger the password flow.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.has_password_identity(p_email text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM auth.users u
    JOIN auth.identities i ON i.user_id = u.id
    WHERE lower(u.email) = lower(p_email)
      AND i.provider = 'email'
  );
$$;

REVOKE EXECUTE ON FUNCTION public.has_password_identity(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.has_password_identity(text) TO service_role;

COMMENT ON FUNCTION public.has_password_identity(text) IS
  'Returns true iff the email has an email/password identity in '
  'auth.identities. Called only via the service-role client from '
  '/api/auth/resolve — never exposed to the anonymous role.';
