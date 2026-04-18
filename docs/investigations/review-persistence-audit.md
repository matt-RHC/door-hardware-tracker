# Review Page – Persistence Audit

**Date:** 2026-04-17  
**Scope:** Two suspected persistence gaps on the Review (Phase 3) page of the Import Wizard.  
**Method:** Static code analysis only – no code changes, no runtime tests.

---

## A) Apply-to-doors flow

### Component map

The "Fix missing field" surface exists in two forms with different code paths:

| Trigger | Component | Handler | Path label |
|---------|-----------|---------|------------|
| Set-header "Fix missing field" button (set view) | `SetView.tsx` → `StepReview.tsx` | `handleBatchFixMissing` | **Tier-1** |
| Per-door "Fix" button → draw-a-region modal | `InlineRescan.tsx` → `FieldAssignmentPanel.tsx` | `handleFieldConfirm` | **Tier-2** |

The toast `"Fixed location for 1 door"` comes exclusively from the **Tier-2** path (confirmed: `InlineRescan.tsx:231-234`).

---

### Tier-2 path (manual region scan) – detailed trace

```
[FieldAssignmentPanel] "Apply to N doors" button
  → handleConfirm()                            FieldAssignmentPanel.tsx:112-116
    → onConfirm(field, value, doorNumbers)

[InlineRescan] handleFieldConfirm              InlineRescan.tsx:228-238
  1. onFieldApply(field, value, doorNumbers)   ← calls setDoors (client state)
  2. showToast("success", "Fixed …")           ← fires unconditionally
  3. onClose()                                 ← modal closes

[StepReview] handleFieldApplyWithPropagation   StepReview.tsx:529-607
  → handleFieldApply(field, value, doorNumbers)
    → setDoors(prev => applyFieldToDoors(prev, …))   StepReview.tsx:524
                                               ← ONLY a React state update, no DB write
  → (fire-and-forget) POST /api/parse-pdf/region-extract
       propagate=true, to scan sibling doors
       result populates PropagationSuggestionModal
```

**Is the update optimistic?**  
Technically yes, but there is no server state to be "optimistic against." The field application at this step is **client-state-only**. No row is written to any database table until the user reaches `StepConfirm` and completes the `/api/parse-pdf/save` call.

**Does the toast fire unconditionally?**  
**Confirmed.** The `showToast` call at `InlineRescan.tsx:231-234` fires immediately after the client-side `onFieldApply` returns. There is no await, no try/catch wrapping the toast, and no server acknowledgment. If the later `/api/parse-pdf/save` fails, the toast has long since fired.

The Tier-2 toast fires after a pure in-memory mutation (`applyFieldToDoors` in `rescan-apply.ts:16-33`). That mutation cannot fail, so the toast is technically correct in the narrow sense. The deeper problem is that it implies persistence when no persistence has occurred.

**Does the API return updated rows? Is there a refetch?**  
No. The `region-extract` endpoint (`route.ts:147-163`) returns metadata for the propagation modal (`siblingFills`, `detectedField`, etc.). It does not return door rows and the client does not refetch door state from the database at any point during the wizard. The door list is loaded once from the extraction job results (`ImportWizard.tsx:483-493`) and then lives entirely in React component state for the remainder of the wizard.

---

### Tier-1 path (batch fix) – detailed trace

```
[StepReview] handleBatchFixMissing             StepReview.tsx:430-506
  1. POST /api/parse-pdf/region-extract
       propagate=true, bbox = full page
       targetDoorNumbers = all doors missing any of {location, hand, fire_rating}
  2. Parse siblingFills from response
  3. Build PropagationSuggestion[] for each missing field
  4. setPropagationSuggestions(…)              → opens PropagationSuggestionModal

[PropagationSuggestionModal] "Apply N fixes"   PropagationSuggestionModal.tsx:78-84
  → handleApply()
    → setApplying(true)
    → window.setTimeout(() => onAccept(accepted), 600)   ← 600 ms flash delay

[StepReview] handleAcceptPropagation           StepReview.tsx:610-620
  → setDoors(prev => applyPropagationSuggestions(prev, accepted))
  → setPropagationSuggestions(null)            ← closes modal
```

**Note:** The Tier-1 path has **no toast**. The only feedback is the 600 ms "success" avatar in the modal before it closes. There is no "Fixed location for N doors" message on this path.

---

