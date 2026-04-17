# Pair-handling dead / stale code — 2026-04-17

Status: **proposal, do not delete yet**.
Goal: identify symbols, comments, schema fields, and migration-only columns
that exist but are unused, vestigial, or lie about current behavior. Each
entry includes a recommended disposition.

All file:line references are against the tree at 2026-04-17
(branch `claude/refactor-pair-detection-SsGYA`).

---

## A. Unused / single-caller exports in `src/lib/parse-pdf-helpers.ts`

### A1. `parseOpeningSize` — called only by `detectIsPair` and its own test
- File: `src/lib/parse-pdf-helpers.ts:2469-2560`
- External callers: **none** outside `parse-pdf-helpers.ts` itself.
- Test coverage: 11 assertions in `parse-pdf-helpers.test.ts:995-1070`.
- Disposition: KEEP but make it non-exported (file-private) — no reason for
  it to be in the public API. If simplification #3 (always-trust-Python)
  lands, this and its tests delete cleanly.

### A2. `VisionExtractionResult.is_pair` — written, read once (reconciliation diff UI)
- File: `src/lib/parse-pdf-helpers.ts:807, 955, 1099, 1149`
- Reader: `src/lib/reconciliation.ts:429-436, 495-499, 523` — only to produce
  a FieldReconciliation for the A-vs-B audit view.
- Not read by: `detectIsPair`, `buildPerOpeningItems`, `normalizeQuantities`,
  save/route.ts, jobs/[id]/run/route.ts, apply-revision/route.ts.
- Disposition: either wire it into `detectIsPair` as a fourth signal
  (Strategy B corroboration) or drop it from the vision prompt / schema.
  Keeping a field that costs tokens but influences no persisted value is
  an anti-pattern.

### A3. `_PAIR_MIN_WIDTH_IN = 48`
- File: `src/lib/parse-pdf-helpers.ts:2459`
- Comment block above it (lines 2437-2458) is 20+ lines of prose about pair
  widths. The constant itself is used exactly once, inside `detectIsPair`'s
  secondary rule.
- Disposition: move the comment onto the `detectIsPair` secondary-rule
  branch and inline the constant. 20 lines of prose next to a literal `48`
  obscures the code.

### A4. `VISION_EXTRACTION_PROMPT` claiming `"is_pair": boolean`
- File: `src/lib/parse-pdf-helpers.ts:955`
- The prompt tells the vision LLM to emit `is_pair` per set, but the only
  consumer is the reconciliation diff UI (see A2). Token cost on every
  vision-extract call for a field the pipeline ignores.
- Disposition: drop from prompt if A2 is resolved by deletion.

---

## B. "Phase N" comments describing states that no longer exist

`grep -n "Phase [1234]" src/lib/parse-pdf-helpers.ts` returns:

- `src/lib/parse-pdf-helpers.ts:445,463,473,485` — `selectRepresentativeSample`
  phases 1–4. Describes the function's internal algorithm. Legitimate,
  keep.
- `src/lib/parse-pdf-helpers.ts:2693` — `// --- Hardware item builder (Phase 3) ---`.
  "Phase 3" refers to the `groovy-tumbling-backus` branch's Phase 3 which
  shipped months ago. Meaningless to a new reader. Disposition: delete.
- `src/lib/parse-pdf-helpers.ts:2757` — `// Phase 2 reverted Phase 1's doubling...`.
  Archaeological. Disposition: rewrite as "per-leaf quantities are stored
  as-is; the UI splits them at render time."
- `src/lib/parse-pdf-helpers.ts:2762` — `// Phase 3: attach a leaf_side hint...`.
  Same issue.
- `src/lib/parse-pdf-helpers.ts:2767` — `// Phase 4 (pair-door hinge fix)...`.
  Same issue.
- `src/lib/classify-leaf-items.ts:4` — `"Phase 3 of groovy-tumbling-backus"`.
  Same issue.
- `src/lib/classify-leaf-items.ts:82` — `"As of Phase 4..."`.
- `src/lib/classify-leaf-items.ts:137` — `"Phase 3: prefer persisted leaf_side"`.
- `src/lib/classify-leaf-items.ts:194` — `"Only applies during wizard preview..."`
  (not a Phase reference but in the same class of comments — documents a
  transient co-existence with post-save state).

