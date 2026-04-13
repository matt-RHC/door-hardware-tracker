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

---

## Data Integrity — P0 Fixes (2026-04-13)

### Decisions

1. **Merge-based promote replaces destructive delete (§4.1)**: `promote_extraction()` did `DELETE FROM openings WHERE project_id = ?` before inserting, cascading to destroy all `hardware_items`, `checklist_progress`, and `attachments`. New `merge_extraction()` function matches staging doors to production by `door_number` and applies a 4-way merge: unchanged doors are left untouched (preserving all checklist progress and attachments), changed doors get metadata + hardware updated (checklist progress resets due to CASCADE on hardware_items FK — acceptable since hardware changed), new doors are inserted, and removed doors are soft-deleted via `is_active = false` rather than hard-deleted. Hardware change detection uses sorted `name:qty` signature comparison.

2. **Soft-delete over hard-delete for removed doors**: Added `is_active BOOLEAN DEFAULT true` to `openings`. Doors present in production but absent from a new extraction are set `is_active = false` instead of deleted. This preserves their checklist history and attachments for audit purposes. An index on `(project_id) WHERE is_active = true` supports efficient queries.

3. **Old promote_extraction() retained but unused**: The original `promote_extraction()` function is not dropped — it remains in the database for rollback safety. The TypeScript client now calls `merge_extraction` instead. Can be dropped in a future migration once merge is validated in production.

4. **Transactional staging writes (§2.1)**: `writeStagingData()` previously inserted staging_openings and staging_hardware_items in separate HTTP-level chunks. If openings succeeded but items failed, orphaned staging rows resulted (migration 018 was the cleanup). New `write_staging_data()` RPC accepts the full payload as JSONB and writes everything in a single database transaction — any failure rolls back all inserts.

5. **Client-side set mapping preserved**: The hardware-set-to-opening matching logic (setMap, doorToSetMap, normalizeDoor) stays in the TypeScript client. The RPC receives pre-matched openings with their items array, keeping the PL/pgSQL focused on transactional writes rather than duplicating complex matching logic.

6. **Save route item insertion not migrated**: The `/api/parse-pdf/save` route uses a different pattern — it calls `writeStagingData()` with empty hardwareSets then does its own item insertion via `buildPerOpeningItems()`. That route's item chunks are still non-transactional. This is a known limitation tracked separately — the save route is the legacy wizard path and will be migrated to the transactional RPC in a follow-up.

### Files Added

- `supabase/migrations/021_merge_extraction_and_staging_tx.sql` — `merge_extraction()`, `write_staging_data()` RPCs, `is_active` column on openings

### Files Modified

- `src/lib/extraction-staging.ts` — `promoteExtraction()` calls `merge_extraction`, `writeStagingData()` calls `write_staging_data` RPC
- `src/lib/types/database.ts` — Added `merge_extraction` and `write_staging_data` function types

---

## Hinge Duplication Regression + Triage Retry + Error Cleanup (2026-04-13)

### Decisions

1. **Hinge consolidation in normalizeQuantities**: PDFs often list "4 Hinges" (total) and "1 Electric Hinge" separately for the same door. After per-leaf/per-opening normalization, both appear as independent line items, totaling 5 (incorrect). Per DHI/BHMA standards, the electric hinge replaces one standard hinge position: 3 standard + 1 electric = 4 total. A post-normalization consolidation step now subtracts electric hinge qty from standard hinge qty within the same hardware set. Guards ensure the result stays >= 1 and the standard qty is greater than the electric qty.

2. **Triage application-level retry**: The Anthropic SDK retries 4x internally with exponential backoff on 429/5xx. For persistent `overloaded_error` (529) conditions, the triage route and job orchestrator now wrap the SDK call in an additional retry loop: SDK retries (4x fast) → 30s wait → SDK retries (4x) → 60s wait → SDK retries (4x). Only retryable errors (529 overloaded, 429 rate limit) trigger the application-level retry; permanent failures break immediately.

3. **Clean error messages**: The triage route error handler was returning raw `llmError.message` which often contained the full Anthropic SDK JSON body (`{"type":"error","error":{"details":null,...}}`). A `cleanTriageErrorMessage()` helper now maps error types to user-facing messages. The `retryable` flag is included in the response so the frontend can offer a "Retry Classification" button.

4. **Retry pattern duplicated (not shared)**: The retry helpers (`isRetryableError`, `cleanTriageErrorMessage`, `sleep`, `APP_RETRY_DELAYS_MS`) are defined separately in both the triage route and the job orchestrator. This matches the existing pattern (decision #3 from Phase 1) where triage logic is intentionally duplicated to keep each file self-contained. Both files use identical retry delays and error classification logic.

5. **Job status update during triage retry**: The job orchestrator's `runTriage` accepts an optional `onStatusUpdate` callback. During retry waits, the job status is updated to "Triaging (retrying after Ns wait...)" so the user sees progress in the job monitoring UI rather than a stalled status.

### Files Modified

- `src/lib/parse-pdf-helpers.ts` — Added hinge consolidation step in `normalizeQuantities`; imported `classifyItem` from hardware-taxonomy
- `src/lib/parse-pdf-helpers.test.ts` — Added 4 hinge consolidation tests
- `src/app/api/parse-pdf/triage/route.ts` — Added retry loop, `isRetryableError`, `cleanTriageErrorMessage`, `retryable` flag in error response
- `src/app/api/jobs/[id]/run/route.ts` — Added retry loop in `runTriage`, status update callback during retry waits
- `src/components/ImportWizard/types.ts` — Added `retryable` to `TriageResult`
- `src/components/ImportWizard/StepTriage.tsx` — Added "Retry Classification" button when `retryable` is true, displays clean error message
