# Background Job Implementation Log

Tracks decisions, issues, and deviations for the background extraction job feature.

## Phase 1 — Backend Infrastructure

### Decisions

1. **Direct helper imports vs API route calls**: The job orchestrator (`/api/jobs/[id]/run`) imports and calls helper functions directly (`callPdfplumber`, `callPunchyColumnReview`, `callPunchyPostExtraction`, etc.) rather than fetching the existing Next.js API routes. This avoids unnecessary HTTP overhead, auth round-trips, and request size limits for server-to-server calls.

2. **Python API calls via fetch**: The Python endpoints (`classify-pages`, `detect-mapping`, `extract-tables`) are called via direct fetch with `X-Internal-Token` auth, matching the pattern used by existing proxy routes but skipping the user-auth layer since the job runs with service role credentials.

3. **Triage logic duplicated (not imported)**: The triage system prompt and LLM call logic is replicated in the orchestrator rather than extracted into a shared function from `triage/route.ts`. This is intentional — the triage route is a thin API handler with response formatting, and extracting its core would require refactoring the existing route. Revisit in Phase 2 if drift becomes a maintenance concern.

4. **Atomic job claim**: The orchestrator uses `UPDATE ... WHERE status='queued' RETURNING *` to atomically claim a job, preventing double-processing if the cron handler and fire-and-forget both attempt to run the same job.

5. **Deep extraction skipped in Phase 1**: The background job does not run deep extraction for empty hardware sets. Deep extraction is an interactive feature (user provides hints, confirms golden samples) that requires the Punchy Review UI. In Phase 1, empty sets are left as-is in staging data. Phase 2 UI will provide the ability to trigger deep extraction post-job.

6. **Column mapping from detect-mapping**: Since Phase 1 skips the MapColumns UI step, the job uses the raw detect-mapping result as the column mapping. The wizard allows users to adjust this mapping — background jobs use the auto-detected mapping as-is.

7. **Cron safety net**: `process-jobs` cron runs every 2 minutes and picks up jobs stuck in 'queued' for >30 seconds. Limited to 5 jobs per tick to avoid thundering herd.

### Deviations from Scope

- **No `validating` phase used yet**: The status enum includes 'validating' for future use when user constraint answers are applied post-triage. In Phase 1, user hints are read at triage time but no separate validation pass exists.
- **Staging data not promoted**: The job writes staging data but does NOT call `promoteExtraction()`. Promotion happens when the user reviews and confirms in the wizard (unchanged from current flow). The job creates the extraction run and staging data so it's ready for review.

### Issues Encountered

(None yet — this section will be updated as issues arise during testing.)

### Future Phases

- **Phase 3**: Email notifications on completion, batch import support
- **Phase 4**: Job cancellation, retry logic, priority queue

---

## Phase 2 — Wizard UI Refactor + Guided Questions

### Decisions

1. **Feature flag approach**: Simple env var + query param check (`NEXT_PUBLIC_USE_JOB_WIZARD=true` or `?jobWizard=true`). No external feature flag service — this is a lightweight toggle that can be removed once the new flow is stable. The `useJobWizardEnabled()` helper lives in `src/lib/feature-flags.ts` and is called once at the top of ImportWizard.

2. **Separate step enum for job flow**: Added `JobWizardStep` enum (Upload=0, Questions=1, Review=2, Products=3, Compare=4, Confirm=5) alongside the existing `WizardStep`. This avoids modifying the existing enum values which could break the old flow's step comparisons and navigation.

3. **Early return pattern in ImportWizard**: When the feature flag is on, the component returns early with the job wizard JSX. When off, it falls through to the original render block — zero changes to the legacy flow. This pattern is simpler and more auditable than deeply interleaving conditionals.

4. **PunchAssistant omitted from job flow**: The new Questions step replaces the Punchy-driven triage questions. The PunchAssistant drawer is not shown during the job flow since the guided questions serve the same purpose in a more structured format. The Review/Products/Confirm steps inherit the same PunchAssistant behavior if needed in a future iteration.

5. **StepUpload reused as-is**: The Upload step is identical in both flows. In the job flow, `onComplete` fires `job.createJob()` after upload finishes instead of advancing to ScanResults. StepUpload still runs classify-pages and uploads the PDF — the background job reads the stored PDF from the same storage path.

