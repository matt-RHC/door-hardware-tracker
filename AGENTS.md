<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Agent Rules for Door Hardware Tracker

## Infrastructure Map

This app runs across four services. When diagnosing issues, know where to look:

| Service | What It Does | When To Check It |
|---------|-------------|------------------|
| **Vercel** | Hosts the Next.js app + Python serverless functions. Manages deployments, env vars, cron jobs, and function logs. | Deploy failures, env var issues, function timeouts (800s max), cold starts, cron job behavior (`process-jobs` runs every 2 min, `cleanup-staging` daily at 3am UTC) |
| **Supabase** | Postgres database, auth (email/password), file storage (PDF uploads), Row Level Security. | Auth failures, RLS policy bugs (users can't see projects), migration issues, storage access errors, database connection limits |
| **Sentry** | Error monitoring and session replay. Captures client-side JS errors, server-side API route failures, and edge/middleware errors. | Production errors, stack traces, error frequency/patterns, session replays of user-facing bugs. **Check Sentry first when investigating any production bug** — it captures errors with full context (stack trace, breadcrumbs, request data) that console logs miss. |
| **GitHub** | Source code, CI (GitHub Actions), pull requests. CI runs Python tests, TS lint, type checking, and vitest on every push/PR. | CI failures, merge conflicts, branch state. CI workflow is `.github/workflows/ci.yml`. |

### Debugging Flowchart

1. **User reports a bug →** Check **Sentry** first for the error + stack trace + session replay
2. **Error points to API route →** Check **Vercel** function logs for that route's execution
3. **Error involves data or auth →** Check **Supabase** logs, RLS policies, and the relevant migration history
4. **Error only in preview/production →** Check **Vercel** env vars (Production vs Preview) — a missing env var is the #1 cause of "works locally, breaks deployed"
5. **CI fails →** Check **GitHub Actions** logs — could be a real test failure or a transient npm network error

### Key Env Vars (all set in Vercel)

| Variable | Purpose | Scope |
|----------|---------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | Client + Server |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase public API key | Client + Server |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase admin access (bypasses RLS) | Server only |
| `ANTHROPIC_API_KEY` | LLM calls for extraction + Darrin | Server only |
| `PYTHON_INTERNAL_SECRET` | Auth token for Next.js → Python endpoint calls | Server only |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry error reporting endpoint | Client + Server |
| `SENTRY_AUTH_TOKEN` | Source map uploads to Sentry (build-time only) | Build only |

### Audit Trail

The `activity_log` table records who did what and when. Check it when tracing data discrepancies:
- `extraction_job_created` — who started an extraction and for which project
- `extraction_promoted` — who promoted staging data to production, with item/opening counts
- Written via `src/lib/activity-log.ts` using the service role client (tamper-proof)

### Rate Limiting

Extraction jobs are rate-limited to 5 per project per hour (`src/lib/extraction-rate-limit.ts`). If a user hits this, the API returns 429 with a `Retry-After` header.

## Before You Write Code

1. **Read CLAUDE.md first.** It contains the Turbopack TS rules, git workflow, and architecture context that will save you from known pitfalls.
2. **Check the last plan's status.** If there's an unmerged plan or open bug fix, work on THAT — do not start new work.
3. **One thing at a time.** Fix one bug, test it, merge it, then move on. Do not batch multiple fixes into one session.

## Code Quality

- **TypeScript:** Always use `?.`, `??`, and `?? []` for nullable access. Turbopack will reject `&&` guards and `if` narrowing patterns that tsc accepts. See CLAUDE.md for the full list.
- **No placeholder code.** Every feature must work end-to-end before moving on. No TODOs in production code.
- **Test against golden PDFs.** Any change to the extraction pipeline must be tested against the benchmark suite run by `scripts/run-golden-suite.mjs` (catalog of training PDFs with per-PDF `BASELINES` for door and set counts), plus the pinned-behavior fixtures in `test-pdfs/reference/`. The training directory and the runner catalog drift over time as new PDFs are added — **do not panic over exact count mismatches**. The health signals that matter are: (1) the suite runs green, (2) per-PDF door and set counts stay within a reasonable delta of `BASELINES` (no drastic swings up or down). Add new PDFs to `PDF_CATALOG` and record their baselines in the same PR that introduces them.

## Darrin AI Review Architecture

The extraction pipeline uses a multi-pass AI review system called **Darrin** — a senior DFH consultant persona that reviews extraction results at 3 checkpoints. See CLAUDE.md "Darrin AI Review Layer" section for full details.

When modifying extraction pipeline code:
- **Darrin prompts** live in `src/lib/darrin-prompts.ts` — update these when adding new domain knowledge or changing extraction behavior
- **Checkpoint functions** are in `chunk/route.ts` and `route.ts` — `callDarrinPostExtraction()`, `callDarrinColumnReview()`, `callDarrinQuantityCheck()`
- **Types** in `src/lib/types/index.ts` — `DarrinObservation`, `DarrinCorrections`, `DarrinColumnReview`, `DarrinQuantityCheck`
- **Confidence scoring** — every Darrin observation must include high/medium/low confidence
- **API responses** now include `darrinObservations` and `darrinQuantityCheck` fields

## User Interaction

- **Ask, don't guess.** If you're uncertain about a field mapping, consultant convention, or user intent — ask. Interactive confirmation is always better than silent wrong answers.
- **Plain-language first.** When explaining technical decisions or options, lead with a simple real-world summary before diving into code details. The user thinks in terms of doors, leaves, and hardware — not TypeScript types and Python dictionaries. Example: say "each leaf gets its own exit device" before explaining install_scope taxonomy mismatches.
- **Keep UI status clean.** Progress/loader messages should be short and ambient (under ~40 chars). Never dump raw extraction data (set IDs, door number lists, page ranges) into visual components. Debug info goes in console logs.
- **Propagate-edit pattern.** When a user corrects one item, check for matching items across openings and offer to propagate the fix.

## Git Operations

Git operations run directly in the working directory. See CLAUDE.md for git identity config and branch conventions.

## Session Discipline

- Each session should produce either (a) merged code with a test, or (b) a single focused prompt that will produce merged code.
- If a session only produced documents and no code, flag that as a problem in the audit log.
- Clean up at end of session: archive stale files, remove loose artifacts from repo root.

## Tracking Items (cross-session state)

All plan items, session logs, and metric runs live in the `tracking_items` Supabase table. Read at session start, update at session end. The three legacy Smartsheet sheets (4722023373688708, 1895373728599940, 2206493777547140) are **retired** — do not read from or write to them.

**CLI** (requires `.env.local` with `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`):

```
npm run tracking -- list                              # all items
npm run tracking -- list --type plan_item --status Open  # open plan items only
npm run tracking -- add-item --title "..." --priority "P2 - Medium" --area "API" --description "..."
npm run tracking -- update-item <uuid> --status Done --resolved-pr 110
npm run tracking -- add-session --session-id S-087 --topics "..." --status complete
npm run tracking -- add-metric --session-id S-087 --pdf small.pdf --doors-exp 104 --doors-ext 104
```

**Fallback** (cloud sandbox without `.env.local`): ask user for `/admin/tracking` paste, or compose SQL for Supabase Studio.

See CLAUDE.md "Session Protocol" for the full read/write rules.

## Output Transparency (MANDATORY)

End every response with a clear status block:

```
DONE: [what was actually changed and verified]
PLANNED (not done): [what was discussed but not yet implemented]
NOTICED BUT DID NOT TOUCH: [issues seen but out of scope — or "None"]
SHADOW CHANGES: [any unrequested changes made — or "None"]
```

- Use past tense ONLY for completed work. Use future tense for plans.
- Never silently fix issues you weren't asked about. Report them, then ask.
- If zero files changed, say "No files were modified."
- Commit messages describe ONLY what the commit contains — not future plans.
