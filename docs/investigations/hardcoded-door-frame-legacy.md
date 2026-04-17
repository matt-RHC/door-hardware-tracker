# Investigation — "Hardcoded Door/Frame per opening" (Prompt 1)

Date: 2026-04-17
Branch: `claude/investigation-hardcoded-door-frame`
Scope: Read-only investigation of the duplicate-Door / duplicate-Frame / multiple-Hinges regression visible on door card `110-01B` (Radius DC). No code changes.

---

## TL;DR

Matthew's intuition was **half right**. There IS exactly one code path that inserts a `Door` row and a `Frame` row for every opening — **`buildPerOpeningItems` at `src/lib/parse-pdf-helpers.ts:2704`** (lines 2741–2754). But that path is **not** a legacy remnant. It is the current *intelligent* path, and it already does leaf-aware splitting: pair openings get `Door (Active Leaf)` + `Door (Inactive Leaf)` + `Frame`; single openings get `Door` + `Frame`. There is no other code anywhere that inserts bare `Door`/`Frame` rows.

The symptoms on door 110-01B — the `Door` row next to `Door (Active Leaf)`/`Door (Inactive Leaf)`, the duplicate `Frame`, the three `Hinges` lines, and the flat list where the Shared/Leaf 1/Leaf 2 tabs used to be — are produced by **three already-identified bugs** whose intersection is on display:

| # | Bug | Status | Fix shipped? |
|---|-----|--------|---------------|
| 1 | Python extractor emitted bare-token `"Door"` and `"Frame"` strings inside `hwSet.items[]` (column-header artefact of the hardware-set table). `buildPerOpeningItems` faithfully appends whatever is in `hwSet.items` at `sort_order 2+` on top of its own structural rows at `sort_order 0/1` → duplicate Door/Frame. | Root cause fixed | **Yes, PR #291 merged 2026-04-17 14:29 UTC**. Any door extracted BEFORE that merge still shows the duplicates. |
| 2 | `apply-revision/route.ts:240-251` INSERTs new openings without stamping `leaf_count`, so the opening defaults to `leaf_count=1` while `buildPerOpeningItems` re-runs `detectIsPair` and may emit `Door (Active Leaf)` + `Door (Inactive Leaf)` rows. The UI then reads `leaf_count=1` and renders the single-door flat list (not the Shared/Leaf 1/Leaf 2 tabs), so the leaf-named rows appear flat. | Latent bug, still present | **No** — documented as `D8` in `docs/cleanup/pair-handling-deadcode-2026-04-17.md` and proposed as `P2` in `docs/cleanup/pair-handling-simplifications-2026-04-17.md`. Not yet merged. |
| 3 | `detectIsPair` ran in two places per save (once for `staging_openings.leaf_count`, once inside `buildPerOpeningItems`). On 2026-04-17 a detector change briefly disagreed between the two calls for the DH4A-family heading shape, producing openings where `leaf_count=1` but the items were emitted as pair-named. | Mitigated, not collapsed | **No** — proposed as `P1`. The two-call-site structure still exists. |

Bug 1 is the amplifier (why are there so MANY extra rows?). Bug 2 is the renderer disagreement (why does a card with leaf-named rows show as a flat list?). Bug 3 is why the leaf-named rows exist on an opening whose `leaf_count=1` in the first place.

**110-01B shows all three simultaneously**, which is why the card looks so broken. But there is *not* a fourth legacy writer to find.

---

## A) Data flow trace

**Pair-door leaf splitting happens at TS save time**, inside a single function, during the wizard save → staging → promote round-trip. It does not happen in Python, and it does not happen at render time.

### A.1 The one and only Door/Frame insertion

```
src/lib/parse-pdf-helpers.ts:2704-2754  buildPerOpeningItems(...)
```

```ts
// 2741-2747 — Door row(s)
if (doorModel) {
  if (isPair) {
    rows.push({ ...base, name: 'Door (Active Leaf)',   qty: 1, ..., leaf_side: 'active'   })
    rows.push({ ...base, name: 'Door (Inactive Leaf)', qty: 1, ..., leaf_side: 'inactive' })
  } else {
    rows.push({ ...base, name: 'Door',                 qty: 1, ..., leaf_side: 'active'   })
  }
}

// 2752-2754 — Frame row (one per opening, pair or single)
if (frameModel) {
  rows.push({ ...base, name: 'Frame', qty: 1, ..., leaf_side: 'shared' })
}
```

