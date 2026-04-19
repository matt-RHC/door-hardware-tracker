-- Migration 053: Harden notes_set_updated_at() with SET search_path
--
-- Migration 051 created notes_set_updated_at() as a SECURITY INVOKER trigger
-- that stamps updated_at on note UPDATEs. Supabase's advisor flags it with
-- `function_search_path_mutable` (WARN, lint 0011) because no search_path
-- is pinned on the function — it inherits whatever the session has.
--
-- Risk level: low in practice. The function body only calls NOW() (from
-- pg_catalog, which is always searched first) and assigns to NEW.updated_at,
-- so there's no unqualified identifier that could be hijacked via a
-- search_path mutation. It is NOT SECURITY DEFINER, so there's no
-- privilege-escalation path either.
--
-- Why fix it anyway: matching the hardening style applied to
-- mark_notes_summaries_stale() in migration 052 gives us a consistent rule
-- ("all trigger functions pin search_path") and clears the advisor warning
-- so future real issues aren't lost in noise. Idempotent: CREATE OR REPLACE
-- preserves the existing trigger binding (notes_updated_at on notes), so
-- no trigger re-creation is needed.
--
-- Advisor reference:
-- https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable

BEGIN;

CREATE OR REPLACE FUNCTION notes_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION notes_set_updated_at() IS
  'Trigger function on `notes` that stamps NEW.updated_at on UPDATE. '
  'SECURITY INVOKER; search_path pinned per migration 053 for advisor '
  'hygiene and consistency with mark_notes_summaries_stale (migration 052).';

COMMIT;
