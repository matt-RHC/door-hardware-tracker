# Pair-handling simplification proposals — 2026-04-17

Status: **proposal trio, for Matthew's approval**. No code changes yet.
Companion docs:
- `pair-handling-map-2026-04-17.md` (where pair-ness lives today)
- `pair-handling-deadcode-2026-04-17.md` (what can go)

The guiding rule is the one from the space:
> No duplicated business logic. If the same rule exists in two places,
> extract a shared helper. Two implementations of the same rule WILL diverge.

## 0. Choice of single source of truth

Three design options were considered. The table first, details below.

| Option | Where is-pair is computed | What gets simpler                               | What gets harder                                   | First thing that breaks on a new PDF format |
|--------|---------------------------|--------------------------------------------------|-----------------------------------------------------|---------------------------------------------|
| **(a) Python** — persist `heading_leaf_count` / `heading_door_count` on the set, derive is-pair on the DB boundary | Python heading parser | Only one writer for pair-ness; TS becomes read-only for pair signal; Darrin sees the same value the UI sees | Requires new migration + new hardware_sets table (currently no such table exists; sets live only in memory during extraction) | A PDF where the heading block doesn't contain "N Pair Doors" language — but that's ALSO what breaks the current system |
| **(b) TS at wizard preview time** — compute `is_pair` once on the DoorEntry, propagate through save + apply-revision | TS, after pdfplumber returns | No DB schema change; `detectIsPair` runs exactly once per door and becomes the authority; can retire the three-tier fallback | Preview-time compute means the wizard user can't override it without a round-trip; Darrin CP2/CP3 see stale value if they mutate the doors | A PDF whose size format isn't handled by `parseOpeningSize` — fails silently at preview with no heading signal to corroborate |
| **(c) Render-time from `openings.leaf_count`** — treat the DB column as the only trusted signal after save; recompute from items on read | DB column post-save | Everything downstream of save has ONE source; the whole detectIsPair / buildPerOpeningItems / groupItemsByLeaf problem shrinks to "look at the column" | The save path still has to decide the initial value, so detectIsPair stays; apply-revision bug (missing leaf_count write) must be fixed; existing readers already do this, so "simplification" is smaller than it sounds | Same as today — a new PDF format that fools detectIsPair ships a wrong `leaf_count` that then propagates everywhere |

### Recommendation: a hybrid — (a) at extraction, (c) at render

- **Python remains the only producer of pair evidence.** Persist
  `heading_leaf_count` and `heading_door_count` on a new
  `hardware_sets` row (or on `staging_hardware_sets` first), and persist
  the *derived* `is_pair_hint` alongside. This makes the DB the authority
  for what Python saw.
- **`openings.leaf_count` remains the render-time source.** All readers
  (SetPanel, door detail, Darrin CP3, groupItemsByLeaf) keep the current
  shape.
- **`detectIsPair` becomes a pure function of persisted fields.** Its
  three-tier fallback (heading, width-parse, keyword) collapses into
  "read the persisted `is_pair_hint`; if null, fall back to
  `leaf_count > 1`". `parseOpeningSize` and the keyword scan retire.
- The save path computes `leaf_count` from `is_pair_hint` exactly once
  and writes it. `buildPerOpeningItems` reads `leaf_count` from the
  opening row it was handed — **it no longer recomputes**.

Why not pure (a): the hardware_sets table doesn't exist today; sets live
transiently on extraction_runs and are rebuilt by the wizard on revision.
The migration cost is real.

Why not pure (b): wizard-time compute means the user's corrections to
door_type or location don't re-trigger pair detection — and the
2026-04-17 regression surfaced when `detectIsPair` was the only path and
its signals were incomplete. Doubling down on TS-only is risky.

Why not pure (c): the column already exists and is already the render
source of truth. "Pure (c)" is almost what we have, minus the two places
where detectIsPair is run after the column is set (call 2 of 2 on save,
and the compute inside `buildPerOpeningItems`). The hybrid above is (c)
plus "make Python's evidence durable too."

---

## 1. Proposals, ranked by (value / risk × effort)

Ranking heuristic: 1 is highest-priority. Value = how much the
surface shrinks. Risk = blast radius if it regresses. Effort = LoC +
migrations + test changes.

### P1. Make `buildPerOpeningItems` take `leafCount` as a parameter; delete its internal `detectIsPair` call

**One sentence**: `buildPerOpeningItems` must receive `leaf_count` from
the caller (who already computed it) and must not recompute pair-ness.

