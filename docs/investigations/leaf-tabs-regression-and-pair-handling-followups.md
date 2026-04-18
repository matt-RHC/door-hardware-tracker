# Investigation — Leaf Tabs Regression & Pair-Handling Follow-ups

**Status:** Draft · 2026-04-17
**Branch:** `claude/pair-handling-followups`
**Author:** Perplexity Computer (for Matthew)
**Prompt origin:** Prompt 1 ("hardcoded Door/Frame legacy") delta scope
**Supersedes scope:** the unique findings from closed PR #298

---

## 0. TL;DR

Closed PR #298 and merged PR #299 both answered the original "hardcoded
Door/Frame legacy" prompt. PR #299 is the authoritative explanation for
the **phantom Door / Frame rows** on door 110-01B in Radius DC (root
cause: Python bare-token artefacts in `hwSet.items[]`, fixed by
commit `641f9f7` / PR #291).

This document covers the **remaining scope** from the original
investigation that PR #299 did not address:

1. **Why the Shared / Leaf 1 / Leaf 2 tabs disappeared from the door
   card** even on openings whose items were correctly named. This is a
   separate bug in `apply-revision/route.ts` and is not fixed by PR #291.
2. **Why `detectIsPair` is called twice per save** and can produce
   divergent `opening.leaf_count` vs. item names — a structural
   code-health issue.
3. **Rename plan** from `Active Leaf` / `Inactive Leaf` to
   `Leaf 1` / `Leaf 2`, with a separate active/inactive status chip on
   the door card. Confirmed with Matthew 2026-04-17.
4. **Golden regression tests 5, 6, 7** as specified in
   `docs/cleanup/pair-handling-simplifications-2026-04-17.md §3`,
   needed as a cage before shipping the P1/P2 fixes.

This doc is intentionally narrow. It does **not** re-litigate the
phantom-row story (see PR #299) and does **not** design an
opening-shape strategy store (see PR #295's `extraction_strategies`
proposal, which is the natural home for Dutch-door / sidelight /
borrowed-light shape rules).

---

## 1. The leaf-tabs regression (P2)

### 1.1 Symptom

On the door detail page (`src/app/project/[projectId]/door/[doorId]/page.tsx`),
openings that should render as tabbed **Shared / Leaf 1 / Leaf 2 / All**
sometimes render as a single flat list instead. This is visible on
door 110-01B in Radius DC as of the screen recording from 2026-04-17
17:26 UTC, and it happens even when the item titles correctly carry
`(Active Leaf)` / `(Inactive Leaf)` suffixes.

### 1.2 Root cause

The door detail renderer branches on `opening.leaf_count`:

```tsx
// src/app/project/[projectId]/door/[doorId]/page.tsx
const leafCount = opening?.leaf_count ?? 1;
const isPair = leafCount >= 2;   // line 759
// ...
{isPair ? <TabbedLeafView /> : <FlatList />}  // line 1665
```

The tabbed view is guarded behind `leaf_count >= 2`. If
`opening.leaf_count` is `1` (or `null`), the renderer falls through to
the flat list even when items are correctly named.

The bug is in `src/app/api/parse-pdf/apply-revision/route.ts` at
lines 240–251. The `openingRows` INSERT omits `leaf_count` entirely:

```ts
// apply-revision/route.ts (current main, lines 235–255)
const openingRows = doors.map((d: any) => ({
  project_id,
  door_number: d.door_number,
  location: d.location,
  hand: d.hand,
  fire_rating: d.fire_rating,
  hw_set: d.hw_set,
  door_type: d.door_type,
  frame_type: d.frame_type,
  label: d.label,
  remarks: d.remarks,
  // ... no leaf_count field written ...
}));

const { data: insertedOpenings, error: openingErr } = await supabase
  .from('openings')
  .insert(openingRows)
  .select();
```

Postgres defaults `leaf_count` to `1` on INSERT when the column is
omitted (see `supabase/migrations/012_pair_leaf_support.sql`). So
**every opening created via apply-revision is recorded as single-leaf**,
regardless of whether the submittal actually shows a pair.

The downstream `buildPerOpeningItems` call then re-runs `detectIsPair`
on the raw hwSet metadata and emits pair-named items anyway. Result:
item titles say "pair" but the opening row says "single," and the
renderer at line 1665 picks the flat-list branch.

### 1.3 Why the bug was invisible until now

- The main extraction path (`save/route.ts:188`) writes
  `leaf_count: isPair ? 2 : 1` correctly on the INSERT. New projects
  entering via the wizard have correct `leaf_count` values.
- `apply-revision` is only hit when a user re-runs a targeted rescan
  from the Review page (region-extract → propose → apply).
- Radius DC triggered apply-revision during the 2026-04-17 session
  that produced the screen recording, which is why that project
  shows the regression and other projects do not.

### 1.4 Fix (P2)

One line of insertion logic plus a `detectIsPair` call already
available in-scope:

```ts
// apply-revision/route.ts (proposed)
const openingRows = doors.map((d: any) => {
  const hwSet = hwSets.find((s: any) => s.set_id === d.hw_set);
  const isPair = hwSet ? detectIsPair(hwSet) : false;
  return {
    project_id,
    door_number: d.door_number,
    // ... existing fields ...
    leaf_count: isPair ? 2 : 1,  // FIX: was missing, defaulted to 1
  };
});
```

A comment at the fix site will explain what was wrong and why, per
the Space's Code Quality Standards.

### 1.5 Test coverage

Golden test 6 (single-leaf opening) and the new test 7 (pair opening
on apply-revision path) will pin this behavior. See §4.

---

## 2. The `detectIsPair` double-call (P1)

### 2.1 Symptom (latent)

`detectIsPair(hwSet)` is called at least twice per save:

1. `src/app/api/parse-pdf/save/route.ts:175` — computes `isPair` to
   write `opening.leaf_count`.
2. `src/lib/parse-pdf-helpers.ts:2735` inside
   `buildPerOpeningItems` — re-computes `isPair` to decide whether to
   emit one Door row or two.

Both call sites read the same input (`hwSet` metadata), but they are
decoupled. Any future change to `detectIsPair`'s behavior — or any
mutation of `hwSet` between calls — can make the two agree on one
opening but disagree on another.

### 2.2 Proposed refactor (P1)

Pass `leafCount` as a parameter into `buildPerOpeningItems` rather
than letting it re-derive the value:

```ts
// src/lib/parse-pdf-helpers.ts (proposed)
export function buildPerOpeningItems(
  hwSets: HardwareSet[],
  doorsBySet: Map<string, DoorEntry[]>,
  leafCountByDoor: Map<string, number>,  // NEW — caller owns the signal
): PerOpeningItem[] {
  // ...
  for (const door of doors) {
    const leafCount = leafCountByDoor.get(door.door_number) ?? 1;
    const isPair = leafCount >= 2;  // caller's answer is authoritative
    // emit items...
  }
}
```

Callers then own the single source of truth for `leaf_count`:

- `save/route.ts` passes its `Map<door_number, leaf_count>`.
- `apply-revision/route.ts` passes the same (once P2 computes it).
- No second `detectIsPair` call; no divergence risk.

### 2.3 Test coverage

Golden test 7 pins the contract: when the caller's
`leafCountByDoor.get(d) === 2` but `heading_leaf_count === 0` inside
the hwSet metadata, the caller's value wins. See §4.3.

---

## 3. Rename & status chip plan

Confirmed with Matthew 2026-04-17:

- Across the app, door-card and review-panel tab headers become:
  **Leaf 1 / Leaf 2 / Shared / All**
  (replacing `Active Leaf` / `Inactive Leaf`).
- A separate **active/inactive status chip** renders next to each
  leaf's header when the submittal indicates egress side, e.g.
  `Leaf 1 · Active`, `Leaf 2 · Inactive`. Blank chip when
  single-egress or unknown.

### 3.1 Rename scope

| File | Change |
|------|--------|
| `src/lib/parse-pdf-helpers.ts` (item title emission inside `buildPerOpeningItems`) | `"Door (Active Leaf)"` → `"Door (Leaf 1)"`, `"Door (Inactive Leaf)"` → `"Door (Leaf 2)"`. Frame suffixes updated to match. |
| `src/lib/classify-leaf-items.ts` (`groupItemsByLeaf`) | Leaf bucket keys / labels updated to `leaf1` / `leaf2` / `shared` / `all`. Back-compat shim reads old suffixes during the transition. |
| `src/app/project/[projectId]/door/[doorId]/page.tsx` (tab labels near line 1665) | Header strings updated. |
| `src/components/ImportWizard/review/SetPanel.tsx` | Same header strings. |

### 3.2 Status chip scope

The chip is a presentational addition. It renders next to the
`Leaf 1` / `Leaf 2` header text, driven by a new
`leafEgress: 'active' | 'inactive' | null` field on the per-leaf
group object returned by `groupItemsByLeaf`. The value is derived
from the existing `leaf_side` metadata on `hardware_items` (see
`supabase/migrations/013_hardware_leaf_side.sql`) plus the item
title regex. No schema change.

A single Tailwind pill component handles both states:

```tsx
<span className="ml-2 text-xs px-1.5 py-0.5 rounded
                 bg-slate-100 text-slate-600">
  {leafEgress === 'active' ? 'Active' : 'Inactive'}
</span>
```

### 3.3 Back-compat

Data already in the DB uses `(Active Leaf)` / `(Inactive Leaf)` in
item titles. The rename writes new titles on new extractions; existing
rows continue to parse correctly via the back-compat shim in
`groupItemsByLeaf`. After the one-time purge confirmed by Matthew
2026-04-17 (keep `projects` rows, wipe children), no old-format rows
will exist.

---

## 4. Golden regression tests 5/6/7

Per `docs/cleanup/pair-handling-simplifications-2026-04-17.md §3`,
tests 1–4 are Python-side baselines (already in
`tests/test_baselines.py` and `tests/test_heading_door_metadata.py`).
Tests 5–7 are TypeScript-side unit tests exercising
`buildPerOpeningItems` directly, using the same harness pattern as
`src/lib/__diagnostics__/repro-double-structural.test.ts`.

### 4.1 Test 5 — pair-door structural count

Given a pair fixture (DH4A.0 pattern from Radius DC) with 6 generic
hardware rows, assert `buildPerOpeningItems` emits:

- 12 Door rows (6 active + 6 inactive, alternating by leaf side).
- 6 Frame rows (one per generic row, single-leaf frame semantics).
- 0 rows with title matching `/^(Door|Frame)$/` (bare-token regression
  guard — complements the fix in PR #291).

### 4.2 Test 6 — single-leaf opening

Given a single-leaf fixture where
`heading_leaf_count === heading_door_count === 1`, assert:

- Exactly 1 Door row per opening, with no leaf suffix.
- Exactly 1 Frame row per opening.
- `opening.leaf_count === 1` written by caller.

### 4.3 Test 7 — caller's leafCount wins

Given a fixture where the caller passes
`leafCountByDoor.get('D1') === 2` but the underlying
`hwSet.heading_leaf_count === 0`, assert:

- `buildPerOpeningItems` emits pair-style Door rows (active + inactive).
- This test fails today because `buildPerOpeningItems` re-runs
  `detectIsPair` and ignores caller intent. It passes after the P1
  refactor.

This test is the contract for P1.

### 4.4 Fixtures

All three tests use synthetic `HardwareSet` / `DoorEntry` objects
defined inline in the test file. No PDF fixtures needed — keeps the
tests fast (sub-second) and decoupled from the golden PDF runner.

---

## 5. Ship order

1. **Commit 1 (already in this branch, `f7dce0d`):** Correct stale
   golden-PDF counts in AGENTS.md and two docs. Add the drift-tolerance
   rule so future agents don't spiral on number mismatches.
2. **Commit 2 (this doc):** This investigation document.
3. **PR-A:** Golden tests 5/6/7. Tests 5 and 6 pass on main; test 7
   fails on main (will pass after PR-C). Red-then-green is the point.
4. **PR-B:** P2 fix in `apply-revision/route.ts`. Smallest diff,
   highest impact — brings back the Shared / Leaf 1 / Leaf 2 tabs on
   any re-extracted opening.
5. **PR-C:** P1 refactor (caller-owned `leafCount`) bundled with the
   rename from §3 and the status chips. Test 7 goes green here.
6. **Purge SQL:** After PR-C merges, wipe `openings`,
   `hardware_items`, `staging_openings`, `staging_hardware_items`,
   `extraction_jobs`, and `activity_log`. Keep the `projects`,
   `companies`, `company_members`, `project_members`,
   `reference_codes`, and `product_families` rows.
7. **Re-extract Radius DC** on the purged project and verify:
   - Door 110-01B shows Shared / Leaf 1 / Leaf 2 / All tabs.
   - Active/Inactive chips render next to leaf headers.
   - No phantom Door / Frame rows at `sort_order >= 2`.
   - `opening.leaf_count === 2` on all pair openings.

---

## 6. Cross-references

- **PR #291** — Python bare-token fix (phantom-row root cause).
- **PR #299** — authoritative investigation of the phantom-row
  symptom on door 110-01B. Ships with surgical cleanup SQL we do not
  need thanks to the full purge.
- **PR #298** — closed; superseded by #299 for the phantom-row story
  and by this doc for the leaf-tabs / refactor / rename scope.
- **PR #295** — Review page attention-first redesign. Proposes the
  `extraction_strategies` table and `shape_rule` JSONB. **This is the
  natural home for Dutch-door / sidelight / borrowed-light /
  transom corrections going forward.** Cross-reference from PR-C
  when we get there.
- **PR #296** — Review persistence audit. Four independent findings
  (toast-before-write, `recentlyEdited` flash, rescan column
  selectivity, classify-override discard). Zero overlap with the
  scope of this doc.
- **PR #297** — Wizard questions grouping. Stacked on #295.
- **`docs/cleanup/pair-handling-{map,deadcode,simplifications}-2026-04-17.md`** —
  the prior-in-session investigation trio. Tests 5/6/7 in this doc
  are the ones specified in `simplifications §3`.
- **`src/lib/__diagnostics__/repro-double-structural.test.ts`** —
  the test harness pattern for §4.

---

## 7. Open items NOT in scope here

- **Dutch / sidelight / borrowed-light / transom inventory.**
  Separate Claude Code prompt ("Prompt 5") is going out in parallel.
  Read-only research: which current / historical project PDFs contain
  which opening shapes. Outputs the target set for PR #295's
  `shape_rule` work.
- **Propagation of leaf_count through `merge_extraction` RPC.**
  `supabase/migrations/037_merge_extraction_report_orphans.sql:127,149,165`
  already handles `leaf_count` correctly — no change needed.
- **Wizard persistence audit (PR #296) follow-up fixes.** Their own
  PR chain after this one lands.