### Door row visibility after apply

**Does the door row update in the same render?**  

*Hypothesis (unconfirmed – requires runtime observation):* React 18 auto-batches all state updates triggered within a single synchronous event handler chain. `setDoors` (from `handleFieldApply`) and the three `set*` calls in `handleRescanClose` (from `onClose`) are all called synchronously within `handleFieldConfirm`. They should be committed in a single render pass, meaning the door row should reflect the new value after the modal unmounts.

However, there is a **confirmed visual gap**: the `recentlyEdited` flash (a 1.5 s green-tinted background) is only triggered by `commitEdit` at `StepReview.tsx:220`. Neither `handleFieldApply` nor `handleAcceptPropagation` sets `recentlyEdited`. After a rescan apply, the door row value changes silently with no highlight. Users scanning a dense list may not notice the update, making the page feel like it did nothing.

---

### Column selectivity

The `siblingFills` payload from Python is typed as:
```typescript
// region-extract/route.ts:38-47 (PythonRegionResultSchema)
sibling_fills: z.record(
  z.string(),
  z.object({
    location: z.string().default(''),
    hand: z.string().default(''),
    fire_rating: z.string().default(''),
  }),
)
```

The Tier-1 client side explicitly iterates only three fields (`StepReview.tsx:476`):
```typescript
const fieldsToCheck = ['location', 'hand', 'fire_rating'] as const;
```

`applyPropagationSuggestions` in `rescan-apply.ts:50-52` also guards against non-propagatable fields:
```typescript
function isPropagatableField(f): f is PropagatableField {
  return f === "location" || f === "hand" || f === "fire_rating"
}
```

**Confirmed:** Any newly-added door metadata column (e.g., a `leaf` field, a `fire_rating_override`, a custom classification flag) is **invisible to both the Tier-1 and Tier-2 rescan paths**. The Python extractor would need to return the new field in `sibling_fills`, the TypeScript schema would need to accept it, the `isPropagatableField` guard would need updating, and `DoorEntry` would need the field added. All four are currently hardcoded to the three existing fields.

The final `/api/parse-pdf/save` route does SELECT door data but it reads from the wizard's `doors` array (posted as JSON), not from a table, so selectivity there is determined by what `DoorEntry` contains.

---

## B) Page reclassification flow

### Where the "1 change" counter lives

**Confirmed:** The counter is a `useMemo` inside `ClassifyCorrectionPanel`:
```typescript
// ClassifyCorrectionPanel.tsx:166-169
const overrideCount = useMemo(
  () => Array.from(overrides.values()).filter((o) => o.type_override || o.excluded).length,
  [overrides],
)
```

Displayed at `ClassifyCorrectionPanel.tsx:190`:
```tsx
{overrideCount > 0 ? `${overrideCount} change${overrideCount === 1 ? "" : "s"}` : "No changes"}
```

The `overrides` Map is local component state initialized from `initialOverrides` (persisted overrides from the extraction job). Each toggle or reclassification modifies this local Map via `setOverrides`. **No write to the database occurs on each toggle.**

---

### What "Continue to Review" does

**Confirmed:** The "Continue to Review" button calls `handleContinue` (`StepQuestions.tsx:307-314`):

```typescript
const handleContinue = useCallback(async () => {
  if (debounceRef.current) {
    clearTimeout(debounceRef.current)
    debounceRef.current = null
  }
  await saveAnswers(answers)   // flushes question answers (classifyCheck, doorCount, etc.)
  onComplete()                 // → onJobQuestionsComplete → fetches results → goes to Review
}, [answers, saveAnswers, onComplete])
```

`saveAnswers` persists the `answers` record (e.g., `classify_check: "off"`) via `job.submitAnswers`. It does **not** touch `ClassifyCorrectionPanel`'s internal `overrides` state, which is a child component's private state inaccessible to `handleContinue`.

**Confirmed:** If the user opens the correction panel (`correctionOpen = true`), makes 1 change (`overrideCount = 1`), and clicks "Continue to Review" without first clicking "Save 1 change":

1. `handleContinue` saves `answers` only.
2. `onComplete()` fires → `onJobQuestionsComplete` fetches results → transitions to `JobWizardStep.Review`.
3. `StepQuestions` unmounts, taking `correctionOpen` and the `ClassifyCorrectionPanel` (and its `overrides` state) with it.
4. The override is **silently discarded**. No warning, no confirmation dialog.