**`isPair` comes from `detectIsPair(hwSet, doorInfo)` at line 2735** — NOT from `opening.leaf_count`. This is the root cause of class-3 divergence (see D below). The caller's `leaf_count` is ignored.

Three callers invoke this function:

| Call site | File:line | Provides `leaf_count` to caller's storage? |
|-----------|-----------|--------------------------------------------|
| Main extract/save | `src/app/api/parse-pdf/save/route.ts:207-214` (after writing `staging_openings.leaf_count = isPair ? 2 : 1` at line 188) | **Yes** — `leaf_count` is stamped on staging row. Promote carries it to `openings.leaf_count`. |
| Background job | `src/app/api/jobs/[id]/run/route.ts:1241, 1277` | **Yes** — verbatim copy of save path, stamps leaf_count on staging row. |
| Apply revision (NEW doors only) | `src/app/api/parse-pdf/apply-revision/route.ts:240-251` (insertion) + `:277` (items via `buildPerOpeningItems`) | **No** — `openingRows` INSERT omits `leaf_count`, column defaults to 1. This is the latent bug D8. |

### A.2 What table / column holds leaf assignment

| Column | Location | Purpose |
|--------|----------|---------|
| `openings.leaf_count INTEGER NOT NULL DEFAULT 1` | `supabase/migrations/012_pair_leaf_support.sql:13-14` | THE durable render-time signal. `leaf_count >= 2` → pair door → render Shared / Leaf 1 / Leaf 2 tabs. |
| `staging_openings.leaf_count` | mig 012 line 18-19 | Pre-promote staging copy. `merge_extraction()` propagates to `openings`. |
| `hardware_items.leaf_side TEXT NULL` | `supabase/migrations/013_hardware_leaf_side.sql` | `'active' | 'inactive' | 'shared' | 'both' | NULL`. Per-item attribution stamped by `buildPerOpeningItems` at line 2743/2744/2746/2754. |

**Not persisted**: `hwSet.heading_leaf_count`, `hwSet.heading_door_count`. These are Python-computed per-set integers (the authoritative pair evidence) that die at the wire-protocol boundary. `normalizeQuantities`, `detectIsPair`, and Darrin CP2/CP3 all depend on them at extract time but they leave no trace post-save.

### A.3 What component renders the door card

```
src/app/project/[projectId]/door/[doorId]/page.tsx
```

| Line | Role |
|------|------|
| `758-759` | `const leafCount = (opening as any).leaf_count ?? 1; const isPair = leafCount >= 2;` — reads ONLY the opening row, not the items. |
| `760` | `const { shared, leaf1, leaf2 } = groupItemsByLeaf(opening.hardware_items, leafCount);` — groups items for tabbed rendering. |
| `1665` | `{isPair ? ( ...Shared/Leaf 1/Leaf 2 sub-tabs... ) : ( ...flat list, no tabs... )}` — **the single switch** between tabbed layout and flat layout. |

The SELECT: opening is fetched with `leaf_count` in the client query (client-side type-cast via `(opening as any).leaf_count` — a minor type-hygiene issue, not load-bearing). No column-list drift inside this file.

`groupItemsByLeaf` at `src/lib/classify-leaf-items.ts:121-212` prefers a persisted `leaf_side` and falls back to taxonomy-based re-derivation when `leaf_side` is NULL. All rows written by `buildPerOpeningItems` after migration 013 carry a non-NULL `leaf_side` (active/inactive/shared); only preview-time unsaved rows are NULL. So the fallback is only exercised in preview, not on 110-01B.

---

## B) Regression hypothesis

**Most likely explanation for what image-2.jpg shows**: door 110-01B is a survivor from an extraction run that completed **before** PR #291 merged (2026-04-17 14:29 UTC). The staging → promote path for that run produced a `hardware_items` payload containing:

- 2 structural rows from `buildPerOpeningItems` at `sort_order 0, 1, 2` → `Door (Active Leaf)` + `Door (Inactive Leaf)` + `Frame` (the pair branch fired, so `isPair` was true at save time for this door).
- 2-3 phantom rows from the bare-token Python artefact at `sort_order 3+` → `Door qty=1 model=A` + `Frame qty=1 model=F2` + possibly a `Hinges` (if the set table also had a bare `Hinges` header — see the three-row Hinges repetition in the screenshot).

