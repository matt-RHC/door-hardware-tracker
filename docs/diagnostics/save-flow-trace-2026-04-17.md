# Radius DC "double structural rows" save-flow trace — 2026-04-17

## Root-cause statement

I **could not narrow the mechanism to a single file:line with certainty from
static code alone**. The current `buildPerOpeningItems` (single, clean call
path from `save/route.ts:193`) cannot by itself emit the observed 2× Door /
2× Frame pattern with continuous `sort_order` 0..N in one staging_opening_id.
That means one of two things must also be true at runtime, and the data
needed to disambiguate is the actual request payload captured on the next
prod save (`DHT_LOG_SAVE_PAYLOAD=1` added — see Appendix C).

Top two candidates, evidence-ranked:

1. **`src/lib/parse-pdf-helpers.ts:2774–2854` — `hwSet.items` contains
   "Door" and/or "Frame" rows emitted upstream by Python
   (`api/extract-tables.py`).** The NON_HARDWARE_PATTERN filter at
   `api/extract-tables.py:1226–1235` only rejects `Single Door` / `Pair
   Doors` / `Opening` / `Properties:` / `Notes:` / `Description:`, NOT the
   bare tokens `Door` or `Frame`. If Python's table parse on the Radius DC
   PDF keeps a row named exactly `Door` and another named `Frame` inside a
   set's items list, `buildPerOpeningItems` will emit:
   * `Door` (structural, sort 0) + `Frame` (structural, sort 1), then
   * `Door` (item, sort 2) + `Frame` (item, sort 3) + real items (sort 4+).
   That exactly matches the observed single-leaf pattern. The pair pattern
   differs in order (bare `Door` appears *before* the leaf-named rows),
   which argues either against this theory OR for a second
   emission path — see candidate 2.

2. **A second invocation of `buildPerOpeningItems` / a second writer is
   running for the same staging_opening_id with isPair computed
   differently between the two emissions.** The pair-case ordering
   (bare `Door` + `Frame` at sorts 0–1, then `Door (Active Leaf)` +
   `Door (Inactive Leaf)` + `Frame` at sorts 2–4) is the unique
   fingerprint of two emissions running under a SHARED `sortOrder`
   counter: one treating isPair=false, one treating isPair=true. Nothing
   in the HEAD code does this, so the candidate mechanisms are:
   * A deployed version of `save/route.ts` or
     `src/lib/parse-pdf-helpers.ts:2703–2860` that differs from HEAD
     (e.g., an older build where the if/else on isPair was rewritten to
     two separate `if`s, or where `sortOrder` was hoisted above the
     `for (const opening …)` loop). Git log for these files is shallow
     (7 commits total, first is `f00ff54`) so no older branch exists in
     repo history — but Vercel may have cached a build that pre-dates
     the current code. Confirm by hitting the
     deployed version of the repo SHA (no `/api/version` endpoint exists —
     candidate follow-up).
   * A partial/retried insert at `src/app/api/parse-pdf/save/route.ts:
     231–251` where the first chunk insert commits but returns an
     error (e.g. RLS-on-RETURNING), the retry inserts the same chunk
     again, and the user's interpretation of "continuous 0..N" in the
     prompt is loose (the DB actually has DUPLICATE sort_order values,
     not continuous ones). Worth checking by selecting distinct
     sort_order counts per staging_opening_id in the actual DB.

Capture the real payload via `DHT_LOG_SAVE_PAYLOAD=1` and re-run
`src/lib/__diagnostics__/repro-double-structural.test.ts` — the test
isolates candidate 1 (bad Python-side items) from candidate 2 (a
double-writer outside `buildPerOpeningItems`).

---

## 1. Full save-flow call graph (`StepConfirm` → `staging_hardware_items`)

1. **User clicks `Save`** in StepConfirm.
   `src/components/ImportWizard/StepConfirm.tsx:487` →
   `onNext={handleSave}`.

2. **`handleSave` fires once** per click (no useEffect, no StrictMode,
   no React Query). `src/components/ImportWizard/StepConfirm.tsx:112–175`.

3. **Single `fetch` to `/api/parse-pdf/save`** with body
   `{ projectId, hardwareSets, doors }`.
   `src/components/ImportWizard/StepConfirm.tsx:122–130`.
   (A second call site exists at line 186 — `handleRetryPromotion` —
   fires only when the first response reports `partial=true` or
   promotion failed.)