- Files touched: `src/lib/parse-pdf-helpers.ts` (-~8 LoC internal,
  +~4 LoC param), `src/app/api/parse-pdf/save/route.ts` (pass leaf_count
  through a derived map), `src/app/api/jobs/[id]/run/route.ts` (same),
  `src/app/api/parse-pdf/apply-revision/route.ts` (same).
- Tests: update `buildPerOpeningItems — pair detection` suite in
  `parse-pdf-helpers.test.ts:1167` to pass leaf_count explicitly. Add
  one test: "buildPerOpeningItems does NOT infer pair-ness from
  hwSet.heading_leaf_count when caller passes leaf_count=1" (proves the
  call-2 recomputation is really gone).
- Regression structurally prevented: **"call 1 and call 2 of detectIsPair
  disagreed"** — the exact class of the 2026-04-17 regression. Two
  implementations of the same rule are collapsed to one.
- Effort: S. Risk: low (all call sites are within the repo; type system
  catches missed updates). Value: high.
- **Rank: 1.** Smallest change, highest return.

### P2. Make `apply-revision/route.ts` write `openings.leaf_count` for new doors

**One sentence**: new-door insertion must stamp `leaf_count` so
`buildPerOpeningItems` and the UI agree.

- Files touched: `src/app/api/parse-pdf/apply-revision/route.ts:240-251`
  (one added column on INSERT and ~8 LoC to compute it).
- Tests: new test in `parse-pdf-helpers.test.ts` or a new route-level
  test that applies a revision containing a pair door, then asserts
  both the opening row and its items agree on pair-ness.
- Regression structurally prevented: **"new doors added via revision
  show up as single-leaf in the UI but have both-leaf item rows."**
  Currently a latent bug (the opening defaults to leaf_count=1 while
  buildPerOpeningItems re-runs detectIsPair and emits two Door rows).
- Effort: S. Risk: low (writes a field that currently defaults to 1).
  Value: medium (fixes a real latent bug).
- **Rank: 2.** Do together with P1.

### P3. Retire the three-tier `detectIsPair`; replace with `leaf_count > 1` post-save and a single Python-side rule pre-save

**One sentence**: inside `detectIsPair`, keep only the primary rule
(heading_leaf_count > heading_door_count). Delete the size-parse and
keyword fallbacks.

- Files touched: `src/lib/parse-pdf-helpers.ts` (delete
  `parseOpeningSize`, delete `_PAIR_MIN_WIDTH_IN`, trim `detectIsPair`
  to ~8 LoC). **Requires** Python to always emit
  `heading_leaf_count > heading_door_count` when the set is a pair.
- Python side: add a CI test that fails if any golden PDF produces a
  pair door (DHI definition: `heading` contains "Pair", OR
  `_count_specworks_doors` returned a PRA/PRI) where
  `heading_leaf_count == heading_door_count`. This turns "keyword
  fallback exists because Python might miss it" into "Python MUST not
  miss it."
- Tests: delete 11 `parseOpeningSize` tests and 6 tertiary-keyword
  tests; add 2 Python tests (Radius DC DH4A, LyftWaymo, kinship-GTN3
  assert `heading_leaf_count > heading_door_count`).
- Regression structurally prevented: **"the keyword fallback returned
  the wrong answer silently" (the original 2026-04-17 shape).** No
  more fallbacks means a Python miss is loud (downstream sees leaf=door
  and treats as single; the new assertion will catch it).
- Effort: M. Risk: medium — requires confidence that Python handles
  every PDF format. We already have 12+ golden PDFs to validate
  against.
- **Rank: 3.** Big simplification, non-trivial risk.

### P4. Persist `heading_leaf_count` / `heading_door_count` on hardware sets (new DB column(s))

**One sentence**: hardware_sets gets two integer columns; promote
propagates them; all post-save consumers read from the DB instead of
reconstructing from memory.

- Files touched: new migration (`048_heading_counts_on_sets.sql`);
  `merge_extraction` RPCs (025, 034, 037 — latest one) need two extra
  assignments; `promoteExtraction` via `src/lib/extraction-staging.ts`;
  readers that today consult `hwSet.heading_leaf_count` (Darrin CP2,
  CP3 summaries, normalizeQuantities on revision) switch to the
  persisted value.
- Tests: migration golden-row test; extend promote RPC tests to assert
  counts propagate; add a revision-flow test that recomputes
  `normalizeQuantities` reads the DB values.
