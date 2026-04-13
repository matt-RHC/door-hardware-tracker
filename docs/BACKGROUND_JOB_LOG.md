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

- **Phase 2**: UI integration — polling UI, guided questions during job execution, results review
- **Phase 3**: Email notifications on completion, batch import support
- **Phase 4**: Job cancellation, retry logic, priority queue
