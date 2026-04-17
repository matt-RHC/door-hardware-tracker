-- Migration 042: Domain auto-join trigger + RPC + advisor fixes.
--
-- 1. handle_new_auth_user()  — AFTER INSERT ON auth.users. On a new signup,
--    look up the email domain in company_domains (skipping disallowed),
--    insert a company_members row if matched, and stamp
--    auth.users.raw_app_meta_data.company_id so the JWT carries it.
--
-- 2. try_domain_auto_join()  — RPC that re-runs the same logic for the
--    current auth.uid(). Covers pre-existing users whose company domain
--    was registered after their account was created.
--
-- 3. Advisor cleanup — add SET search_path = public, pg_temp to the six
--    functions the Supabase security advisor flagged as
--    function_search_path_mutable, and convert openings_blocked_v from
--    SECURITY DEFINER to SECURITY INVOKER.
--
-- Both SECURITY DEFINER functions use locked search_path to prevent the
-- classic hijack via mutable object resolution.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Domain auto-join on new auth.users row.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_domain      citext;
  v_company_id  uuid;
BEGIN
  -- Only auto-join when we have a usable email.
  IF NEW.email IS NULL OR position('@' IN NEW.email) = 0 THEN
    RETURN NEW;
  END IF;

  v_domain := lower(split_part(NEW.email, '@', 2))::citext;

  -- Skip well-known public-email providers entirely.
  IF EXISTS (SELECT 1 FROM public.disallowed_domains WHERE domain = v_domain) THEN
    RETURN NEW;
  END IF;

  -- Match against registered company domains.
  SELECT company_id INTO v_company_id
  FROM public.company_domains
  WHERE domain = v_domain
  LIMIT 1;

  IF v_company_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Insert membership (idempotent).
  INSERT INTO public.company_members (company_id, user_id, role, is_default)
  VALUES (v_company_id, NEW.id, 'member', true)
  ON CONFLICT (company_id, user_id) DO NOTHING;

  -- Stamp raw_app_meta_data so the JWT carries company_id without a DB hit
  -- on first session. We merge rather than replace to preserve existing
  -- provider metadata (e.g. 'providers' array).
  UPDATE auth.users
  SET raw_app_meta_data = jsonb_set(
        COALESCE(raw_app_meta_data, '{}'::jsonb),
        '{company_id}',
        to_jsonb(v_company_id::text),
        true
      )
  WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_auth_user() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.handle_new_auth_user() TO supabase_auth_admin;

DROP TRIGGER IF EXISTS on_auth_user_created_company_join ON auth.users;
CREATE TRIGGER on_auth_user_created_company_join
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Re-evaluation RPC for pre-existing users. Callable over PostgREST.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.try_domain_auto_join()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id     uuid := auth.uid();
  v_email       text;
  v_domain      citext;
  v_company_id  uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Lock the user row so concurrent callback + trigger don't race.
  SELECT email INTO v_email
  FROM auth.users
  WHERE id = v_user_id
  FOR UPDATE;

  IF v_email IS NULL OR position('@' IN v_email) = 0 THEN
    RETURN NULL;
  END IF;

  v_domain := lower(split_part(v_email, '@', 2))::citext;

  IF EXISTS (SELECT 1 FROM public.disallowed_domains WHERE domain = v_domain) THEN
    RETURN NULL;
  END IF;

  SELECT company_id INTO v_company_id
  FROM public.company_domains
  WHERE domain = v_domain
  LIMIT 1;

  IF v_company_id IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.company_members (company_id, user_id, role, is_default)
  VALUES (v_company_id, v_user_id, 'member', true)
  ON CONFLICT (company_id, user_id) DO NOTHING;

  UPDATE auth.users
  SET raw_app_meta_data = jsonb_set(
        COALESCE(raw_app_meta_data, '{}'::jsonb),
        '{company_id}',
        to_jsonb(v_company_id::text),
        true
      )
  WHERE id = v_user_id;

  RETURN v_company_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.try_domain_auto_join() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.try_domain_auto_join() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Advisor cleanup — lock search_path on flagged functions.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  fn text;
  fns text[] := ARRAY[
    'update_server_updated_at',
    'update_issues_updated_at',
    'update_issue_comments_updated_at',
    'update_delivery_items_updated_at',
    'update_product_families_updated_at',
    'merge_extraction'
  ];
BEGIN
  FOREACH fn IN ARRAY fns LOOP
    -- Alter every overload with this name in the public schema.
    PERFORM 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = fn;

    IF FOUND THEN
      EXECUTE (
        SELECT string_agg(
          format('ALTER FUNCTION public.%I(%s) SET search_path = public, pg_temp;',
                 p.proname, pg_get_function_identity_arguments(p.oid)),
          E'\n'
        )
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = fn
      );
    END IF;
  END LOOP;
END $$;

-- Convert openings_blocked_v to SECURITY INVOKER (advisor ERROR).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_views
    WHERE schemaname = 'public' AND viewname = 'openings_blocked_v'
  ) THEN
    EXECUTE 'ALTER VIEW public.openings_blocked_v SET (security_invoker = true)';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. One-time app_metadata backfill for existing users who already have
--    a company_members row (e.g. from migration 039 personal companies, or
--    from manual DPR bootstrap). The trigger only fires on INSERT, so
--    older rows need a stamp to get the JWT fast path.
-- ─────────────────────────────────────────────────────────────────────────
UPDATE auth.users u
SET raw_app_meta_data = jsonb_set(
      COALESCE(u.raw_app_meta_data, '{}'::jsonb),
      '{company_id}',
      to_jsonb(cm.company_id::text),
      true
    )
FROM (
  SELECT DISTINCT ON (user_id) user_id, company_id
  FROM public.company_members
  ORDER BY user_id, is_default DESC, joined_at ASC
) cm
WHERE u.id = cm.user_id
  AND (
    u.raw_app_meta_data IS NULL
    OR u.raw_app_meta_data->>'company_id' IS NULL
    OR u.raw_app_meta_data->>'company_id' = ''
  );
