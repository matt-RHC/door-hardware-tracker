-- Migration 040: Company-scoped RLS.
--
-- Every table that currently checks "caller is a project_member" is tightened
-- to ALSO require "caller is a company_member of that project's company".
-- A project_member row with a dangling company assignment can no longer grant
-- cross-tenant access.
--
-- Also:
--   - Enables + forces RLS on companies, company_domains, company_members.
--   - Adds the SELECT policy for company_members using the subquery-barrier
--     pattern from 016_security_and_rls_fixes.sql so we don't loop the policy
--     through itself during evaluation.
--   - Enables RLS on activity_log (previously flagged as a security advisor
--     ERROR). No SELECT/INSERT policies — service-role writes continue to
--     work because RLS does not apply to the service role.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Turn RLS on for the new tenancy tables + activity_log.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.companies        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies        FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.company_domains  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_domains  FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.company_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_members  FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.activity_log     ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.activity_log IS
  'Audit trail. RLS is enabled with no client-facing policies — writes go '
  'through the service-role client via src/lib/activity-log.ts, which is '
  'unaffected by RLS. Keep no SELECT policy to preserve tamper-proof intent.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. companies SELECT — users see companies they belong to.
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Members can view their companies" ON public.companies;
CREATE POLICY "Members can view their companies"
  ON public.companies FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.company_members cm
      WHERE cm.company_id = companies.id
        AND cm.user_id = (SELECT auth.uid())
    )
  );

-- (INSERT/UPDATE/DELETE on companies intentionally have no policy —
--  all writes go through the admin API using the service role.)

-- ─────────────────────────────────────────────────────────────────────────
-- 3. company_domains SELECT — same shape; no self-service writes.
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Members can view their domains" ON public.company_domains;
CREATE POLICY "Members can view their domains"
  ON public.company_domains FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.company_members cm
      WHERE cm.company_id = company_domains.company_id
        AND cm.user_id = (SELECT auth.uid())
    )
  );

-- ─────────────────────────────────────────────────────────────────────────
-- 4. company_members SELECT — the tricky one. Use the subquery-barrier
--    pattern: the inner SELECT scans company_members without re-entering
--    the policy (Postgres evaluates the barrier once per planned query).
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Members can view their company rosters" ON public.company_members;
CREATE POLICY "Members can view their company rosters"
  ON public.company_members FOR SELECT
  USING (
    company_id IN (
      SELECT cm2.company_id FROM public.company_members cm2
      WHERE cm2.user_id = (SELECT auth.uid())
    )
  );

-- (INSERT/UPDATE/DELETE on company_members intentionally have no policy —
--  trigger/RPC run as SECURITY DEFINER; admin routes use the service role.)

-- ─────────────────────────────────────────────────────────────────────────
-- 5. projects — replace SELECT / UPDATE / DELETE with company-aware policies.
--    INSERT keeps the existing created_by check; api/projects POST also
--    populates company_id via getActiveCompanyId().
-- ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view projects they are members of" ON public.projects;
CREATE POLICY "Users can view projects they are members of"
  ON public.projects FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = projects.id
        AND pm.user_id = (SELECT auth.uid())
    )
    AND EXISTS (
      SELECT 1 FROM public.company_members cm
      WHERE cm.company_id = projects.company_id
        AND cm.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Project admins can update projects" ON public.projects;
CREATE POLICY "Project admins can update projects"
  ON public.projects FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = projects.id
        AND pm.user_id = (SELECT auth.uid())
        AND pm.role = 'admin'
    )
    AND EXISTS (
      SELECT 1 FROM public.company_members cm
      WHERE cm.company_id = projects.company_id
        AND cm.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Project admins can delete projects" ON public.projects;
CREATE POLICY "Project admins can delete projects"
  ON public.projects FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = projects.id
        AND pm.user_id = (SELECT auth.uid())
        AND pm.role = 'admin'
    )
    AND EXISTS (
      SELECT 1 FROM public.company_members cm
      WHERE cm.company_id = projects.company_id
        AND cm.user_id = (SELECT auth.uid())
    )
  );

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Child tables — replace SELECT/INSERT/UPDATE/DELETE policies with ones
--    that also verify the caller belongs to the project's company.
--    We express the company check as a single joined EXISTS against the
--    parent projects row (via pm.project_id → projects.id → projects.company_id).
--    This is cheaper than a second EXISTS and matches how the planner
--    already joins project_members.
-- ─────────────────────────────────────────────────────────────────────────