Disposition for all of the above: rewrite as present-tense facts.
"Electric hinges route to the active leaf on pairs" not "Phase 4
(pair-door hinge fix) routes electric hinges to...".

---

## C. "Safety net" / "Nuclear Option" vestigial mentions

- `src/lib/parse-pdf-helpers.ts:1474` — `// normalizeQuantities safety net doesn't re-divide...`
- `src/lib/parse-pdf-helpers.ts:1500` — `// skip path — silently bypassing the per-leaf division safety net.`
- `src/lib/parse-pdf-helpers.ts:1572` — JSDoc on `normalizeQuantities`
  describes old triple-call architecture and the "safety net" that was
  removed on 2026-04-13. This is a 90-line JSDoc block that is mostly
  archaeology.

Disposition: shrink the JSDoc to state the current contract only. The
historical explanation belongs in a git commit message or a CHANGELOG,
not at the top of a 400-line function.

- `src/app/api/parse-pdf/save/route.ts:78-105` — 28-line "NOTE (2026-04-13,
  fix/qty-normalization-pipeline-overhaul)" about why
  `normalizeQuantities()` is intentionally NOT called here. This comment
  is correct, but 28 lines to say "don't add a third division pass" is
  overkill. The historical reasoning is in the git log.

Disposition: collapse to 3-4 lines: "Do not call normalizeQuantities() here;
the wizard already ran it during chunk extraction. Third-pass division
caused silent double-division regressions — see 2026-04-13 branch."

---

## D. Schema fields that are set but not read (or read but not set)

### D1. `HardwareSet.heading_doors` — written by Python, read by TS
- Written: `api/extract-tables.py:3467` (heading_doors=[...]).
- Read: `src/lib/parse-pdf-helpers.ts:2636` (`buildDoorToSetMap`).
- Legitimate. Keep.

### D2. `HardwareSet.heading_leaf_count / heading_door_count` — written, read, but NOT persisted
- Written: Python everywhere.
- Read: normalizeQuantities, detectIsPair, Darrin CP2 + CP3 summaries.
- **Not persisted**: there is no DB column for either. After promote, the
  value is gone.
- Disposition: this is the smoking gun for simplification #1. Either
  persist them (so the DB has the same signal the TS code trusts) or
  stop depending on them after save.

### D3. `VisionHardwareSet.is_pair` — written, not read by persistence path
- Written: vision LLM → `parse-pdf-helpers.ts:1149`.
- Read: reconciliation.ts (audit UI only).
- See A2, A4.

### D4. `DoorEntry.leaf_count` (TS type) — written after detectIsPair, read by UI and Darrin
- Written: stagingOpenings mapping (save/route.ts:174), jobs/[id]/run
  (1252), propagated through `writeStagingData` and `merge_extraction`.
- Read: Darrin CP3, selectRepresentativeSample, groupItemsByLeaf
  (indirectly via SetPanel and door detail).
- Legitimate. Keep. This IS the durable signal.

### D5. `StagingOpening.leaf_count` — written, copied to `openings.leaf_count`, never read back on staging
- File: `src/lib/extraction-staging.ts:60`.
- Readers after INSERT: only the `merge_extraction` RPC itself.
- Legitimate (the value must survive the RPC to land on openings).

### D6. `ReconciledHardwareSet.is_pair` — full FieldReconciliation for a field that doesn't flow anywhere
- File: `src/lib/types/reconciliation.ts:54`.
- Only used in `reconciliation.test.ts` and the audit UI.
- Disposition: if simplification #3 (always-trust-Python) lands, delete;
  otherwise keep.

### D7. `openings.leaf_count INTEGER NOT NULL DEFAULT 1` (mig 012)
- Durable, correct, load-bearing. Keep.

### D8. Apply-revision path does NOT write `leaf_count` on new openings
- File: `src/app/api/parse-pdf/apply-revision/route.ts:240-251`.
- `openingRows` INSERT has no `leaf_count` column — defaults to 1.
- `buildPerOpeningItems` (line 277) then runs `detectIsPair` and may emit
  per-leaf rows for a door whose opening is stored as single. The UI
  reads leaf_count from the opening row, not from the items, and
  renders a single-leaf layout even though the items say pair.
