# Investigation: Duplicate Door / Frame Rows on Door Card (110-01B)

**Date:** 2026-04-17  
**Branch:** `claude/fix-door-card-duplicates-0pHYs`  
**Symptom:** Opening 110-01B (set DH1-10, 45 Min) renders duplicate structural rows and an extra Hinges row:

```
Door                   qty 1   A
Frame                  qty 1   F2
Door (Active Leaf)     qty 1   A
Door (Inactive Leaf)   qty 1   A
Frame                  qty 1   F2     ← duplicate
Hinges                 qty 3   5BB1 ... NRP   652
Hinges                 qty 4   5BB1 ... NRP   652     ← two hinge rows on same model
Hinges                 qty 1   5BB1 ... CON TW8  652
```

---

## A. Finding the "Legacy" Insertion

### Hypothesis check

Matthew's framing was that "code somewhere hardcodes doors and frames per opening" — a separate, unconditional loop that always writes one Door row and one Frame row regardless of the PDF. That specific pattern **does not exist** in the current codebase. No function named `ensureDoorItem`, `seedHardwareItems`, `createDefaultItems`, `addDoorAndFrame`, or `hydrateOpening` was found. No loop over openings unconditionally inserts a row with a literal `name = 'Door'` or `name = 'Frame'` outside of `buildPerOpeningItems()`.

Patterns searched without a hit:

| Pattern | Files searched |
|---------|----------------|
| `ensureDoor`, `seedHardware`, `createDefault`, `addDoorAndFrame`, `hydrateOpening` | `src/**/*.ts`, `api/*.py` |
| Loop over openings + `insert` with literal `"Door"` or `"Frame"` | `src/**/*.ts` |
| Any `.from('hardware_items').insert(...)` outside of `apply-revision` and `promote_extraction` | `src/app/api/**/*.ts` |
| Python function that appends Door/Frame rows per opening unconditionally | `api/extract-tables.py` |

### What actually caused the duplicates

The culprit is a tokenization bug in the Python extractor, fixed in commit **641f9f7** (2026-04-17). The mechanism has two stages:

**Stage 1 — Python emits phantom items (pre-fix)**

`api/extract-tables.py` processes PDF hardware-set tables row by row. In some PDF formats (specifically Radius DC), the column header row of the hardware table (which contains the literal text "Door" and "Frame" as column labels) was being parsed as if it were a hardware item name. These bare tokens passed through `NON_HARDWARE_PATTERN` because the pattern did not filter them.

Before the fix, `NON_HARDWARE_PATTERN` (`extract-tables.py:1226–1236`) was:

```python
NON_HARDWARE_PATTERN = re.compile(
    r"^(Single Door|Pair Doors|Opening\b|Properties:|Notes:|Description:)"
    r"|(?:REVISED|CHECKED|REVIEWED)\s+BY:"
    r"|_{5,}"
    # ... other patterns, but NO bare "Door"/"Frame" filter
)
```

The fix (commit `641f9f7`) added one alternation at line 1228:

```python
r"|^\s*(Door|Frame)\s*$"   # Bare column-header tokens
```

This is now live in the codebase. The `\s*$` anchor ensures real item names like "Door Sweep", "Frame Anchor", and "Doorstop" still pass through.

**Stage 2 — TypeScript amplifies the phantom items**

`buildPerOpeningItems()` (`src/lib/parse-pdf-helpers.ts:2704–2893`) is the sole function that constructs all rows destined for `hardware_items`. It runs in two sub-phases for each opening:

1. **Structural rows** (lines 2738–2755): emits `Door (Active Leaf)` + `Door (Inactive Leaf)` for pairs, or bare `Door` for singles, only when `door_type` is non-empty; emits `Frame` only when `frame_type` is non-empty. This is the *intelligent* path — conditional on actual data from the PDF.

2. **Set items** (lines 2775–2857): iterates `hwSet.items[]` — the list produced by Python extraction — and appends one row per item.

In the pre-fix state, `hwSet.items[]` for a set like DH1-10 contained the phantom `{ name: 'Door' }` and `{ name: 'Frame' }` items that Python extracted from the column header row. `buildPerOpeningItems` then emitted them faithfully at `sort_order 2` and `sort_order 3`, on top of its own structural rows at `sort_order 0` and `sort_order 1`. The result for a pair opening was exactly the fingerprint seen on 110-01B:

```
sort_order 0: Door (Active Leaf)   ← from structural sub-phase
sort_order 1: Door (Inactive Leaf) ← from structural sub-phase
sort_order 2: Frame                ← from structural sub-phase
sort_order 3: Door                 ← phantom from Python (pre-fix)
sort_order 4: Frame                ← phantom from Python (pre-fix)
sort_order 5...N: real set items
```

This is documented and pinned by the amplification witness test at `src/lib/__diagnostics__/repro-double-structural.test.ts` (commit `542fef3`).

**The Hinges rows**

The three Hinges rows on 110-01B are **not** duplicates — they are the correct output of the hinge-split logic (`parse-pdf-helpers.ts:2809–2841`). For a pair door where the set definition has both standard hinges and a specialty/electric hinge:

- `qty 3 / 5BB1…NRP 652` — active leaf: standard hinges minus one electric position
- `qty 4 / 5BB1…NRP 652` — inactive leaf: standard hinges (full count)
- `qty 1 / 5BB1…CON TW8 652` — active leaf: specialty hinge (assigned to active only per DHI standard)

All three are correct and expected. However, in the pre-fix extraction, the phantom bare "Door" and "Frame" items inflated the `sort_order` of these rows and made the card look more chaotic.

**When did the extractors run?**

The extraction run that produced the duplicates on 110-01B is `5fd76705-b97a-49e9-888e-ddf4f0a34597`. The fix in `641f9f7` was merged 2026-04-17. Any opening promoted from that run (or any pre-fix run) carries the phantom rows in production `hardware_items`. The fix prevents new extractions from creating them; it does not clean up existing rows.

---

## B. The Intelligent Path

### Where Door / Frame rows come from the PDF

`buildPerOpeningItems()` (`src/lib/parse-pdf-helpers.ts:2704`) is the sole writer of Door and Frame rows to `hardware_items`. It consumes `doorInfoMap`, a `Map<door_number, { door_type, frame_type }>` built from `DoorEntry` objects populated by the Python extractor.

```typescript
// parse-pdf-helpers.ts:2738–2755
const doorModel = doorInfo?.door_type?.trim() || null
if (doorModel) {
  if (isPair) {
    rows.push({ ...base, name: 'Door (Active Leaf)', qty: 1, ..., leaf_side: 'active' })
    rows.push({ ...base, name: 'Door (Inactive Leaf)', qty: 1, ..., leaf_side: 'inactive' })
  } else {
    rows.push({ ...base, name: 'Door', qty: 1, ..., leaf_side: 'active' })
  }
}
const frameModel = doorInfo?.frame_type?.trim() || null
if (frameModel) {
  rows.push({ ...base, name: 'Frame', qty: 1, ..., leaf_side: 'shared' })
}
```

`door_type` and `frame_type` on `DoorEntry` are extracted by:
- `extract-tables.py` → `build_heading_page_map()` / `reconcile_openings()` reads these from the door schedule columns and the set heading block.
- `jobs/[id]/run/route.ts:1226–1232` populates `doorInfoMap` from the accepted `DoorEntry` objects.

If both fields are empty on a `DoorEntry` (door has no set, or the extractor missed them), `buildPerOpeningItems` emits zero structural rows for that opening. That opening is then filtered as an orphan by `wouldProduceZeroItems()` (`parse-pdf-helpers.ts:2669`) and excluded from staging.

### Where leaf assignment is set

`computeLeafSide()` (`parse-pdf-helpers.ts:194–218`) assigns `leaf_side` at save time:

```typescript
if (itemName === 'Door (Active Leaf)') return 'active'
if (itemName === 'Door (Inactive Leaf)') return 'inactive'
if (itemName === 'Frame') return 'shared'
if (itemName === 'Door') return leafCount <= 1 ? 'active' : null
// per_pair / per_frame scope items → 'shared'
// per_leaf / per_opening on pairs → null (deferred to render-time / triage UI)
```