There is no guard at `StepQuestions.tsx:908-920` (the WizardNav) that checks `correctionOpen && overrideCount > 0` before allowing navigation.

---

### Timing issue: overrides after extraction completes

The "Continue to Review" button is only enabled when `job.isComplete` (`StepQuestions.tsx:918`). The `isComplete` flag is set by `useExtractionJob` when the background orchestrator finishes all phases including the extraction phase (phase 3.5). The `/api/jobs/[id]/classify-overrides` route comment states:
> "The orchestrator re-reads these before extraction (phase 3.5) so the corrections take effect even if the user saves them just-in-time while classification has already published."

**Hypothesis (requires orchestrator code inspection to confirm):** If "Continue to Review" is only enabled after `job.isComplete` (the full job), then phase 3.5 (extraction) has already run by the time the user can click it. Saving overrides at that point writes them to `phase_data.classify.user_overrides` in the DB but **does not re-run extraction**. The doors shown in StepReview were produced by the pre-override classification. The user's corrections would only take effect on a retry or re-import.

If this hypothesis is correct, the save button in `ClassifyCorrectionPanel` silently succeeds but has no observable effect on the current wizard session.

---

## C) Verification plan

### Supabase queries

**Check whether classify overrides were actually saved for a session:**
```sql
SELECT
  id,
  status,
  updated_at,
  phase_data->'classify'->'user_overrides' AS saved_overrides,
  jsonb_array_length(
    COALESCE(phase_data->'classify'->'user_overrides', '[]'::jsonb)
  ) AS override_count
FROM extraction_jobs
WHERE project_id = '<project_id>'
ORDER BY created_at DESC
LIMIT 5;
```

If `override_count = 0` after a user reported making corrections, the override was discarded (unsaved navigation confirmed).

**Check whether the overrides were applied to derived arrays:**
```sql
SELECT
  id,
  phase_data->'classify'->'schedule_pages'  AS schedule_pages,
  phase_data->'classify'->'hardware_pages'  AS hardware_pages,
  phase_data->'classify'->'user_overrides'  AS user_overrides
FROM extraction_jobs
WHERE id = '<job_id>';
```

If `user_overrides` is non-empty but `schedule_pages`/`hardware_pages` don't reflect the correction, the override was saved after extraction already ran (timing issue hypothesis).

**Check activity_log for the final wizard save (the only DB write in the Apply-to-doors flow):**
```sql
SELECT
  id,
  action,
  entity_type,
  entity_id,
  details,
  created_at
FROM activity_log
WHERE entity_id = '<extraction_run_id>'
   OR details->>'extractionRunId' = '<extraction_run_id>'
ORDER BY created_at DESC;
```

Expect one `extraction_promoted` entry. If absent, the final save failed silently. Field-level applies (location/hand/fire_rating) do NOT produce activity_log entries — those changes exist only in wizard state.

**Verify a specific door's field value was saved:**
```sql
SELECT
  o.id,
  o.door_number,
  o.location,
  o.hand,
  o.fire_rating,
  o.created_at,
  o.updated_at
FROM openings o
JOIN extraction_runs er ON o.extraction_run_id = er.id
WHERE er.project_id = '<project_id>'
  AND o.door_number = '<door_number>'
ORDER BY o.created_at DESC
LIMIT 3;
```

If the field is null/empty here after the user reported applying it, the wizard was closed or refreshed before StepConfirm completed.

**Repro steps to get the right IDs:**
1. Open the wizard fresh on a project with a known door missing `location`.
2. Apply a location via the per-door Fix button (Tier-2 path). Note the door number.
3. Note the timestamp.
4. Without completing the wizard, refresh the page.
5. Query `openings` as above — the field will be missing (always, not sometimes).
6. Repeat but complete the wizard through StepConfirm. Re-query — field should be present now.

---

### Sentry queries

**Silent server failures on the two endpoints:**

1. **Region-extract errors** (Apply-to-doors, propagation scan):
   - Filter: `url contains /api/parse-pdf/region-extract` and `level:error`
   - Expected error types: `UPSTREAM_ERROR` (Python 5xx), `INTERNAL_ERROR`, `ACCESS_DENIED`
   - If these appear frequently after the user clicks Apply, the propagation scan is failing. The field apply still succeeds client-side but propagation suggestions are silently lost.

