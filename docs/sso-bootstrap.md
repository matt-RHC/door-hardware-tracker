# SSO Bootstrap Playbook

This doc is the operational checklist for onboarding the **first** company
via SSO, before the `/admin/companies` surface is available to you. Once
that UI is shipped and you've granted your own user ID access via
`ADMIN_USER_IDS`, prefer clicking over copy-pasting SQL.

## 0. Prerequisite — migration history reconciliation

Migrations 035, 036, and 037 landed in production via raw SQL and were
never recorded in `supabase_migrations.schema_migrations`. Before running
`supabase db push` against production, insert retroactive marker rows so
the CLI doesn't try to replay them:

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
VALUES
  ('20260416170000', '035_darrin_rename_and_phase_data',         ARRAY['-- applied out-of-band 2026-04-16']::text[]),
  ('20260416170001', '036_product_families',                     ARRAY['-- applied out-of-band 2026-04-16']::text[]),
  ('20260416170002', '037_merge_extraction_report_orphans',      ARRAY['-- applied out-of-band 2026-04-16']::text[])
ON CONFLICT (version) DO NOTHING;

-- Verify — expect rows for 034, 035, 036, 037
SELECT version, name FROM supabase_migrations.schema_migrations
WHERE name LIKE '03%' ORDER BY version;
```

Only after this step should you run `supabase db push`.

## 1. Apply migrations 038–042

```bash
supabase db push --db-url "$PROD_DATABASE_URL"
```

Expected ordering and safe-to-replay behavior:
- 038 — pure additive (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS).
- 039 — single transaction, asserts every project has a `company_id`.
- 040 — DROP/CREATE POLICY; re-runnable.
- 041 — DROP/CREATE storage policies + `storage.buckets.public` assertion.
- 042 — function CREATE OR REPLACE, trigger DROP/CREATE, one-shot backfill UPDATE.

If 039 throws `backfill incomplete: N projects still have company_id IS NULL`,
fix the culprit manually (likely a project with `created_by IS NULL` and no
members), then re-run 039.

## 2. Create DPR Construction and register dpr.com

```sql
-- Create the company row.
INSERT INTO public.companies (name, slug)
VALUES ('DPR Construction', 'dpr-construction')
RETURNING id;

-- Capture the returned id. Example: 'a1b2c3d4-...'.
-- Register the domain so future sign-ins auto-join.
INSERT INTO public.company_domains (company_id, domain, verified_at)
VALUES ('<dpr_company_id>', 'dpr.com', now());
```

Admins can register additional domains later via
`/admin/companies/[id]` once the UI is available.

## 3. Backfill existing DPR users

The trigger only fires on `INSERT` into `auth.users`. Users who already
exist need an explicit pass:

```sql
-- Dry-run: list the users who WOULD be auto-joined.
SELECT u.id, u.email
FROM auth.users u
JOIN public.company_domains cd
  ON lower(split_part(u.email, '@', 2)) = cd.domain
WHERE cd.company_id = '<dpr_company_id>'
  AND NOT EXISTS (
    SELECT 1 FROM public.company_members cm
    WHERE cm.user_id = u.id AND cm.company_id = cd.company_id
  );

-- Apply it: insert memberships + stamp JWT claim.
WITH targets AS (
  SELECT u.id AS user_id, cd.company_id
  FROM auth.users u
  JOIN public.company_domains cd
    ON lower(split_part(u.email, '@', 2)) = cd.domain
  WHERE cd.company_id = '<dpr_company_id>'
    AND NOT EXISTS (
      SELECT 1 FROM public.disallowed_domains dd WHERE dd.domain = cd.domain
    )
)
INSERT INTO public.company_members (company_id, user_id, role, is_default)
SELECT company_id, user_id, 'member', true FROM targets
ON CONFLICT (company_id, user_id) DO NOTHING;

UPDATE auth.users u
SET raw_app_meta_data = jsonb_set(
      COALESCE(u.raw_app_meta_data, '{}'::jsonb),
      '{company_id}',
      to_jsonb(cm.company_id::text),
      true
    )
FROM public.company_members cm
WHERE cm.user_id = u.id
  AND cm.company_id = '<dpr_company_id>';
```

## 4. Register admins

Set the `ADMIN_USER_IDS` env var on Vercel (Production + Preview) to the
comma-separated UUIDs that should access `/admin`. Example:

```
ADMIN_USER_IDS=7e5b…a13,9c1d…22f
```

Redeploy (env-var changes require a new deployment).

## 5. Supabase Auth config

In the Supabase dashboard, **Auth → URL Configuration**:

- **Site URL**: `https://tracker.rabbitholesystems.com` (or your prod host).
- **Redirect URLs**: add entries for
  - `http://localhost:3000/api/auth/callback`
  - `https://*.vercel.app/api/auth/callback` (if you use preview deploys)
  - `https://tracker.rabbitholesystems.com/api/auth/callback`

In **Auth → Providers**:

- Google: enable; set the client ID/secret from the Google Cloud Console;
  the authorized redirect URI on Google must be
  `https://<project_ref>.supabase.co/auth/v1/callback`.
- Microsoft (Azure): enable; set `scopes: 'email'` in the app's
  `signInWithOAuth` call (already wired in `src/app/page.tsx`).

## 6. Domain move between companies

`company_domains.domain` is globally unique — if you move `dpr.com` from
company A to company B, existing `company_members` rows for A are NOT
migrated. Run this manual transfer after you update `company_domains`:

```sql
BEGIN;

-- Copy every DPR-domain user from company A to company B.
INSERT INTO public.company_members (company_id, user_id, role, is_default)
SELECT
  '<new_company_id>'::uuid,
  cm.user_id,
  cm.role,
  true
FROM public.company_members cm
JOIN auth.users u ON u.id = cm.user_id
WHERE cm.company_id = '<old_company_id>'
  AND lower(split_part(u.email, '@', 2)) = 'dpr.com'
ON CONFLICT (company_id, user_id) DO NOTHING;

-- Remove the old memberships and re-stamp JWT.
DELETE FROM public.company_members
WHERE company_id = '<old_company_id>'
  AND user_id IN (
    SELECT cm.user_id
    FROM public.company_members cm
    JOIN auth.users u ON u.id = cm.user_id
    WHERE cm.company_id = '<old_company_id>'
      AND lower(split_part(u.email, '@', 2)) = 'dpr.com'
  );

UPDATE auth.users u
SET raw_app_meta_data = jsonb_set(
      COALESCE(u.raw_app_meta_data, '{}'::jsonb),
      '{company_id}',
      to_jsonb('<new_company_id>'::text),
      true
    )
WHERE lower(split_part(u.email, '@', 2)) = 'dpr.com';

COMMIT;
```

Users who re-sign-in will pick up the new `app_metadata.company_id`
without further action.

## 7. Verification checklist

After bootstrap, walk the §9 verification plan from the SSO plan. The
ones you can't skip:

- [ ] Sign in with a matching SSO account → lands on `/dashboard` with a
      `company_members` row for DPR.
- [ ] Sign in with a non-matching account → lands on `/auth/no-company`.
- [ ] From the DPR session, fetch a project PDF URL in another company →
      403 from `assertProjectInUserCompany`.
- [ ] `storage.buckets.public` is false for both `attachments` and
      `submittals`.

If anything fails, revert to the last known-good migration by temporarily
disabling RLS on the affected tables, investigate, and redeploy — do
**not** ship a hotfix that bypasses tenancy.
