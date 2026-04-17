-- Migration 045: add preferred_provider to company_domains
--
-- v1 shipped with a code-side regex heuristic (src/app/api/auth/resolve/route.ts
-- providerForDomain()) that routes @onmicrosoft.com and consumer Microsoft
-- domains to Azure and everyone else to Google. Real corporate domains are
-- ambiguous -- dpr.com is a Microsoft 365 shop but the regex guesses Google.
-- This migration adds an admin-controllable override. NULL = use heuristic.

ALTER TABLE public.company_domains
  ADD COLUMN IF NOT EXISTS preferred_provider text
  CHECK (preferred_provider IS NULL OR preferred_provider IN ('google', 'azure'));

COMMENT ON COLUMN public.company_domains.preferred_provider IS
  'Optional override for /api/auth/resolve. NULL = use code-side regex heuristic.';