4. **Next.js App Router route handler** — `POST /api/parse-pdf/save`.
   `src/app/api/parse-pdf/save/route.ts:41–346`. One handler invocation
   per request.
    * Auth + project-member checks at lines 44–69.
    * Zod-validates the body via `ParsePdfSaveRequestSchema`, line 50.
    * Builds `setMap` / `doorToSetMap` (lines 73–76).
    * Filters orphan doors via `wouldProduceZeroItems`, line 120–137.
    * Builds `doorInfoMap` (lines 140–146).
    * **Creates the extraction run** via
      `createExtractionRun(supabase, { extractionMethod: 'pdfplumber', … })`
      at `src/app/api/parse-pdf/save/route.ts:149–153` →
      `src/lib/extraction-staging.ts:82–104` (a simple INSERT into
      `extraction_runs`).
    * Maps `activeDoors` → `stagingOpenings[]` (lines 156–177) and
      stamps `leaf_count` via `detectIsPair()`.
    * **Calls `writeStagingData(runId, projectId, stagingOpenings, [])`**
      at `src/app/api/parse-pdf/save/route.ts:180` →
      `src/lib/extraction-staging.ts:146–222`. The `[]` for
      `hardwareSets` means the payload items array is empty per-opening
      (line 174: `items = (hwSet?.items ?? []).map(...)`, and
      `hwSet` is always undefined for an empty set map).
    * **Invokes the `write_staging_data` RPC** at
      `src/lib/extraction-staging.ts:207`.
      RPC body lives in
      `supabase/migrations/023_create_write_staging_data_rpc.sql:17–144`
      (identical to the version defined in migration 021). Per
      opening, it INSERTs one `staging_openings` row (lines 71–98)
      and — *only if the payload's nested `items` array is non-empty*
      (line 103) — inserts `staging_hardware_items` rows. Because
      save passes `[]` for hardwareSets, no items are inserted here.
    * **Queries back `staging_openings`** by `extraction_run_id` at
      `src/app/api/parse-pdf/save/route.ts:183–186`.
    * **Calls `buildPerOpeningItems(stagingOpeningRows, doorInfoMap,
      setMap, doorToSetMap, 'staging_opening_id', { extraction_run_id:
      runId })`** at
      `src/app/api/parse-pdf/save/route.ts:193–200` →
      `src/lib/parse-pdf-helpers.ts:2703–2860`. This is the **only**
      place structural Door / Frame rows are constructed in the save
      path. The function:
      * resets `sortOrder = 0` per opening (line 2714),
      * emits `Door (Active Leaf)` + `Door (Inactive Leaf)` **or** `Door`
        (mutually exclusive, lines 2740–2747),
      * emits `Frame` exactly once (lines 2751–2754),
      * emits set items with electric-hinge / hinge-split logic
        (lines 2774–2854).
    * Defensive zero-item check at lines 206–224 (would 500-out if an
      opening got 0 rows — not the path here).
    * **Chunk-inserts into `staging_hardware_items`** at
      `src/app/api/parse-pdf/save/route.ts:229–251`. Each chunk is
      inserted via
      `(supabase as any).from('staging_hardware_items').insert(chunk).select('id')`
      and **retried once** on any error (lines 237–243). This is the
      only place rows land in `staging_hardware_items` for a
      pdfplumber-method run.
    * Updates extraction_run status to `reviewing` at line 254.
    * **Calls `promoteExtraction(supabase, runId, user.id)`** at
      `src/app/api/parse-pdf/save/route.ts:287` →
      `src/lib/extraction-staging.ts:226–270`.
      Invokes the `merge_extraction` RPC at line 243.
    * `merge_extraction` lives at
      `supabase/migrations/037_merge_extraction_report_orphans.sql:19–206`
      (supersedes 034 and 025). It iterates `staging_openings` by
      `extraction_run_id`, DELETEs any prod `hardware_items` when the
      name/qty signature differs, then INSERTs 1:1 from
      `staging_hardware_items` (preserving `sort_order`, `leaf_side`).
    * Writes activity log and returns success (lines 311–340).

There is **no** middleware, interceptor, retry wrapper, React Query
mutation, or tRPC layer between the wizard and the save route. The wizard
issues a bare `fetch`. The route handler is invoked once per HTTP POST.

---

## Appendix A — Enumerated writers to `staging_hardware_items` / `hardware_items`

### `staging_hardware_items` writers (TS + SQL)

| Site | Trigger | Condition |
|---|---|---|
| `src/app/api/parse-pdf/save/route.ts:232` (+ retry at `:240`) | User clicks Save in StepConfirm | Per-chunk INSERT, once per save call (retried once on error). |
| `src/app/api/jobs/[id]/run/route.ts:1292` | Background job orchestrator | `extractionMethod='background_job'`. Radius DC run is `pdfplumber` → **ruled out**. |
| `supabase/migrations/023_create_write_staging_data_rpc.sql:106` (RPC `write_staging_data`) | Called from `writeStagingData()` in save & job routes | Only fires if payload's nested `items` array has entries. Save passes `[]` → no rows here. |
| `supabase/migrations/021_merge_extraction_and_staging_tx.sql:357` | Superseded by RPC in 023 | No longer active in prod after 023 applied. |

