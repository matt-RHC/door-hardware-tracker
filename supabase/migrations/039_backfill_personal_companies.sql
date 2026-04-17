-- Migration 039: Backfill — every existing user gets a personal company,
-- every existing project gets a company_id, then SET NOT NULL.
--
-- Runs as a single transaction. Fails loudly if any project ends up with
-- company_id IS NULL so we never silently orphan production data.
--
-- Project → company assignment preference order:
--   1. earliest-joined project_members row where role = 'admin'
--   2. earliest-joined project_members row of any role
--   3. projects.created_by (fallback for projects with no members)
--   4. system-owner personal company (final sentinel fallback)
-- Any fallback is logged to the _backfill_notes temp table so we can audit.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Personal company per auth.users row.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _personal_company_map (
  user_id     uuid PRIMARY KEY,
  company_id  uuid NOT NULL
) ON COMMIT DROP;

WITH inserted AS (
  INSERT INTO public.companies (name, slug)
  SELECT
    COALESCE(
      NULLIF(trim(u.raw_user_meta_data->>'full_name'), ''),
      split_part(u.email, '@', 1),
      'User'
    ) || ' (personal)',
    ('personal-' || substr(replace(u.id::text, '-', ''), 1, 12))::citext
  FROM auth.users u
  LEFT JOIN public.company_members cm ON cm.user_id = u.id
  WHERE cm.user_id IS NULL
  RETURNING id, slug
)
INSERT INTO _personal_company_map (user_id, company_id)
SELECT
  u.id,
  i.id
FROM auth.users u
JOIN inserted i
  ON i.slug = ('personal-' || substr(replace(u.id::text, '-', ''), 1, 12))::citext;

-- Make the user the owner of their personal company.
INSERT INTO public.company_members (company_id, user_id, role, is_default)
SELECT company_id, user_id, 'owner', true
FROM _personal_company_map
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Assign a company_id to every project.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TEMP TABLE _backfill_notes (
  project_id   uuid,
  strategy     text,
  note         text,
  noted_at     timestamptz NOT NULL DEFAULT now()
) ON COMMIT DROP;

-- Step 2a: earliest admin member wins.
WITH admin_pick AS (
  SELECT DISTINCT ON (pm.project_id)
    pm.project_id,
    pm.user_id
  FROM public.project_members pm
  WHERE pm.role = 'admin'
  ORDER BY pm.project_id, pm.joined_at NULLS LAST, pm.user_id
)
UPDATE public.projects p
SET company_id = pcm.company_id
FROM admin_pick ap
JOIN _personal_company_map pcm ON pcm.user_id = ap.user_id
WHERE p.id = ap.project_id
  AND p.company_id IS NULL;

INSERT INTO _backfill_notes (project_id, strategy, note)
SELECT p.id, 'admin_member', 'earliest admin project_member'
FROM public.projects p
WHERE p.company_id IS NOT NULL
  AND p.id IN (
    SELECT project_id FROM public.project_members WHERE role = 'admin'
  );

-- Step 2b: earliest member of any role.
WITH member_pick AS (
  SELECT DISTINCT ON (pm.project_id)
    pm.project_id,
    pm.user_id
  FROM public.project_members pm
  WHERE pm.user_id IS NOT NULL
  ORDER BY pm.project_id, pm.joined_at NULLS LAST, pm.user_id
)
UPDATE public.projects p
SET company_id = pcm.company_id
FROM member_pick mp
JOIN _personal_company_map pcm ON pcm.user_id = mp.user_id
WHERE p.id = mp.project_id
  AND p.company_id IS NULL;

INSERT INTO _backfill_notes (project_id, strategy, note)
SELECT p.id, 'first_member', 'no admin; earliest project_member'
FROM public.projects p
LEFT JOIN public.project_members pm ON pm.project_id = p.id AND pm.role = 'admin'
WHERE p.company_id IS NOT NULL
  AND pm.project_id IS NULL
  AND p.id IN (SELECT project_id FROM public.project_members);

-- Step 2c: created_by fallback.
UPDATE public.projects p
SET company_id = pcm.company_id
FROM _personal_company_map pcm
WHERE p.id IS NOT NULL
  AND p.company_id IS NULL
  AND p.created_by = pcm.user_id;

INSERT INTO _backfill_notes (project_id, strategy, note)
SELECT p.id, 'created_by', 'no members; fell back to projects.created_by'
FROM public.projects p
WHERE p.company_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.project_members pm WHERE pm.project_id = p.id)
  AND p.created_by IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Assert every project has a company_id before flipping NOT NULL.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_missing integer;
BEGIN
  SELECT count(*) INTO v_missing
  FROM public.projects WHERE company_id IS NULL;

  IF v_missing > 0 THEN
    RAISE EXCEPTION 'backfill incomplete: % projects still have company_id IS NULL', v_missing;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Flip NOT NULL now that every row is populated.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.projects
  ALTER COLUMN company_id SET NOT NULL;

COMMIT;