- Regression structurally prevented: **"heading_leaf_count disappeared
  after save so revision-time normalization used the opening-list
  fallback that happens to be wrong for sub-headings."** This is
  adjacent to but not identical to the 2026-04-17 regression — it's a
  regression we haven't had yet, but the code shape invites it.
- Effort: M-L (new migration, 4-RPC edit across mig 025 / 034 / 037 plus
  the latest consolidated one, staging tables, promote, type
  regeneration). Risk: medium — DB schema changes; needs careful
  rollback plan.
- **Rank: 4.** High value, highest effort. Worth doing after P1-P3.

### P5. Collapse `groupItemsByLeaf` fallback path by making `hardware_items.leaf_side` NOT NULL with a generated-column default

**One sentence**: make leaf_side a required stamp at write time;
compute `'both'` as the default for ambiguous per_leaf/per_opening items
on pairs so the render path never has to re-derive.

- Files touched: new migration (backfill then set NOT NULL), delete
  `groupItemsByLeaf`'s 60-LoC fallback branch (classify-leaf-items.ts:178-208),
  update `buildPerOpeningItems` to always emit a non-null `leaf_side`,
  update wizard preview rows to likewise carry leaf_side.
- Tests: classify-leaf-items.test.ts's "DB leaf_side preference" suite
  simplifies; regex-fallback suite deletes.
- Regression structurally prevented: **"preview and save emit different
  leaf_side attribution for the same item"** — today the preview path
  re-derives and can diverge from what buildPerOpeningItems will
  eventually write.
- Effort: M. Risk: medium (backfill semantics must be exact — default
  `'both'` for the historically-NULL rows).
- **Rank: 5.** Nice-to-have; independent of P1-P4.

---

## 2. What each proposal deletes

Estimated LoC removed / added, by proposal:

| Proposal | Removed | Added | Net |
|----------|---------|-------|-----|
| P1       | ~15     | ~12   | –3  |
| P2       | 0       | ~10   | +10 (bug fix, not simplification) |
| P3       | ~160 (parseOpeningSize + tests + tertiary block in detectIsPair) | ~30 (new Python assertions) | –130 |
| P4       | ~40 (in-memory reconstructions across Darrin + normalizeQuantities) | ~90 (migration + RPC edits + type changes) | +50 (temporary; enables P5 and future cleanups) |
| P5       | ~70 (groupItemsByLeaf fallback + scanElectricHinges call in preview) | ~20 (migration + default computation) | –50 |

Total (all five): net –123 LoC, five entire branches of conditional
logic deleted, one new DB column pair, zero new helpers.

---

## 3. Golden test coverage audit

> **Note (corrected 2026-04-17):** The authoritative golden-suite runner is
> `scripts/run-golden-suite.mjs`. Its `PDF_CATALOG` catalogs ~18 training
> PDFs with `BASELINES` for doors/sets; `test-pdfs/training/` contains ~20
> PDFs; `test-pdfs/reference/` contains 3 pinned-behavior fixtures.
> Exact counts drift as PDFs are added — **do not panic over count
> mismatches**. Health is: suite runs green, per-PDF counts stay within a
> reasonable delta of `BASELINES`. The "small/medium/large" shorthand used
> below is legacy taxonomy from the 2026-04-08 codebase review, not a
> current filename convention. Radius DC in particular now lives as
> `grid-RR` (`306169_RR_HW_Submittal_03-20-26.pdf`) in `PDF_CATALOG`, not
> as `sched-*.pdf`.

The four bug classes we need tests for:
- **B1 structural doubling** — pair door produces 2 Door rows + 1 Frame
  row; single door produces 1 Door row + 1 Frame row.
- **B2 leaf_count regression** — the opening's `leaf_count` column
  matches whether the items carry Active/Inactive or Door.
- **B3 wrong-set-assignment** — doors assigned to DH4A.0 vs DH4A.1 get
  the correct sub-set's items, not the generic set's merged items.
- **B4 fire-rating-as-location** — `parse_heading_door_metadata` doesn't
  slurp the fire rating into the location field.

### 3.1 Golden #1: MEDIUM (Radius DC — `grid-RR` in PDF_CATALOG; legacy name `MEDIUM`; has DH4A.0/DH4A.1)

- `tests/baselines/medium-baseline.json` asserts door_count,
  hw_set_count, set_ids, item_count per set, per-item qty and
  qty_source.
- It does NOT assert `heading_leaf_count` or `heading_door_count` for
  any set, not even DH4A.0 which is the very set that regressed.
- Coverage matrix for this PDF:

| Bug class | Caught? | Why / how |
|-----------|---------|-----------|
| B1 structural doubling | ❌ | No assertion that DH4A.0 doors produce 2 Door rows. The pipeline doesn't reach `buildPerOpeningItems` in these Python tests. |
| B2 leaf_count regression | ❌ | Python extract tests don't exercise the TS save path. |
| B3 wrong-set-assignment | ⚠️ partial | `test_set_ids_match` confirms both DH4A.0 and DH4A.1 exist; does NOT assert which doors go to which. |
| B4 fire-rating-as-location | ❌ | No test reads the `location` field on a DH4A door. |

### 3.2 Golden #2: LARGE (`sched-Cornell.pdf` / `kinship-GTN3.pdf` / etc.)

- Coverage is limited to door count and set count. No per-door field
  assertions.
- All four bug classes: ❌.

### 3.3 Golden #3: SMALL (schedule-format golden)

- Coverage similar: door count + set count.
- All four bug classes: ❌.

### 3.4 Reference PDFs (`test-pdfs/reference/`)

- `arch-DoorSchedule-717010A.pdf` — asserts zero hardware sets (good).
- `spec-HarrisHealth.pdf` — asserts zero sets (good).
- `spec-MarshallCourts.pdf` — known `xfail`; spec doc false positive.
- None of these exercise pair handling (intentional).

### 3.5 Proposed new assertions to close the gaps

Add to `tests/test_baselines.py::TestMediumBaseline`:
1. `test_dh4a0_is_pair_set` — assert
   `hw_sets["DH4A.0"].heading_door_count == 6 and
    hw_sets["DH4A.0"].heading_leaf_count == 12`. **Directly catches
   B1/B2 at the extraction boundary.**
2. `test_dh4a1_is_single_set` — assert
   `heading_door_count == heading_leaf_count` (whatever the value is
   for DH4A.1 — this is the "single sub-heading of a mixed set" case).
   **Catches B3**: if DH4A.1 accidentally picks up DH4A.0's items it
   would typically also pick up the wrong heading_leaf_count.
3. `test_dh4a_doors_assigned_to_correct_sub_set` — for each door
   number in `hw_sets["DH4A.0"].heading_doors`, assert the same door
   number is NOT in `hw_sets["DH4A.1"].heading_doors`. **Catches B3.**

Add to a new `tests/test_heading_door_metadata.py`:
4. `test_fire_rating_not_in_location` — parametrize on the known
   regression input `"1 Pair Doors #1.01.B.03A 90Min CORRIDOR RHR"`;
   assert `parse_heading_door_metadata` returns `location="CORRIDOR"`,
   not `"90Min CORRIDOR"`. **Catches B4.**

Add to a new `tests/__tests__/build-per-opening-items.golden.test.ts`
(vitest + fixture JSON):
5. For a fixture representing DH4A.0 (6 pair doors), assert
   `buildPerOpeningItems` produces exactly 12 Door rows (6 active + 6
   inactive) and 6 Frame rows. **Catches B1.**
6. For a fixture where `heading_leaf_count == heading_door_count`,
   assert `buildPerOpeningItems` produces exactly 1 Door row per
   opening. **Catches B1 regression in the opposite direction.**
7. For a fixture where opening's `leaf_count=2` but the hardware set
   has `heading_leaf_count=0` (revision-time scenario), assert the
   caller's `leaf_count=2` wins. **Catches the P1-blocking
   pre-condition: "buildPerOpeningItems must honour leafCount from
   caller, not from set".**

These seven assertions close the coverage gap that the 2026-04-17
regression slipped through. If P1 + P3 land, tests 5–7 become the
contract that the pipeline can no longer drift from.

---

## 4. What to commit in this branch

Nothing — this is a proposal trio. The next step is Matthew's review.
If approved, the recommended execution order is:

1. Merge the Section H cleanup items from the deadcode doc (comments
   + legacy wrappers). Low-risk, paves the way.
2. Ship P1 (buildPerOpeningItems takes leafCount) behind the existing
   tests plus the new test 7 above. One small PR.
3. Ship P2 (apply-revision writes leaf_count) in the same or next PR.
4. Ship new test assertions 1–4 (Python side) as a standalone PR — they
   will fail-closed if any of the current pipeline quietly regresses.
5. Ship P3 (retire three-tier detectIsPair) only after 1–4 have baked
   for at least one PDF upload cycle in production.
6. Ship P4 + P5 together later, gated on a schema change window.

At no point should two of these be in flight on the same branch.