This is rule-based, not an Anthropic call. The `leaf_side` column was added by migration `013_hardware_leaf_side.sql` and is persisted on both `staging_hardware_items` and `hardware_items`.

### Where pair-door splitting happens

`detectIsPair()` (`parse-pdf-helpers.ts:2583–2620`) uses three layered signals:

1. **Primary** (line 2590): `hwSet.heading_leaf_count > heading_door_count` — structural data from PDF heading line ("1 Pair Doors").
2. **Secondary** (line 2600): Parse `door_type` / location / heading for an opening width ≥ 48 inches.
3. **Tertiary** (line 2607): Keyword scan for "pair", "double", "pr" in heading or `door_type`.

The active/inactive hinge-split logic (`parse-pdf-helpers.ts:2809–2841`) applies only when `isPair && category === 'hinges' && totalElectricHingeQty > 0`, producing separate active and inactive leaf rows.

---

## C. Reconciliation: Who Writes What, and When

| Row source | Table written | When it runs | Dedup check before insert? |
|---|---|---|---|
| `buildPerOpeningItems()` structural sub-phase | `staging_hardware_items` (then promoted to `hardware_items`) | At extraction time (save/route.ts, jobs/[id]/run/route.ts) | No — structural rows are always emitted when `door_type`/`frame_type` are non-empty |
| `hwSet.items[]` in `buildPerOpeningItems()` set-items sub-phase | Same path | Same time | No — blindly appends all items from Python's item list |
| `promote_extraction()` SQL function | `hardware_items` from `staging_hardware_items` | On user promotion (wizard "Confirm & Promote") | No dedup — full replace of all openings for the project |
| `apply-revision/route.ts:277–283` | `hardware_items` directly (new doors only) | On "Apply Revision" flow | No dedup for new doors; existing doors are updated in place |
| `openings/[openingId]/items/[itemId]/route.ts:96–100` | `hardware_items` (existing row, PATCH) | Manual inline edit by user | N/A — updates single known row |

**The specific insertion producing the duplicate Frame and extra structural rows on 110-01B:**

The function is `buildPerOpeningItems()` (`parse-pdf-helpers.ts:2704`), specifically its **set-items sub-phase** (line 2775). At extraction time for run `5fd76705`, the Python extractor had already placed `{ name: 'Door', qty: 1 }` and `{ name: 'Frame', qty: 1 }` into `hwSet.items[]` for set DH1-10. `buildPerOpeningItems` appended those phantom items after its own correct structural rows. There was no second "legacy insertion function"; the single function both created the correct rows and blindly appended the bad ones.

---

## D. Proposed Remediation

### The code fix (already shipped)

The Python filter fix (commit `641f9f7`, line `extract-tables.py:1228`) is the right fix and is already in the codebase. It is the **only** code change needed. The TS helper is correct given correct input; the amplification is intentional and documented.

Matthew's hypothesis ("remove the legacy hardcoded Door/Frame-per-opening insertion") describes a pattern that does not exist as a standalone function. The `buildPerOpeningItems` structural sub-phase already matches the "intelligent extraction" he described: it is conditional on `door_type`/`frame_type` and applies active/inactive/shared semantics per leaf type. No removal is needed there.

### The production data cleanup (needed)

Rows extracted before `641f9f7` merged need to be removed from `hardware_items`. See section E below.

### Concrete intelligent-assignment rules

Per Matthew's guidance, the rules the pipeline already implements (and which should be documented and enforced as invariants):

| Opening type | Door rows emitted | Frame rows emitted | Notes |
|---|---|---|---|
| Single door | 1 × `Door` (`leaf_side=active`) | 1 × `Frame` (`leaf_side=shared`) | Only when door_type / frame_type non-empty |
| Pair door | 1 × `Door (Active Leaf)` + 1 × `Door (Inactive Leaf)` | 1 × `Frame` (`leaf_side=shared`) | One frame, two doors |
| Double-egress | Currently treated as pair (both leaves active) | 1 × `Frame` | `detectIsPair` detects "double" keyword; no special double-egress path exists |
| Dutch door | No special handling — treated as single | 1 × `Frame` | May be incorrect; flagged for review below |
| Borrowed light / sidelight / transom | No structural rows emitted if no door_type | Depends on frame_type | Extractor may or may not extract door_type; orphan filter removes them |