2. **Classify-overrides errors** (reclassification persistence):
   - Filter: `url contains /api/jobs` and `url contains /classify-overrides` and `level:error`
   - Look for HTTP 409 (`Job has no classification data yet`) and HTTP 500 (`Failed to save overrides`)
   - A 409 would mean the user reached the correction panel before phase 1 (classify) finished — this shouldn't be possible given the UI progression but would explain lost overrides.

3. **Cross-reference with save endpoint**:
   - Filter: `url contains /api/parse-pdf/save` and `level:error`
   - A 5xx here means the toast in StepConfirm either showed a warning ("Saved to staging but promotion failed") or not at all, but in both cases the field values were lost if the user abandoned the partial state.

---

## D) Proposed fixes

### Fix 1: Toast fires only on confirmed state write (Apply-to-doors)

**Problem:** `showToast("success", "Fixed …")` fires at `InlineRescan.tsx:231` immediately after a client-side state update, before any database write.

**Smallest change:** The toast is semantically correct for what it does (apply a value to in-memory door state). The misleading implication is that the change is "saved." Change the toast copy from _"Fixed location for 1 door"_ to _"Applied location to 1 door — save when you reach Confirm"_. No logic change needed.

Stronger fix: Add a persistent "unsaved changes" banner to StepReview that counts field edits and inline edits since last save attempt, replacing the per-action toast with a rolling summary. This banner clears when StepConfirm completes.

### Fix 2: Row re-renders from a visible state (Apply-to-doors)

**Problem:** After a rescan field apply, the door row silently updates. No `recentlyEdited` flash fires.

**Smallest change:** In `handleFieldApply` (`StepReview.tsx:522-527`) and `handleAcceptPropagation` (`StepReview.tsx:610-620`), set `recentlyEdited` to reference the updated cell(s) after the state update, mirroring what `commitEdit` does at `StepReview.tsx:220-231`. Since multiple cells can update at once (Tier-1 batch), `recentlyEdited` would need to hold a Set rather than a single EditingCell, or flash at the set/group level.

### Fix 3: Reclassification changes saved on navigate (page reclassification)

**Problem:** Clicking "Continue to Review" silently discards unsaved overrides in `ClassifyCorrectionPanel`.

**Option A – Flush on navigate (minimal):**  
In `handleContinue` (`StepQuestions.tsx:307-314`), read the pending override state before transitioning. This requires lifting the `overrides` Map out of `ClassifyCorrectionPanel` into `StepQuestions` state (or using a ref), then calling `handleSaveOverrides` before `onComplete()`:

```typescript
// Pseudocode — not implemented
const handleContinue = useCallback(async () => {
  if (debounceRef.current) clearTimeout(debounceRef.current)
  await saveAnswers(answers)
  if (correctionOpen && pendingOverrideCount > 0) {
    await handleSaveOverrides(pendingOverrides)  // flush before leaving
  }
  onComplete()
}, [...])
```

**Option B – Confirm dialog on navigate (safer):**  
If `correctionOpen && overrideCount > 0`, show a confirmation dialog before allowing navigation: _"You have 1 unsaved page correction. Save it now or it will be discarded."_ with Save / Discard / Cancel options. This is the safest UX because it makes the stakes explicit.

**Option C – Auto-save on each toggle (like answers):**  
In `ClassifyCorrectionPanel`, call `onSave` (with a debounce) on every `setTypeOverride` or `toggleExcluded`, similar to how `updateAnswer` debounces in `StepQuestions`. This removes the explicit Save button and makes the correction panel stateless from the user's perspective. Downside: more API calls and harder to cancel mid-edit.

---

## Status

| Finding | Confirmed by code | Hypothesis |
|---------|:-----------------:|:----------:|
| Tier-2 toast fires unconditionally (before DB write) | ✓ | |
| No DB write occurs during Apply-to-doors wizard step | ✓ | |
| "On refresh field is missing" is always-true, not sometimes | ✓ | |
| `recentlyEdited` flash absent after rescan apply | ✓ | |
| New columns invisible to rescan propagation path | ✓ | |
| "Continue to Review" silently discards unsaved overrides | ✓ | |
| No dirty-check/warning before navigation with pending overrides | ✓ | |
| Classify overrides saved after job.isComplete may not affect extraction | | ✓ |
| Door row does not update in the same React render | | ✓ (likely cosmetic) |