-- Re-useable SQL fragment (documented; each policy inlines it):
--   pm.project_id = <target>  AND pm.user_id = auth.uid()
--   AND EXISTS (SELECT 1 FROM projects p JOIN company_members cm
--               ON cm.company_id = p.company_id
--               WHERE p.id = <target> AND cm.user_id = auth.uid())

-- ============= openings (project_id on row) =============
DROP POLICY IF EXISTS "Project members can view openings" ON public.openings;
CREATE POLICY "Project members can view openings"
  ON public.openings FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = openings.project_id AND pm.user_id = (SELECT auth.uid())
    )
    AND EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.company_members cm ON cm.company_id = p.company_id
      WHERE p.id = openings.project_id AND cm.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Project members can create openings" ON public.openings;
CREATE POLICY "Project members can create openings"
  ON public.openings FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = openings.project_id AND pm.user_id = (SELECT auth.uid())
    )
    AND EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.company_members cm ON cm.company_id = p.company_id
      WHERE p.id = openings.project_id AND cm.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Project members can update openings" ON public.openings;
CREATE POLICY "Project members can update openings"
  ON public.openings FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = openings.project_id AND pm.user_id = (SELECT auth.uid())
    )
    AND EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.company_members cm ON cm.company_id = p.company_id
      WHERE p.id = openings.project_id AND cm.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Project admins can delete openings" ON public.openings;
CREATE POLICY "Project admins can delete openings"
  ON public.openings FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      WHERE pm.project_id = openings.project_id
        AND pm.user_id = (SELECT auth.uid())
        AND pm.role = 'admin'
    )
    AND EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.company_members cm ON cm.company_id = p.company_id
      WHERE p.id = openings.project_id AND cm.user_id = (SELECT auth.uid())
    )
  );

-- ============= hardware_items (via openings.opening_id) =============
DROP POLICY IF EXISTS "Project members can view hardware items" ON public.hardware_items;
CREATE POLICY "Project members can view hardware items"
  ON public.hardware_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.openings o ON o.project_id = pm.project_id
      JOIN public.projects p ON p.id = o.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE o.id = hardware_items.opening_id
        AND pm.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Project members can create hardware items" ON public.hardware_items;
CREATE POLICY "Project members can create hardware items"
  ON public.hardware_items FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.openings o ON o.project_id = pm.project_id
      JOIN public.projects p ON p.id = o.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE o.id = hardware_items.opening_id
        AND pm.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Project members can update hardware items" ON public.hardware_items;
CREATE POLICY "Project members can update hardware items"
  ON public.hardware_items FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.openings o ON o.project_id = pm.project_id
      JOIN public.projects p ON p.id = o.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE o.id = hardware_items.opening_id
        AND pm.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Project admins can delete hardware items" ON public.hardware_items;
CREATE POLICY "Project admins can delete hardware items"
  ON public.hardware_items FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.openings o ON o.project_id = pm.project_id
      JOIN public.projects p ON p.id = o.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE o.id = hardware_items.opening_id
        AND pm.user_id = (SELECT auth.uid())
        AND pm.role = 'admin'
    )
  );

-- ============= checklist_progress (via openings.opening_id) =============
DROP POLICY IF EXISTS "Project members can view checklist progress" ON public.checklist_progress;
CREATE POLICY "Project members can view checklist progress"
  ON public.checklist_progress FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.openings o ON o.project_id = pm.project_id
      JOIN public.projects p ON p.id = o.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE o.id = checklist_progress.opening_id
        AND pm.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Project members can create checklist progress" ON public.checklist_progress;
CREATE POLICY "Project members can create checklist progress"
  ON public.checklist_progress FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.openings o ON o.project_id = pm.project_id
      JOIN public.projects p ON p.id = o.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE o.id = checklist_progress.opening_id
        AND pm.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Project members can update checklist progress" ON public.checklist_progress;
CREATE POLICY "Project members can update checklist progress"
  ON public.checklist_progress FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.openings o ON o.project_id = pm.project_id
      JOIN public.projects p ON p.id = o.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE o.id = checklist_progress.opening_id
        AND pm.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Project admins can delete checklist progress" ON public.checklist_progress;
CREATE POLICY "Project admins can delete checklist progress"
  ON public.checklist_progress FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.openings o ON o.project_id = pm.project_id
      JOIN public.projects p ON p.id = o.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE o.id = checklist_progress.opening_id
        AND pm.user_id = (SELECT auth.uid())
        AND pm.role = 'admin'
    )
  );

-- ============= attachments (via openings.opening_id) =============
DROP POLICY IF EXISTS "Project members can view attachments" ON public.attachments;
CREATE POLICY "Project members can view attachments"
  ON public.attachments FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.openings o ON o.project_id = pm.project_id
      JOIN public.projects p ON p.id = o.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE o.id = attachments.opening_id
        AND pm.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Project members can create attachments" ON public.attachments;