**Validation against golden PDFs:**

The five golden PDFs tested in CI are: `SMALL_081113.pdf` (CAA Nashville Yards, ~12 pages), `MEDIUM_306169.pdf` (Radius DC, 44 pages), `LARGE_MCA.pdf` (MCA Hardware, 82 pages), `RPL10_NW_Data_Center.pdf` (NW Data Center, 52 pages), and `CAA_Nashville_Yards.pdf` (107 pages, 60 doors).

Coverage gaps:
- **Pair doors**: MEDIUM (Radius DC) exercises pair doors — it is the PDF used in the regression test suite for pair detection and the `repro-double-structural` test.
- **Double-egress**: No golden PDF is specifically known to test double-egress. The keyword "double" fires the pair-door path; no separate double-egress structural test exists.
- **Dutch door, borrowed light, transom**: None of the golden PDFs explicitly cover these. Coverage is incomplete. If these door types appear in a project, the current code treats them as single or drops them as orphans.

---

## E. Rollout Plan

### 1. Migration to remove duplicate rows

The duplicated rows are identifiable because the phantom ones have:
- `name IN ('Door', 'Frame')` (bare, not `'Door (Active Leaf)'` etc.)
- `sort_order >= 2` on an opening that also has `name = 'Door (Active Leaf)'` at `sort_order = 0`

More precisely: for a pair opening, a bare `'Door'` row is wrong (pair openings should have `'Door (Active Leaf)'` and `'Door (Inactive Leaf)'`). For any opening, a second `'Frame'` row at a higher `sort_order` than another `'Frame'` on the same opening is a phantom.

**SQL sketch — count first, then delete:**

```sql
-- Step 1: Identify affected openings (dry run — count only)
SELECT
  o.id          AS opening_id,
  o.door_number,
  o.leaf_count,
  COUNT(*) FILTER (WHERE hi.name = 'Door')               AS bare_door_count,
  COUNT(*) FILTER (WHERE hi.name = 'Frame')              AS frame_count,
  COUNT(*) FILTER (WHERE hi.name = 'Door (Active Leaf)') AS active_leaf_count
FROM openings o
JOIN hardware_items hi ON hi.opening_id = o.id
GROUP BY o.id, o.door_number, o.leaf_count
HAVING
  -- Pair opening with a bare 'Door' row alongside 'Door (Active Leaf)'
  (o.leaf_count >= 2 AND COUNT(*) FILTER (WHERE hi.name = 'Door') > 0
    AND COUNT(*) FILTER (WHERE hi.name = 'Door (Active Leaf)') > 0)
  OR
  -- Any opening with more than one Frame row
  COUNT(*) FILTER (WHERE hi.name = 'Frame') > 1;

-- Step 2: Delete phantom rows (after verifying count above is expected)
-- Phantom bare 'Door' on pair openings:
DELETE FROM hardware_items
WHERE id IN (
  SELECT hi.id
  FROM hardware_items hi
  JOIN openings o ON o.id = hi.opening_id
  WHERE o.leaf_count >= 2
    AND hi.name = 'Door'
    AND EXISTS (
      SELECT 1 FROM hardware_items hi2
      WHERE hi2.opening_id = o.id AND hi2.name = 'Door (Active Leaf)'
    )
);

-- Duplicate Frame rows (keep lowest sort_order per opening):
DELETE FROM hardware_items
WHERE id IN (
  SELECT hi.id
  FROM hardware_items hi
  JOIN (
    SELECT opening_id, MIN(sort_order) AS keep_order
    FROM hardware_items
    WHERE name = 'Frame'
    GROUP BY opening_id
    HAVING COUNT(*) > 1
  ) dup ON dup.opening_id = hi.opening_id
  WHERE hi.name = 'Frame'
    AND hi.sort_order > dup.keep_order
);
```

Run the count query first and verify the number matches expectations (≈127 phantom rows across 22–27 sets for the known affected extraction run).

### 2. Deploy order