### `hardware_items` writers (TS + SQL)

| Site | Trigger | Condition |
|---|---|---|
| `supabase/migrations/037_merge_extraction_report_orphans.sql:133, 168` (RPC `merge_extraction`) | `promoteExtraction()` from save / apply-revision / jobs | 1:1 copy from `staging_hardware_items` (preserves `sort_order`). |
| `src/app/api/parse-pdf/apply-revision/route.ts:223` | StepCompare "Apply" on a project that already has openings | Only runs when `hasExistingData=true`. Radius DC was fresh → **ruled out** unless the wizard was re-opened after the initial promote. |
| `src/app/api/parse-pdf/apply-revision/route.ts:283` | StepCompare "Apply" — NEW doors branch | Same gating as above. |
| `supabase/migrations/010_openings_pdf_page.sql:104` (RPC `promote_extraction`) | Superseded by `merge_extraction` | Inactive. |
| `supabase/migrations/025_create_merge_extraction_rpc.sql:106, 141` | Superseded by 034/037 | Inactive once 037 applied. |
| `supabase/migrations/034_bugfixes_merge_and_rls.sql:115, 150` | Superseded by 037 | Inactive once 037 applied. |
| `supabase/migrations/012_pair_leaf_support.sql:117`, `013_hardware_leaf_side.sql:150`, `016_security_and_rls_fixes.sql:275`, `007_extraction_staging.sql:263` | Legacy migration inserts, historical | Inactive. |

No Supabase Edge Functions exist (`supabase/functions/` absent). No
Python writers: `api/extract-tables.py` never touches either table
(`grep` confirms only `deduplicate_hardware_items` / `filter_non_hardware_items`
operating on in-memory Python lists). No scheduled jobs write directly.

The only *active* writers in the Radius DC path are:
* `src/app/api/parse-pdf/save/route.ts:232` / `:240` (chunk insert + retry)
* `supabase/migrations/037_…merge_extraction.sql:133,168` (promote copy)

---

## Appendix B — Double-invocation checks (client-side)

* **StrictMode** — no `StrictMode` wrapping anywhere in the tree
  (`grep -rn 'StrictMode\|reactStrictMode'` returns only one comment in
  `StepTriage.tsx:782` — not a wrap). `next.config.ts` has no
  `reactStrictMode` key; Next 16 defaults do not double-fire fetches in
  prod.
* **useEffect** — `handleSave` is NOT inside a `useEffect`; it's wired
  only through `onNext={handleSave}` on the wizard nav button
  (`src/components/ImportWizard/StepConfirm.tsx:487`,
  `src/components/ImportWizard/WizardNav.tsx:13,29,72`).
* **React Query / SWR / retry wrappers** — none are used; every API
  call in the wizard is a direct `fetch()`.
  (`grep -rn 'fetch(' src/components/ImportWizard` confirms 20+ raw
  fetches, no wrapper.)
* **Retry handler** — `handleRetryPromotion` at
  `src/components/ImportWizard/StepConfirm.tsx:181–237` does POST
  `/api/parse-pdf/save` a *second* time with the same body, but only
  after the user clicks the "Retry Promotion" button on the failed-state
  view. Each call creates a new `extraction_runs` row; they do not share
  a `staging_opening_id`, so by itself this cannot produce the observed
  continuous `sort_order` within one staging_opening.
* **`/api/parse-pdf/compare`** — read-only, no INSERTs
  (`src/app/api/parse-pdf/compare/route.ts:41–261`). Fires from
  `StepCompare` which is only rendered when `hasExistingData=true`
  (`src/components/ImportWizard/ImportWizard.tsx:439,517`). Fresh
  project → Compare step is skipped entirely.
* **`/api/parse-pdf/apply-revision`** — inserts to `hardware_items` but
  only runs from `StepCompare`'s "Apply" button, which is likewise gated
  on `hasExistingData=true`.

---

## Appendix C — Deployed-version verification

* `package.json` has no deploy-SHA injection; version string is
  `"0.1.0"`.
* No `/api/version` route exists. `/api/health` returns `{ ok, timestamp }`
  only (`src/app/api/health/route.ts:1–6`).