CREATE POLICY "Project members can create attachments"
  ON public.attachments FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.openings o ON o.project_id = pm.project_id
      JOIN public.projects p ON p.id = o.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE o.id = attachments.opening_id
        AND pm.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Project members can update attachments" ON public.attachments;
CREATE POLICY "Project members can update attachments"
  ON public.attachments FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.openings o ON o.project_id = pm.project_id
      JOIN public.projects p ON p.id = o.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE o.id = attachments.opening_id
        AND pm.user_id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Project admins can delete attachments" ON public.attachments;
CREATE POLICY "Project admins can delete attachments"
  ON public.attachments FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.project_members pm
      JOIN public.openings o ON o.project_id = pm.project_id
      JOIN public.projects p ON p.id = o.project_id
      JOIN public.company_members cm
        ON cm.company_id = p.company_id AND cm.user_id = pm.user_id
      WHERE o.id = attachments.opening_id
        AND pm.user_id = (SELECT auth.uid())
        AND pm.role = 'admin'
    )
  );

-- ─────────────────────────────────────────────────────────────────────────
-- 7. Remaining project-scoped tables — iterate in DO $$ loop for any that
--    already enforce project membership. For tables with a direct
--    project_id column, we can apply the same two-EXISTS pattern.
-- ─────────────────────────────────────────────────────────────────────────

-- Tables with a direct project_id column. We preserve existing CRUD shape
-- by adding the company check via an ADDITIONAL permissive policy per
-- command — but simpler: drop the old ones if named, create new ones.
-- In practice we only hard-rewrite the critical tables; others (issue_*,
-- delivery_*, qa_findings, staging_*, extraction_*, dashboard_shares,
-- product_families, reference_codes) get an extra policy that restricts
-- access to rows whose project is in the user's company. Postgres RLS is
-- permissive by default, so to tighten we add a RESTRICTIVE policy.

-- ============= issues =============
ALTER TABLE public.issues ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Company members only (issues)" ON public.issues;
CREATE POLICY "Company members only (issues)"
  ON public.issues AS RESTRICTIVE
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.company_members cm ON cm.company_id = p.company_id
      WHERE p.id = issues.project_id AND cm.user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.company_members cm ON cm.company_id = p.company_id
      WHERE p.id = issues.project_id AND cm.user_id = (SELECT auth.uid())
    )
  );

-- ============= issue_comments (via issues.issue_id) =============
ALTER TABLE public.issue_comments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Company members only (issue_comments)" ON public.issue_comments;
CREATE POLICY "Company members only (issue_comments)"
  ON public.issue_comments AS RESTRICTIVE
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.issues i
      JOIN public.projects p ON p.id = i.project_id
      JOIN public.company_members cm ON cm.company_id = p.company_id
      WHERE i.id = issue_comments.issue_id
        AND cm.user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.issues i
      JOIN public.projects p ON p.id = i.project_id
      JOIN public.company_members cm ON cm.company_id = p.company_id
      WHERE i.id = issue_comments.issue_id
        AND cm.user_id = (SELECT auth.uid())
    )
  );

-- ============= issue_attachments (via issues.issue_id) =============
ALTER TABLE public.issue_attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Company members only (issue_attachments)" ON public.issue_attachments;
CREATE POLICY "Company members only (issue_attachments)"
  ON public.issue_attachments AS RESTRICTIVE
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.issues i
      JOIN public.projects p ON p.id = i.project_id
      JOIN public.company_members cm ON cm.company_id = p.company_id
      WHERE i.id = issue_attachments.issue_id
        AND cm.user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.issues i
      JOIN public.projects p ON p.id = i.project_id
      JOIN public.company_members cm ON cm.company_id = p.company_id
      WHERE i.id = issue_attachments.issue_id
        AND cm.user_id = (SELECT auth.uid())
    )
  );

-- ============= extraction_runs / extraction_jobs / extraction_decisions =============
-- These all carry project_id. Apply the same restrictive company guard.

DO $$
DECLARE
  tbl text;
  tbls text[] := ARRAY[
    'extraction_runs',
    'extraction_jobs',
    'extraction_decisions',
    'staging_openings',
    'staging_hardware_items',
    'deliveries',
    'delivery_items',
    'qa_findings',
    'dashboard_shares',
    'product_families',
    'product_family_members',
    'reference_codes',
    'job_user_constraints'
  ];
