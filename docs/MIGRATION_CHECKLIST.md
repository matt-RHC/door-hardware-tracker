# Migration Checklist

Follow this checklist before applying any Supabase migration to production.

---

## Before Applying

1. **Export current schema backup**
   ```bash
   supabase db dump -f backup_$(date +%Y-%m-%d).sql
   ```

2. **Test on a branch database** (preferred) or local Supabase instance
   ```bash
   supabase db reset     # local: applies all migrations from scratch
   ```

3. **Review RLS impact** — if the migration touches RLS policies:
   - Verify existing users can still see their projects after applying
   - Check for recursive policy references (the `project_members` self-referencing bug from PR #155)
   - Test both `admin` and `member` role access

4. **Review data mutations** — if the migration alters columns or deletes data:
   - Confirm no rows will be lost with `SELECT COUNT(*)` before and after
   - Check for foreign key cascades that might delete more than intended

## Applying

5. **Apply the migration**
   ```bash
   supabase db push
   ```

6. **Verify immediately after applying:**
   - [ ] Can users log in?
   - [ ] Can users see their projects?
   - [ ] Can users upload a PDF? (triggers storage + extraction_jobs)
   - [ ] Do promoted extraction results still display correctly?

## Rollback Plan

If something goes wrong:

- **Supabase Pro plan:** Use point-in-time recovery (PITR) from the dashboard → Settings → Database → Backups
- **Supabase Free plan:** Restore from the `backup_*.sql` dump taken in step 1:
  ```bash
  psql $DATABASE_URL < backup_YYYY-MM-DD.sql
  ```
- **RLS lockout:** If users can't see data but the schema is fine, check the RLS policies directly in the Supabase SQL editor. Look for recursive `SELECT` subqueries in policies on `project_members`.

## Supabase Backup Tiers

| Plan | Backup Type | Retention | PITR |
|------|-------------|-----------|------|
| Free | Daily snapshot | 7 days | No |
| Pro ($25/mo) | Daily snapshot + PITR | 7 days | Yes |
| Team ($599/mo) | Daily snapshot + PITR | 14 days | Yes |

**Recommendation:** Upgrade to Pro before onboarding real customer data. The $25/month is cheap insurance against a bad migration.