- **This is a latent bug, not dead code**, but relevant here because the
  migration-only column (D7) is the only durable signal and this path
  fails to populate it. Flagged for simplification #2.

### D9. `hardware_items.leaf_side` NULL fallback path
- Migration: 013_hardware_leaf_side.sql.
- NULL values require the taxonomy-based re-derivation in
  `groupItemsByLeaf` (classify-leaf-items.ts:128-208).
- Rows written by `buildPerOpeningItems` now always carry a non-NULL
  leaf_side (active/inactive/shared) EXCEPT for per_leaf / per_opening
  items on pair doors where the value is deliberately NULL.
- Preview-time rows (unsaved wizard items) are always NULL.
- Disposition: the NULL branch is legitimate. Keep.

---

## E. Migration-only columns the code never touches

None found. Every column added by migrations 012 and 013 (leaf_count on
openings + staging_openings, leaf_side on hardware_items +
staging_hardware_items) is both written and read.

---

## F. Duplicated maps / helpers

### F1. Four independent constructions of `setMap`
- `src/app/api/parse-pdf/save/route.ts:73` — `buildSetLookupMap(hardwareSets)`
- `src/app/api/parse-pdf/apply-revision/route.ts:71-77` — inline loop
  (NOT using `buildSetLookupMap`!)
- `src/app/api/jobs/[id]/run/route.ts:1104-1110 and 1198-1204` — inline
  loops, called twice, different variable names (`setMapForPhase` and
  `setMap`)
- `src/components/ImportWizard/StepConfirm.tsx` — client-side copy
- Disposition: `apply-revision/route.ts` and both `jobs/[id]/run/route.ts`
  copies should call `buildSetLookupMap`. Currently they inline the same
  loop body. Small, safe refactor.

### F2. `merge_heading_doors_into_openings` Python legacy wrapper
- `api/extract-tables.py:2566-2577` — legacy wrapper around
  `join_opening_list_with_heading_pages`. Preserved only so older tests
  pass.
- Callers: only `tests/test_extract_tables.py`.
- Disposition: update the tests to call `join_opening_list_with_heading_pages`
  and read the stats dict; delete the wrapper.

### F3. `extract_doors_from_set_headings` Python thin wrapper
- `api/extract-tables.py:2251-2268`. Calls `list(build_heading_page_map(pdf).values())`
  and logs. Thin.
- Callers: chunk extractor path. Replaceable with the one-liner.
- Disposition: inline at call sites; delete.

### F4. `scanElectricHinges` called in three places with identical guard
- `parse-pdf-helpers.ts:1732, 2778`
- `classify-leaf-items.ts:134`
- Each caller has to compute or know `isPair` (or `leafCount >= 2`) to
  pass as the second argument. The signature could instead take the
  persisted `leaf_count` or be driven by a single-source helper.

---

## G. Dead-code summary for grep/ts-prune confirmation

Run locally to verify (do NOT run in CI):
```
npx ts-prune --project tsconfig.json | grep -iE "pair|leaf"
npx ts-unused-exports tsconfig.json --ignoreLocallyUsed=false | grep -iE "pair|leaf"
```
Expected findings:
- `parseOpeningSize` → only self-referenced.
- `selectRepresentativeSample` → used.
- Possibly `VisionExtractionResult` members if A2/A4 are acted on.

Python side — no equivalent tool runs in CI, but a `grep -nE
"merge_heading_doors_into_openings|extract_doors_from_set_headings"` over
`api/ tests/` will show that F2 and F3 are narrowly used.

---

## H. Recommended order of action (if this proposal is approved)

1. Rewrite vestigial Phase-N comments (Section B) — pure text, safe.
2. Collapse long historical JSDocs (Section C) — pure text.
3. Replace inline setMap loops with `buildSetLookupMap` (F1).
4. Fix apply-revision missing-leaf_count write (D8) — one-line addition
   with a regression test.
5. Decide is_pair vision field: wire into detectIsPair or delete (A2/A4).
6. Delete Python legacy wrappers (F2, F3) after updating tests.

Each of 1–6 is independent and small. Do not bundle with the larger
simplifications in the third document.