BEGIN
  FOREACH tbl IN ARRAY tbls LOOP
    -- Only proceed if the table exists in this environment.
    IF to_regclass('public.' || tbl) IS NULL THEN
      CONTINUE;
    END IF;

    -- Ensure RLS is on for this table (defensive; most already have it).
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);

    -- Drop and recreate the restrictive company guard.
    EXECUTE format('DROP POLICY IF EXISTS "Company members only (%s)" ON public.%I', tbl, tbl);

    -- Tables with a direct project_id column get the direct-check version.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = tbl AND column_name = 'project_id'
    ) THEN
      EXECUTE format($f$
        CREATE POLICY "Company members only (%s)"
          ON public.%I AS RESTRICTIVE
          FOR ALL
          USING (
            EXISTS (
              SELECT 1 FROM public.projects p
              JOIN public.company_members cm ON cm.company_id = p.company_id
              WHERE p.id = %I.project_id
                AND cm.user_id = (SELECT auth.uid())
            )
          )
          WITH CHECK (
            EXISTS (
              SELECT 1 FROM public.projects p
              JOIN public.company_members cm ON cm.company_id = p.company_id
              WHERE p.id = %I.project_id
                AND cm.user_id = (SELECT auth.uid())
            )
          )
      $f$, tbl, tbl, tbl, tbl);
    END IF;
  END LOOP;
END $$;

-- product_family_members and delivery_items reach project_id through a
-- parent row. Handle them explicitly.

DO $$
BEGIN
  IF to_regclass('public.product_family_members') IS NOT NULL
     AND to_regclass('public.product_families') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'product_family_members'
         AND column_name = 'product_family_id'
     ) THEN
    EXECUTE '
      DROP POLICY IF EXISTS "Company members only (product_family_members via parent)"
        ON public.product_family_members;
      CREATE POLICY "Company members only (product_family_members via parent)"
        ON public.product_family_members AS RESTRICTIVE
        FOR ALL
        USING (
          EXISTS (
            SELECT 1 FROM public.product_families pf
            JOIN public.projects p ON p.id = pf.project_id
            JOIN public.company_members cm ON cm.company_id = p.company_id
            WHERE pf.id = product_family_members.product_family_id
              AND cm.user_id = (SELECT auth.uid())
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM public.product_families pf
            JOIN public.projects p ON p.id = pf.project_id
            JOIN public.company_members cm ON cm.company_id = p.company_id
            WHERE pf.id = product_family_members.product_family_id
              AND cm.user_id = (SELECT auth.uid())
          )
        );
    ';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.delivery_items') IS NOT NULL
     AND to_regclass('public.deliveries') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'delivery_items'
         AND column_name = 'delivery_id'
     ) THEN
    EXECUTE '
      DROP POLICY IF EXISTS "Company members only (delivery_items via parent)"
        ON public.delivery_items;
      CREATE POLICY "Company members only (delivery_items via parent)"
        ON public.delivery_items AS RESTRICTIVE
        FOR ALL
        USING (
          EXISTS (
            SELECT 1 FROM public.deliveries d
            JOIN public.projects p ON p.id = d.project_id
            JOIN public.company_members cm ON cm.company_id = p.company_id
            WHERE d.id = delivery_items.delivery_id
              AND cm.user_id = (SELECT auth.uid())
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM public.deliveries d
            JOIN public.projects p ON p.id = d.project_id
            JOIN public.company_members cm ON cm.company_id = p.company_id
            WHERE d.id = delivery_items.delivery_id
              AND cm.user_id = (SELECT auth.uid())
          )
        );
    ';
  END IF;
END $$;

-- issue_links and issue_watches reach through issues.
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['issue_links', 'issue_watches'] LOOP
    IF to_regclass('public.' || tbl) IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = tbl AND column_name = 'issue_id'
       ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('DROP POLICY IF EXISTS "Company members only (%s)" ON public.%I', tbl, tbl);
      EXECUTE format($f$
        CREATE POLICY "Company members only (%s)"
          ON public.%I AS RESTRICTIVE
          FOR ALL
          USING (
            EXISTS (
              SELECT 1 FROM public.issues i
              JOIN public.projects p ON p.id = i.project_id
              JOIN public.company_members cm ON cm.company_id = p.company_id
              WHERE i.id = %I.issue_id AND cm.user_id = (SELECT auth.uid())
            )
          )
          WITH CHECK (
            EXISTS (
              SELECT 1 FROM public.issues i
              JOIN public.projects p ON p.id = i.project_id
              JOIN public.company_members cm ON cm.company_id = p.company_id
              WHERE i.id = %I.issue_id AND cm.user_id = (SELECT auth.uid())
            )
          )
      $f$, tbl, tbl, tbl, tbl);
    END IF;
  END LOOP;
END $$;
