-- Migration 038: Company-scoped tenancy (Phase 1 — tables + FK)
--
-- Introduces the three tenancy tables (companies, company_domains,
-- company_members) plus the nullable projects.company_id foreign key.
-- RLS, backfill, and the NOT NULL flip are deferred to 039 and 040 so each
-- step can be verified in isolation.
--
-- Prerequisite: §0 history repair — `supabase_migrations.schema_migrations`
-- must already carry rows for 035/036/037 before this migration runs,
-- otherwise `supabase db push` will attempt to replay them first. See
-- the company-sso plan §0 for the required INSERT.
--
-- Ordering inside this migration:
--   1. Enable citext extension (needed for case-insensitive slugs/domains).
--   2. Create companies, company_domains, company_members.
--   3. Add projects.company_id (NULLABLE here — 039 fills then flips).
--   4. Seed disallowed_domains with the well-known public-email providers.

CREATE EXTENSION IF NOT EXISTS citext;

-- ─────────────────────────────────────────────────────────────────────────
-- companies — the tenancy root. One row per construction firm.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        citext NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.companies IS
  'Tenancy root. Each row is a construction firm / organization. '
  'Projects belong to exactly one company; users belong to one or more '
  'via company_members. Admin-provisioned only — no self-serve creation.';

-- ─────────────────────────────────────────────────────────────────────────
-- company_domains — email domains that route to a company on sign-in.
-- Unique global constraint: a domain cannot belong to two companies.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.company_domains (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  domain       citext NOT NULL UNIQUE,
  verified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_company_domains_company
  ON public.company_domains(company_id);

COMMENT ON TABLE public.company_domains IS
  'Email-domain → company mapping used at sign-in to auto-join users. '
  'verified_at is advisory in v1 (admin trusts the registration); v2 will '
  'enforce DNS-TXT verification before setting it.';

-- ─────────────────────────────────────────────────────────────────────────
-- company_members — user ↔ company join table with role + default flag.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.company_members (
  company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'member'
              CHECK (role IN ('owner','admin','member')),
  is_default  boolean NOT NULL DEFAULT true,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_company_members_user
  ON public.company_members(user_id);

COMMENT ON TABLE public.company_members IS
  'User membership in a company. is_default is the company surfaced '
  'post-login when a user belongs to more than one (v2). Writes go through '
  'the SECURITY DEFINER trigger/RPC for auto-join and through service-role '
  'admin API routes for manual promotions — no self-service insert path.';

-- ─────────────────────────────────────────────────────────────────────────
-- projects.company_id — tenancy foreign key.
-- Nullable here; 039 backfills every row and sets NOT NULL.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS company_id uuid
  REFERENCES public.companies(id);

CREATE INDEX IF NOT EXISTS idx_projects_company
  ON public.projects(company_id);

-- ─────────────────────────────────────────────────────────────────────────
-- disallowed_domains — public-email providers that never auto-join.
-- Keeps `gmail.com` etc. from accidentally becoming a company domain.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.disallowed_domains (
  domain  citext PRIMARY KEY,
  note    text
);

COMMENT ON TABLE public.disallowed_domains IS
  'Public-email providers that must never map to a company. Checked by '
  'handle_new_auth_user() and try_domain_auto_join() before any insert '
  'into company_members, and by admin API routes before registering a '
  'company_domains row.';

INSERT INTO public.disallowed_domains (domain, note) VALUES
  ('gmail.com',       'Google consumer'),
  ('googlemail.com',  'Google consumer'),
  ('outlook.com',     'Microsoft consumer'),
  ('hotmail.com',     'Microsoft consumer'),
  ('live.com',        'Microsoft consumer'),
  ('msn.com',         'Microsoft consumer'),
  ('yahoo.com',       'Yahoo consumer'),
  ('ymail.com',       'Yahoo consumer'),
  ('icloud.com',      'Apple consumer'),
  ('me.com',          'Apple consumer'),
  ('mac.com',         'Apple consumer'),
  ('aol.com',         'Verizon/AOL consumer'),
  ('proton.me',       'Proton consumer'),
  ('protonmail.com',  'Proton consumer'),
  ('pm.me',           'Proton consumer'),
  ('gmx.com',         'GMX consumer'),
  ('gmx.de',          'GMX consumer'),
  ('fastmail.com',    'Fastmail consumer'),
  ('tutanota.com',    'Tutanota consumer'),
  ('zoho.com',        'Zoho consumer'),
  ('qq.com',          'Tencent consumer'),
  ('163.com',         'NetEase consumer'),
  ('126.com',         'NetEase consumer'),
  ('sina.com',        'Sina consumer'),
  ('yandex.ru',       'Yandex consumer'),
  ('yandex.com',      'Yandex consumer'),
  ('mail.ru',         'Mail.ru consumer')
ON CONFLICT (domain) DO NOTHING;