6. **useExtractionJob hook**: Polls every 2 seconds (matching spec's "every 2 seconds" requirement). Uses `setInterval` with cleanup on unmount. Transient poll errors are logged but don't stop polling — the interval retries automatically. Terminal statuses (completed, failed, cancelled) stop polling.

7. **Debounced answer saving**: Question answers are auto-saved with a 1.5-second debounce to avoid spamming the server on every keystroke. A final flush happens when the user clicks "Continue to Review".

8. **Back from Questions goes to Upload**: Going back from the Questions step returns to Upload. Since the job may already be running, re-uploading will create a new job. The old job is left in whatever state it's in (no cancellation implemented yet — Phase 4).

### Deviations from Scope

- **No Punchy avatar**: The spec suggested showing a Punchy avatar near the progress indicator. This was deferred to avoid adding new image assets in this PR. The gear icon with pulse animation serves as the working indicator.
- **No success animation**: The spec mentioned a "success animation/indicator" when the job completes. The progress bar turning green and the checkmark icon serve this purpose without adding a separate animation system.
- **onRemapColumns not available in job flow**: The Review step in the job flow doesn't offer "Remap Columns" since column mapping was done automatically by the background job. The prop is omitted.

### Files Added

- `src/lib/feature-flags.ts` — Feature flag utility
- `src/hooks/useExtractionJob.ts` — Job lifecycle hook (create, poll, submit answers, fetch results)
- `src/components/ImportWizard/StepQuestions.tsx` — Guided questions UI + progress indicator

### Files Modified

- `src/components/ImportWizard/types.ts` — Added `JobWizardStep` enum, `JobStatus`, `JobStatusResponse`, `JobResultsResponse` types
- `src/components/ImportWizard/ImportWizard.tsx` — Added job wizard flow with feature flag gate, `JobStepIndicator`, job flow callbacks

---

## P0 UX Fixes — Confirmation Dialogs & Chunk Failure Visibility

### Decisions

1. **Custom modals over native confirm()**: All confirmation dialogs use the project's existing inline modal pattern (`useState` + conditional render + `fixed inset-0` overlay) rather than `window.confirm()`. This keeps the UX consistent with the dark theme, allows richer content (itemized change summaries), and enables destructive-action styling (red confirm buttons via `glow-btn--danger`).

2. **Apply Revision confirmation (StepCompare)**: The modal itemizes adds, deletes, and modifications with counts derived from the existing `compareResult` state — no additional API calls needed. The confirm button is styled as destructive (red) to visually distinguish it from the regular "Next" button.

3. **Close confirmation (ImportWizard)**: Both the job wizard and legacy wizard close buttons now check `hasUnsavedProgress` (whether the user is past the Upload step). On step 1 with no data loaded, close fires immediately. A `beforeunload` handler is registered when `hasUnsavedProgress` is true, providing a browser-native backup for tab closes and navigation.

4. **Chunk failure tracking (StepTriage)**: Failed chunk indices and error messages are stored in component state (`failedChunks`). A warning banner is displayed after extraction completes with failures, and a retry button re-runs only the failed chunks using stored chunk data (`chunksRef`). Successfully retried chunks are merged into the existing door/set state via `mergeDoors`/`mergeHardwareSets`.

5. **Partial-success response (save/route.ts)**: The save endpoint now returns `{ partial: true, failedChunks, savedCount, expectedCount }` when staging item inserts partially fail. The response shape is backwards-compatible — `partial` defaults to `false`/`undefined` on full success. StepConfirm surfaces a "Partial Save" warning banner when present.

6. **Job orchestrator chunk tracking (jobs/[id]/run/route.ts)**: The `failedChunks` array is hoisted to the outer scope (accessible for both chunked and single-shot paths). Failed chunks are included in `extraction_summary.failedChunks` and `extraction_summary.partial = true` so downstream consumers (StepQuestions progress, future monitoring) can surface warnings.

### Files Modified

- `src/components/ImportWizard/StepCompare.tsx` — Added `showApplyConfirm` state + confirmation modal with itemized change summary
- `src/components/ImportWizard/ImportWizard.tsx` — Added `showCloseConfirm` state, `handleCloseAttempt`, `beforeunload` handler, close confirmation modals (both wizard paths)
- `src/components/ImportWizard/StepTriage.tsx` — Added `failedChunks`/`totalChunks`/`retryingChunks` state, chunk failure tracking in extraction loop, warning banner with retry button, `retryFailedChunks` callback
- `src/components/ImportWizard/StepConfirm.tsx` — Extended `saveResult` type with `partial`/`failedChunks`/`expectedItemsCount`, added partial-save warning banner
- `src/app/api/parse-pdf/save/route.ts` — Track `failedItemChunks` during staged item inserts, return `partial`/`failedChunks`/`expectedItemsCount` in response
- `src/app/api/jobs/[id]/run/route.ts` — Hoisted `failedChunks` to outer scope, track chunk failures, include in `extraction_summary`

---

## Security Hardening — P0 Fixes (2026-04-13)

### Decisions

1. **Storage RLS project scoping (§7.1)**: Storage bucket policies for `attachments` and `submittals` previously only checked `auth.role() = 'authenticated'`, allowing any authenticated user to read/modify/delete files from any project. Migration 020 drops all old policies and replaces them with project-scoped policies that extract the `project_id` from the first path segment (`storage.foldername(name)[1]`) and verify membership via `project_members`. Uses `(select auth.uid())` for single-evaluation per query.

2. **Internal auth header swap (§7.2)**: Fire-and-forget calls from `/api/jobs` and `/api/cron/process-jobs` to `/api/jobs/[id]/run` previously sent `SUPABASE_SERVICE_ROLE_KEY` as an `x-service-role` header — if the URL were misconfigured, the key would leak to an unintended recipient. Replaced with `x-internal-secret` header carrying `CRON_SECRET` (a lower-privilege secret that already existed for cron auth). The run route still creates its own admin Supabase client internally via `createAdminSupabaseClient()`, so DB access is unaffected.

3. **Python default-deny (§7.3)**: The `require_internal_token()` functions in `classify-pages.py`, `detect-mapping.py`, and `extract-tables.py` previously returned `True` (allow) when `PYTHON_INTERNAL_SECRET` was unset, meaning a misconfigured deployment would serve endpoints without authentication. Changed to return 401 with `{"error": "Internal secret not configured"}` when the env var is missing — fail-closed instead of fail-open.