1. **Code is already deployed** (`641f9f7` is merged). No further code changes are needed.
2. **Run the count query** in Supabase SQL editor. Confirm row counts.
3. **Run the delete queries** in a transaction (`BEGIN; DELETE ...; SELECT COUNT(*) FROM hardware_items; ROLLBACK;` to verify, then re-run with `COMMIT`).
4. **Verify via activity_log** or direct query that new extractions produce no bare `'Door'`/`'Frame'` in `staging_hardware_items.items` (check a new extraction run after the fix).

### 3. Export impact

The CSV exporter (`src/app/api/projects/[projectId]/export-csv/route.ts:140–186`) outputs one row per `hardware_items` entry, including structural rows. It does **not** rely on duplicated rows for any computed total — it just mirrors what is in the DB. Removing the phantom rows will reduce the line count in exported CSVs for affected projects, but the remaining rows will be correct. No exporter change is needed before cleanup.

### 4. Progress counter impact

The door card progress counter (`src/app/project/[projectId]/door/[doorId]/page.tsx:769–771`) counts `totalItems = shared.length + leaf1.length + (isPair ? leaf2.length : 0)` across the grouped items. For 110-01B with 14 total items:

- 14 current = 2 correct structural (Active Leaf + Inactive Leaf) + 1 correct Frame + 1 phantom bare Door + 1 phantom duplicate Frame + real set items (hinges, lock, closer, etc.)
- After removing 2 phantom rows: `14 − 2 = 12` (or `14 − 3 = 11` depending on exact phantom count)

The counter displaying a smaller number after cleanup is correct and expected. The progress denominator will accurately reflect the number of items that actually need to be installed and checked.

---

## F. Risks and Open Questions for Matthew

1. **Openings without a set definition:** If a project has doors that never had a set assigned (or the extractor failed to extract `door_type`/`frame_type`), the current code emits zero structural rows for them. Those doors are caught by the orphan filter and excluded from staging. Is there a case where a door should be tracked despite having no matching set or door/frame type? If yes, the orphan filter would need an override mechanism.

2. **Project scope of cleanup:** The phantom rows exist in any project whose data was imported before `641f9f7` merged (2026-04-17). The cleanup migration above should be safe to run globally across all projects, since the distinguishing signal (bare `'Door'` on a pair that also has `'Door (Active Leaf)'`) is unambiguous. However, if any project intentionally has a bare `'Door'` item on a pair opening (e.g., a user manually added it), the delete query would remove it. Consider filtering to a specific `project_id` or checking `extraction_run_id` in the affected range as an extra safety gate.

3. **Is there a fallback to the phantom-emitting behavior?** No. The Python `NON_HARDWARE_PATTERN` filter is applied unconditionally; there is no code path that bypasses it. The TS amplification path only fires if phantom items reach `hwSet.items[]`, which the Python fix prevents.

4. **Dutch doors and other specialty types:** The current code has no explicit handling for Dutch doors, borrowed lights, sidelights, or transoms. If these appear in a project, the extractor may or may not capture `door_type`/`frame_type` for them, and the structural rows emitted (or not emitted) may be wrong. Matthew should determine whether the existing "flag for review" approach (orphan detection + Darrin questions) is sufficient or whether explicit rules are needed.

5. **Double-egress leaf assignment:** A double-egress pair emits two `'Door (Active Leaf)'` rows today (both leaves are active by the "pair" detection path). That is arguably correct per DHI convention, but should be verified against a real double-egress submittal.

6. **Re-extraction vs. cleanup:** For affected projects, a re-extraction using the fixed Python would regenerate clean data and replace existing production rows (the `promote_extraction` function deletes all existing openings for the project before inserting new ones). That is an alternative to the SQL cleanup, but requires user re-review of the extraction. The SQL cleanup is faster and less disruptive.

---

## Status

```
Investigation complete. No code changes in this PR (read-only analysis).

Root cause: extract-tables.py was not filtering bare "Door"/"Frame" tokens
from hwSet.items[] before commit 641f9f7 (2026-04-17). buildPerOpeningItems()
amplified those phantom items on top of its own correct structural rows.

Code fix: already shipped (641f9f7).
Remaining work: SQL cleanup of existing phantom rows in production.
No legacy hardcoded Door/Frame-per-opening function was found.
```