The card then shows all of them stacked in the list (5 structural-ish rows + hardware items).

Compounding it: the UI chooses the flat list at line 1665 because `opening.leaf_count < 2`. That tells us either
- the opening row had `leaf_count` stamped as 1 at save time (bug 3: `detectIsPair` disagreed between call 1 and call 2 of 2 — call 1 stamped staging with leaf=1 because Radius DC DH1-10 didn't trip the keyword fallback, then call 2 inside buildPerOpeningItems recomputed differently and emitted pair-named Door rows); or
- the opening was later patched via apply-revision (bug 2) which never writes `leaf_count`.

The three separate `Hinges` lines (qty 3, qty 4, qty 1) are NOT from the phantom-token bug — they are real set-table items. On a pair, the hardware set's heading block typically contains something like:
```
3  Hinges  5BB1 HW 4 1/2 x 4 1/2 NRP  652    ← probably electric-hinge-adjusted active leaf
4  Hinges  5BB1 HW 4 1/2 x 4 1/2 NRP  652    ← inactive leaf (standard)
1  Hinges  5BB1 HW 4 1/2 x 4 1/2 CON TW8 652 ← continuous or specialty third hinge line
```
The electric-hinge split logic at `buildPerOpeningItems:2814-2842` produces exactly this shape (active leaf = raw − electric, inactive leaf = raw). This one is working correctly but visually confusing in a flat list.

### B.1 git log evidence

Relevant recent commits on `main`, newest first:

| Commit | Date | Note |
|--------|------|------|
| `641f9f7` | 2026-04-17 14:10 UTC | **fix(extraction): filter bare "Door"/"Frame" tokens from hardware item lists** — one alternation branch added to `NON_HARDWARE_PATTERN` in `api/extract-tables.py:1228`. Merged as PR #291 at 14:29 UTC. Stops root-cause emission. |
| `542fef3` | 2026-04-17 14:14 UTC | **test(ts): document structural amplification of phantom Door/Frame rows** — 4th `it()` block in `src/lib/__diagnostics__/repro-double-structural.test.ts:286-341` pins the amplification behaviour: given bad Python input, `buildPerOpeningItems` emits 2× Door + 2× Frame. |
| `4ff85a5` | 2026-04-17 | **diagnostics: trace Radius DC double-structural-rows bug (investigation only)** — PR #289, produced `docs/diagnostics/save-flow-trace-2026-04-17.md` which documented 127 phantom rows across 22-27 sets for run `5fd76705-b97a-49e9-888e-ddf4f0a34597`. |
| `1142398` | 2026-04-17 | PR #288 — pair-detection refactor that collapsed the three-tier `detectIsPair` description into the map/deadcode/simplifications trio. |
| `b474208` | 2026-04-17 | PR #287 — Radius DC regression fix that added the primary `heading_leaf_count > heading_door_count` rule to `detectIsPair`. |

**None of these address bug 2** (apply-revision missing `leaf_count` write). It remains latent.

### B.2 What changed the leaf grouping visually

The Shared/Leaf 1/Leaf 2 grouping **was not removed** from the codebase. It is still rendered at `door/[doorId]/page.tsx:1665-1700`. The reason it's not showing on 110-01B is that `opening.leaf_count < 2`, so the `else` branch at line 1701 runs (flat list). If the same user opens a door where `opening.leaf_count = 2` AND the items carry `leaf_side` attribution (any pair door extracted cleanly post-287), the tabs appear.

**Confirmation test Matthew can run in 30 seconds** (once he's in the project): open any pair door that was extracted via the main save path with a clean Python payload. If the Shared/Leaf 1/Leaf 2 tabs appear, the renderer is fine. If they don't, we have a new class-4 bug we haven't characterised yet.

---

## C) Code paths that write to `hardware_items`

Every writer, found via `grep -rn "\.from('hardware_items')\|from 'hardware_items'\|\"hardware_items\"" src/`:

| Writer | File:line | Runs when | De-dupes generic Door/Frame before insert? |
|--------|-----------|-----------|---------------------------------------------|
| Main extract save | `src/app/api/parse-pdf/save/route.ts:207-214` (build) + later insert | Wizard save-to-staging. Rows carry `extraction_run_id`, land in `staging_hardware_items`. | N/A — writes staging, not production. |
| Promote RPC | `supabase/migrations/037_merge_extraction_report_orphans.sql` `merge_extraction()` | After wizard confirm, staging → production. | N/A — identity copy from staging. |
| Background job | `src/app/api/jobs/[id]/run/route.ts:~1295+` | Async extraction runs. Same shape as save. | N/A (writes staging). |
| Apply revision (new doors) | `src/app/api/parse-pdf/apply-revision/route.ts:277-284` | User accepts a wizard revision for NEW doors. Writes DIRECTLY to `hardware_items` (not staging). | **No de-dupe check** — faithfully inserts whatever `buildPerOpeningItems` returns. |
| Door detail in-place edits | `src/hooks/useItemEditing.ts` (and callers) | User edits one hardware row inline (qty, finish, etc.). | N/A — updates, does not insert structural rows. |
| PDF region rescan | door detail rescan button (`src/app/project/[projectId]/door/[doorId]/page.tsx` + `api/extract-tables.py` rescan endpoints) | Post-promote user-triggered region rescan. | N/A — proposes diffs, never inserts a new Door/Frame row. |
| Issues/notes | (not applicable) | — | — |

**Only two distinct INSERT paths write a Door or Frame row**: the staging write (save/jobs run) and the direct apply-revision write. Both use `buildPerOpeningItems`. No third writer exists. Matthew's hypothesis of "legacy unconditional Door+Frame insert" is not present in current code.

Negative confirmation (grep):

```
$ grep -rn "name: *['\"]Door['\"]\|name: *['\"]Frame['\"]" src/
src/lib/parse-pdf-helpers.ts:2746:  rows.push({ ..., name: 'Door', ... })
src/lib/parse-pdf-helpers.ts:2754:  rows.push({ ..., name: 'Frame', ... })
(rest are test fixtures in extraction-invariants.test.ts and __diagnostics__/)

$ grep -rn "name: *['\"](Door|Frame)" api/ supabase/
(no matches outside test fixtures)
```

Python side: `api/extract-tables.py` does not emit Door/Frame by name — it emits whatever tokens pdfplumber scans from the hardware-set table, which is why bare "Door"/"Frame" column-header artefacts used to leak through.

---

## D) Proposed remediation

These are **described only**, not implemented. Two of them (P1, P2) are already on the roadmap in `docs/cleanup/pair-handling-simplifications-2026-04-17.md` and just need to be promoted to ship-order.

### D.1 Immediate (ship next) — backfill + apply-revision leaf_count

Smallest change to stop new regressions from entering production.

1. **Ship P2 from simplifications.md** — `apply-revision/route.ts:240-251` must include `leaf_count` on the `openingRows` INSERT. Compute it the same way save does:
   ```ts
   // before the .map, build doorInfoMap as save does, then:
   const hwSet = doorToSetMap.get(normalizeDoorNumber(door.door_number))
                 ?? setMap.get(door.hw_set ?? '')
   const doorInfo = doorInfoMap.get(door.door_number)
   const isPair = detectIsPair(hwSet, doorInfo)
   // add to openingRows: leaf_count: isPair ? 2 : 1
   ```
   One added column, ~8 LoC in the map callback. Low risk.

2. **Ship P1 from simplifications.md** — `buildPerOpeningItems` must take `leafCount` as a required parameter and **not** call `detectIsPair` internally. This collapses the two-call-site divergence structurally. Save/jobs/apply-revision all already know the leaf count at call time (save line 188, jobs line 1252, and apply-revision after D.1.1 lands).

   The new signature:
   ```ts
   export function buildPerOpeningItems(
     openings: Array<{ id: string; door_number: string; hw_set: string | null; leaf_count: number }>,
     doorInfoMap: Map<string, { door_type: string; frame_type: string }>,
     setMap: Map<string, HardwareSet>,
     doorToSetMap: Map<string, HardwareSet>,
     fkColumn: 'opening_id' | 'staging_opening_id' = 'opening_id',
     extraFields?: Record<string, unknown>,
   )
   ```
   Readers: all three callers already have `leaf_count` at hand. The function deletes lines 2725-2736 (the `detectIsPair` call and its comment) and uses `opening.leaf_count` on line 2742. `isPair = leafCount >= 2`.

   This **structurally prevents** the class-3 bug that made 110-01B's leaf-named rows land on a `leaf_count=1` opening.

### D.2 Rules (per Matthew's guidance)

Matthew's guidance: "The Python pipeline (or Darrin) can intelligently apply inactive/active leaves and frames based on what's actually in the submittal."

Concrete rules `buildPerOpeningItems` already applies once P1 lands:

| Opening shape | `leaf_count` | Doors emitted | Frames emitted |
|---|---|---|---|
| Single door (no leaf split) | 1 | 1 × `Door` (`leaf_side: 'active'`) | 1 × `Frame` (`leaf_side: 'shared'`) |
| Pair door | 2 | 1 × `Door (Active Leaf)` + 1 × `Door (Inactive Leaf)` | 1 × `Frame` (shared across both leaves) |
| Double egress | 2 | 1 × `Door (Active Leaf)` + 1 × `Door (Inactive Leaf)` — (both leaves are active-style; the current name scheme is imperfect but consistent with the set's handing. See D.2.1) | 1 × `Frame` |
| Dutch door | 1 | 1 × `Door` | 1 × `Frame` — **NOT modelled**. A true Dutch door has two leaves stacked vertically (top/bottom) that usually share one frame. `detectIsPair` will return false (leaf_count==door_count and no "pair" keyword), so it renders as a single. See D.2.2 |
| Borrowed light / sidelight / transom | 1 | 1 × `Door` | 1 × `Frame` — **plus** per_frame items (seals, weatherstrip) that attach to the frame regardless of leaf count. Current code groups these as `leaf_side: 'shared'`, which is correct. |
| Dummy door (no hardware set) | 1 | 0 × door (the `if (doorModel)` guard at 2741 suppresses) | 0 × frame (guard at 2753) | – |

**D.2.1 Double-egress caveat**. Currently both leaves render as `Door (Active Leaf)` and `Door (Inactive Leaf)` even though on a true double-egress opening both leaves are active-style (each leaf has its own exit device, not just one). The *names* are misleading but the *structure* (2 doors + 1 frame + per-leaf item attribution) is correct. This is worth a rename later — propose `Door (Leaf 1)` / `Door (Leaf 2)` and move the active/inactive/shared distinction entirely into `leaf_side`. Out of scope for this investigation; flag for a follow-up.

**D.2.2 Dutch door, borrowed light, sidelight, transom**. These are not detected. `detectIsPair` is a binary. Matthew's strategy-store idea (Prompt 3 §C) is the right place to model them — a per-set rule that says "this set is Dutch" and routes the Python → TS writer accordingly. Out of scope for this investigation; flagged for Prompt 3's design.

### D.3 Golden test coverage

Per `docs/cleanup/pair-handling-simplifications-2026-04-17.md §3`, the three golden PDFs today cover:

| PDF | Pair exercised? | Single exercised? | Double egress? | Dutch / sidelight? |
|-----|------------------|-------------------|----------------|---------------------|
| MEDIUM (Radius DC) | **Yes** — DH4A.0 = 6 pair openings; DH1-10 series too | Yes | No | No |
| LARGE (Cornell / GTN3) | Yes — various | Yes | Unknown | No |
| SMALL (schedule golden) | Partial | Yes | No | No |

**Recommended new tests before P1/P2 merge** (already proposed as tests 5/6/7 in simplifications §3.5):

5. `tests/__tests__/build-per-opening-items.golden.test.ts` — DH4A.0 fixture (6 pair doors) produces exactly 12 `Door (*Leaf)` rows + 6 `Frame` rows. Catches B1/bug-1 regression.
6. Same file — fixture where `heading_leaf_count == heading_door_count` produces exactly 1 `Door` per opening. Catches B1 reverse.
7. Same file — **fixture where opening.leaf_count=2 but the hwSet's heading_leaf_count is 0 (revision scenario): assert caller's leaf_count wins**. This is the P1-enabling contract test.

Golden PDF exercised: MEDIUM (Radius DC) is the one that carries both pair and non-pair sets. P1/P2 must pass MEDIUM baseline before merge. LARGE and SMALL are sanity checks.

### D.4 Migration / schema

Neither P1 nor P2 needs a new Supabase migration.

- P2 writes to an existing column (`openings.leaf_count`, migration 012).
- P1 changes only the TypeScript function signature. No schema change.

**Data-cleanup migration for already-corrupted rows**: recommended. Proposed as a one-off script, NOT a Supabase migration (idempotent re-run not worth it):

```sql
-- Draft for review. Do NOT run without a dry-run count first.
-- Removes duplicate bare "Door" / "Frame" rows on openings where the
-- matching leaf-named row also exists. Preserves leaf_side integrity.

BEGIN;

-- Dry run — count affected rows per opening
WITH dupes AS (
  SELECT hi.id, hi.opening_id, hi.name, hi.leaf_side
  FROM hardware_items hi
  WHERE hi.name IN ('Door', 'Frame')
    AND EXISTS (
      SELECT 1 FROM hardware_items hi2
      WHERE hi2.opening_id = hi.opening_id
        AND (
          (hi.name = 'Door' AND hi2.name IN ('Door (Active Leaf)', 'Door (Inactive Leaf)'))
          OR (hi.name = 'Frame' AND hi2.name = 'Frame' AND hi2.id <> hi.id)
        )
    )
)
SELECT opening_id, COUNT(*) AS dupe_rows, array_agg(DISTINCT name) AS names
FROM dupes
GROUP BY opening_id
ORDER BY dupe_rows DESC
LIMIT 20;

-- Review the above output manually. If it looks correct, proceed:
-- DELETE FROM hardware_items hi WHERE hi.id IN (SELECT id FROM dupes);

COMMIT;
```

Should live as `scripts/cleanup-phantom-door-frame-rows.sql` + a wrapper npm script that requires `--confirm=YES-I-RAN-DRY-RUN` before the DELETE fires. **Not** auto-applied.

### D.5 Deploy order

1. Merge D.3 golden tests (tests 5/6/7). Fail-closed gate.
2. Merge P2 (apply-revision `leaf_count` write). Smallest fix.
3. Merge P1 (`buildPerOpeningItems` takes `leafCount`). Collapses call-site divergence.
4. Re-extract Radius DC (manual by Matthew) — confirms new extractions are clean.
5. Run the cleanup SQL dry-run against production to count how many old-data openings still carry phantom rows. If few, delete via the confirmation wrapper. If many, discuss whether to re-extract the affected projects instead.

Each step independently verifiable. No flag day.

---

## E) Risks / downstream impact

### E.1 Progress counters

Door card shows `0 / 14` for 110-01B. That `14` comes from `totalItems = shared.length + leaf1.length + (isPair ? leaf2.length : 0)` at `door/[doorId]/page.tsx:769`. If we remove 3 phantom rows (1 Door + 1 Frame + 1 Hinges), the total becomes `0 / 11` (for that door — other doors vary). **Expected and correct.** Any user who had mentally committed to the 14-number will notice. Flagged in the cleanup-script wrapper as a user-facing confirmation.

### E.2 Export (QR / PDF / delivery tracker)

- `src/components/DeliveryTrackerPanel.tsx` iterates `hardware_items` and groups by status. Duplicate rows → same item counted twice in the "pending receive" totals. Removing duplicates fixes a silent over-count.
- QR payload: I did not exhaustively trace export shape. Recommend a follow-up grep for any aggregator that assumes "1 Door row + 1 Frame row per opening" in exported output. Low risk but not zero.

### E.3 Invariants gate

`src/lib/extraction-invariants.ts` (Track 1C on ROADMAP) already has a rule: "Opening with > 2 `Door*` rows" and "Opening with both bare `Door` AND a `Door (Active/Inactive Leaf)` row". Run `scripts/audit-extraction-invariants.ts` against production — every 110-01B-shaped opening should surface as a violation. That audit is the fastest way to size the blast radius of the cleanup SQL.

### E.4 Background job path duplication

`src/app/api/jobs/[id]/run/route.ts` lines 1241/1277 are a verbatim copy of the save path. Any fix to `buildPerOpeningItems`'s signature (P1) MUST be applied in both places or the background job will break. Covered by the repo-wide grep the TS compiler will enforce once the signature changes.

### E.5 Preview / wizard divergence

`classify-leaf-items.ts:121-212` (`groupItemsByLeaf`) has a fallback branch that re-derives `leaf_side` when the DB column is NULL. For preview rows (unsaved wizard items), this fallback is the only grouping signal. If P1 changes when/how `leaf_side` is stamped, preview must continue to produce identical grouping. Covered by the existing `classify-leaf-items.test.ts` suite; run before/after P1 merge.

---

## F) Open questions for Matthew

1. **Cleanup scope.** Once we run the audit against production, if the result is "most extraction runs have at least one 110-01B-shaped opening," is your preference (a) bulk DELETE of phantom rows via the cleanup SQL, or (b) re-extract the affected projects from scratch to get the clean Python output from PR #291? The latter is safer but costs a wizard session per project.

2. **`Door (Active Leaf)` / `Door (Inactive Leaf)` naming.** On a double-egress opening, "inactive leaf" is a misnomer (both leaves are active-style). Is a rename to `Door (Leaf 1)` / `Door (Leaf 2)` (with active/inactive/shared fully living in the `leaf_side` column) a small enough UX change to land with P1, or should it be a separate proposal?

3. **Dutch doors / sidelights / borrowed lights.** Do any of your current projects have these shapes? If yes, they need a strategy-store design (Prompt 3). If no, we defer until a real PDF forces the question.

4. **Ship order vs. Prompt 2.** Prompt 2 (apply-doors persistence audit) is queued. Prompt 2 probably covers the revision save path. If P2 of this doc lands first, does it need a coordination note in Prompt 2's plan? I think so, but want your call.

5. **Strategy store (Prompt 3 territory).** Do you want opening-shape rules (Dutch, double-egress, Frame-only openings with no door) to live in the strategy store, or in Python-side pipeline rules, or both? Matthew's original framing suggested "the Python pipeline or Darrin can intelligently apply" — I read that as "either, but not TS." Confirm?

---

## Status

```
DONE:
  - Repo survey + AGENTS/CLAUDE read
  - Confirmed via grep that src/lib/parse-pdf-helpers.ts:2746 and :2754 are
    the ONLY non-test insertions of name:'Door' / name:'Frame' anywhere in
    src/, api/, or supabase/. No legacy Door/Frame-per-opening loop exists.
  - Traced the full data flow: Python extract → TS save → staging →
    promote_extraction RPC → openings.leaf_count → door/[doorId]/page.tsx
    render gate at line 1665.
  - Identified the three interacting bugs causing image-2.jpg (phantom
    bare-token rows from Python (fixed by PR #291), apply-revision
    missing leaf_count write (D8, latent), detectIsPair double-call
    divergence (P1 in simplifications doc)).
  - Verified the Shared/Leaf 1/Leaf 2 rendering code is fully present
    at door/[doorId]/page.tsx:1665-1700 — the grouping was not
    removed, only bypassed when opening.leaf_count < 2.
  - Documented proposed remediation referencing existing P1/P2
    proposals and a cleanup SQL sketch.

PLANNED (not done):
  - No code changes.
  - P1 / P2 from docs/cleanup/pair-handling-simplifications-2026-04-17.md
    remain unshipped — this investigation is a pointer, not a fix.
  - Invariants audit against production to size cleanup scope.
  - Re-extract Radius DC post-audit.

NOTICED BUT DID NOT TOUCH:
  - type-hygiene: door/[doorId]/page.tsx:758 uses (opening as any).leaf_count
    instead of typing leaf_count on the Opening interface. Minor.
  - naming: Door (Active Leaf) / Door (Inactive Leaf) is misleading on
    double-egress openings (see D.2.1 + open question 2).
  - Darrin CP2/CP3 still read heading_leaf_count from in-memory hwSets
    that die after save (P4 territory) — not fixed by P1/P2.

SHADOW CHANGES:
  - None.

ROADMAP:
  - Track 1 — Reliable Extraction is the correct track. Add P1 + P2 as
    sub-items under Track 1 (they are structural prerequisites for the
    invariants gate to ever reach zero violations on new extractions).
  - Flag: if Matthew approves, the next session should open the P2 PR
    (smallest, lowest risk) while holding P1 for a separate PR with
    tests 5/6/7 from simplifications §3.5.
```