* Git log for save-critical files since 2026-04-07 (repo first commit is
  `f00ff54` on 2026-04-16):

  | SHA | Date | Touches | Short summary |
  |---|---|---|---|
  | `f00ff54` | 2026-04-16 10:05 | initial commit (adds `save/route.ts`, `parse-pdf-helpers.ts`, `extraction-staging.ts`, `apply-revision/route.ts`, migrations up to 034) | three-bug fix set (classify-pages, parse-email, dashboard) |
  | `70bb307` | 2026-04-16 07:16 | `parse-pdf-helpers.ts` (`applyCorrections` only — Darrin qty validation) | 7 bugs incl. `merge_extraction` NULL guard (migration 034) |
  | `3c50f15` | 2026-04-16 | `parse-pdf-helpers.ts` (wall-clock guard, not `buildPerOpeningItems`) | vision wall-clock |
  | `d6ad714` | 2026-04-16 | `parse-pdf-helpers.ts` (VISION_WALL_CLOCK_LIMIT_MS dup removal) | CI repair |
  | `4b6d91a` | 2026-04-16 | mass rename Punchy→Darrin, touches helpers / save route imports only | rename |
  | `dc1fd59` | 2026-04-16 | helpers + types, migration 035 | punchy_logs → darrin_logs |
  | `fe215f9` | 2026-04-16 15:25 | `save/route.ts`, `parse-pdf-helpers.ts`, `StepConfirm.tsx`, migration 037 | `wouldProduceZeroItems` + orphan-doors reporting |
  | `736ed03` | 2026-04-16 | `save/route.ts` (orphan filter + triage UX) | orphan filtering (superseded by fe215f9) |
  | `6d44efb` | 2026-04-16 | `save/route.ts` Zod validation | Zod schema |
  | `9c1b5df` | 2026-04-16 | `StepConfirm.tsx` (Darrin + retry buttons) | promotion retry UX added here |
  | `6025e37` | 2026-04-16 17:34 | wizard transforms dedup, migration renumber | Phase 2 close-out |

* `git blame src/lib/parse-pdf-helpers.ts -L 2703,2760` → all lines
  authored by `f00ff54`. The `buildPerOpeningItems` body on HEAD has
  not been touched since the repo was seeded. No commit has reverted
  the isPair if/else into a double-emit pattern; no commit has hoisted
  `sortOrder` above the opening loop.

To verify the deployed bundle matches HEAD, the follow-up is to hit the
Vercel dashboard for project deploy history around 2026-04-17 03:58 UTC
and match the deploy SHA. No programmatic way to do that from the repo.

---

## Appendix D — Reproduction harness

Regression gate lives at
`src/lib/__diagnostics__/repro-double-structural.test.ts`. It:

* Loads the captured POST `/api/parse-pdf/save` body from
  `DHT_RADIUS_DC_PAYLOAD=/path/to/file.json` if the env var points to an
  existing file; otherwise falls back to a synthetic Radius-DC-shaped
  fixture (one AD11-IS single + one DH1-10 pair, with `door_type` /
  `frame_type` populated exactly as the bug preconditions require).
* Passes the payload through `buildPerOpeningItems` using the same
  argument shape `save/route.ts:193` uses at runtime.
* Asserts three invariants per opening:
  1. `bareDoor + activeLeaf + inactiveLeaf ≤ 2`; bare `Door` never
     coexists with leaf names on the same opening; pairs have exactly
     one active + one inactive and no bare `Door`.
  2. `sort_order` is strictly increasing 0..N with no gaps and no
     duplicates inside any one `staging_opening_id`.
  3. Explicit "no 2× bare Door" gate (same assertion, separately worded
     for readability).

The test is **green on HEAD against the synthetic fixture** (proving the
helper is clean when the payload is clean). It will flip **red** when
the real Radius DC payload is fed to it IF the bug is a payload-shape
issue (candidate 1 above). If the real payload also produces a clean
output, the bug is outside the helper and candidate 2 is the true path —
check the retry block at `save/route.ts:237–243`, multiple promotes, or
a mismatch between the deployed bundle and HEAD.

### Capturing the real payload

`src/app/api/parse-pdf/save/route.ts:50–59` now contains a guarded
diagnostic:

```ts
if (process.env.DHT_LOG_SAVE_PAYLOAD === '1') {
  console.log('[save][DHT_LOG_SAVE_PAYLOAD]', JSON.stringify({ projectId, hardwareSets, doors }))
}
```

To capture:

1. Set `DHT_LOG_SAVE_PAYLOAD=1` in Vercel env for preview/prod
   (**not** as a durable always-on value — flip it off once captured).
2. Re-save a Radius DC PDF through the wizard.
3. Pull the matching log line from Vercel.
4. Save to a local JSON file (`{ projectId, hardwareSets, doors }`).
5. Run: `DHT_RADIUS_DC_PAYLOAD=/abs/path/to/capture.json npx vitest run src/lib/__diagnostics__/repro-double-structural.test.ts`.
6. Unset `DHT_LOG_SAVE_PAYLOAD` once the capture is in hand.
