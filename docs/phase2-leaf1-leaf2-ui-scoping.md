# Phase 2: Leaf 1 / Leaf 2 UI for Pair Doors — Scoping Doc

**Status:** APPROVED (2026-04-12)
**Author:** Claude (session 2026-04-12)
**Approved by:** Matt Feagin (2026-04-12)
**Parent:** follow-up to Phase 1 (`claude/phase1-pair-detection-leaf-count-and-size`, commit `8f57e08`)
**Context:** User feedback on the door detail page for pair-door openings (Radius DC DH4A.1 / 120-02A)

## 1. Problem

Pair-door openings currently show a flat list of hardware items on the door detail page. The list mixes:

- items that belong to **both leaves** (hinges, closers, kickplates)
- items that only belong to the **active leaf** (exit device, lockset)
- items that only belong to the **inactive leaf** (flush bolt kit)
- items that are **shared by the opening** (frame, coordinator, smoke seal, threshold, astragal)

Workers reading this list have to mentally classify each item as "this is for leaf 1, this is for leaf 2, this is shared," which is error-prone and slow. The user's direct feedback:

> "what if we update the UI on the door page to have a Leaf 1 / Leaf 2 header? this should simplify some of the logic by adding guiderails and expected outputs, and if there is not leaf 2, it can be greyed out or somehow show that visually, make sense?"

Phase 1 shipped a data fix that doubles per-leaf quantities for pair openings, so the current flat list is numerically correct, but the mental model is still flat. Phase 2 makes the mental model explicit in the UI.

## 2. Goals

1. **Match the installer's mental model.** Each leaf is a physical object the installer handles separately. The UI should be organized by leaf.
2. **Resolve the per-leaf vs per-opening confusion permanently.** Instead of showing "qty 8 hinges" on a pair opening, show "4 hinges on Leaf 1" + "4 hinges on Leaf 2."
3. **Enable per-leaf checklist progress.** Installers should be able to mark Leaf 1 as QA'd before Leaf 2 is even hung.
4. **Make active-only / inactive-only items visually obvious.** Exit device on active leaf, flush bolt kit on inactive leaf — no mental mapping needed.
5. **Stay backward-compatible.** Single-door openings should look like they do today (no empty Leaf 2 section cluttering the view).

## 3. Non-goals

- Renaming Active/Inactive terminology in the database (keep DFH convention in data; use "LEAF 1 (ACTIVE)" / "LEAF 2 (INACTIVE)" in the UI — **approved compromise**).
- ~~Changing the import wizard flow~~ — **REVISED: Step 4 Review WILL also split per-leaf, done in the same session as the door detail page (Session 2.2), not deferred.**
- Retroactively fixing existing imports — user will re-import after Phase 2 ships. **No data migration script needed (confirmed).**
- Triple doors or larger assemblies — **out of scope, not needed for now.** Schema CHECK constraint changed from `BETWEEN 1 AND 4` to `BETWEEN 1 AND 2`.

## 4. Architectural decisions

### 4.1 Data model: store per-leaf or per-opening?

**Decision: store per-leaf for per-leaf items, per-opening for everything else. No changes to the existing schema of `hardware_items`.**

Rationale:
- Phase 1 doubles per-leaf items at save time into `hardware_items.qty`. Phase 2 will need to **undo that doubling** — store qty=4 (per-leaf) in the database, and let the UI render "4 on Leaf 1 + 4 on Leaf 2" for pair openings.
- Per-opening items (closer, lockset, exit device) stay stored as per-opening values (e.g., closer stored with qty=2 for a pair, meaning "1 closer for each of the 2 leaves"). The UI splits this visually at render time: "Leaf 1: 1 closer, Leaf 2: 1 closer."
- Per-pair items (flush bolt kit, coordinator, astragal) stored with qty=1 and displayed in the "Shared" section.
- Per-frame items (seals, threshold) stored with qty=1 and displayed in the "Shared" section.

**Phase 1 rollback:** the doubling block in `buildPerOpeningItems` gets reverted. The detectIsPair helper stays — it's still needed to know when to render Leaf 2.

### 4.2 Opening-level leaf count: where do we store it?

**Decision: add a `leaf_count INTEGER NOT NULL DEFAULT 1` column to the `openings` table via a new migration (012).**

Rationale:
- The current code re-derives pair vs single at every read site by looking at `heading_leaf_count > heading_door_count` or parsing the heading text. That's fragile and duplicated.
- A persisted `leaf_count` on each opening makes pair detection unambiguous and fast. The door detail page reads `openings.leaf_count` and renders `leaf_count` sections in the UI.
- Default 1 for single doors. Set to 2 at save time by the wizard when `detectIsPair(hwSet, doorInfo)` returns true.
- `leaf_count` is a better name than `is_pair` because it generalizes — if we ever need to handle triple doors (rare but possible in monumental construction), `leaf_count=3` works.

**Migration 012 preview:**

```sql
ALTER TABLE openings
  ADD COLUMN IF NOT EXISTS leaf_count INTEGER NOT NULL DEFAULT 1
  CHECK (leaf_count BETWEEN 1 AND 2);

ALTER TABLE staging_openings
  ADD COLUMN IF NOT EXISTS leaf_count INTEGER NOT NULL DEFAULT 1;

-- Update promote_extraction() to copy leaf_count from staging to production
-- (same pattern as migration 010 for pdf_page)
```

### 4.3 Per-leaf checklist progress: how do we track per-leaf completion?

This is the hardest decision.

**Option A (simple): no per-leaf progress.** Keep `checklist_progress` rows at the item level. User checks "Hinges INSTALLED" once and it applies to both leaves. Matches current behavior.

- **Pros:** zero schema changes, minimal UI work, fast to ship
- **Cons:** doesn't match the vision — installers can't mark Leaf 1 done separately from Leaf 2

**Option B (full): per-leaf progress rows.** Split each pair-door item's checklist into Leaf 1 and Leaf 2 states. Schema changes: add `leaf_index` to `checklist_progress` or create per-leaf progress rows.

- **Pros:** matches the installer's mental model perfectly, enables granular QA
- **Cons:** schema change, data migration for existing rows, UI needs to maintain two states per item, offline-sync implications

**Option C (compromise): shared progress for per-leaf items, single progress for per-opening items.** Hinges/closers/kickplates (per-leaf items) get a single checklist state that applies to both leaves ("all hinges installed for this opening"). Exit device (per-opening item, on active leaf only) gets a single checklist state. The UI shows the per-leaf sections visually but the checkbox is shared.

- **Pros:** minimal schema changes, preserves the visual leaf split, fast to ship
- **Cons:** breaks the "mark Leaf 1 done before Leaf 2" use case. If you install hinges on Leaf 1 first, you can't check them as installed until Leaf 2 is also hung.

**Recommendation: Option B (per-leaf progress). User confirmed: "progress needs to be trackable per leaf, and if there are revised submittals, progress needs to be updated per leaf." This is NOT deferred to Phase 2.1 — it ships with Phase 2.0 (Session 2.1 + 2.2).**

Implementation: add `leaf_index INTEGER NOT NULL DEFAULT 1` to `checklist_progress`. For pair doors, each per-leaf item gets TWO checklist rows (leaf_index=1 and leaf_index=2). Shared items (per_pair, per_frame) get one row with leaf_index=1. The UI renders per-leaf checkboxes on each leaf section.

Revision handling: when a revised submittal is applied via the compare wizard, per-leaf progress rows must be updated per leaf. If an item's qty changes on Leaf 1 only (e.g., hinge count revised from 4 to 5 on the active leaf), the Leaf 1 progress row resets but Leaf 2's stays.

### 4.4 Item classification at render time: do we use the taxonomy?

Yes. The door detail page calls `classifyItemScope(item.name)` from the hardware taxonomy to decide where each item goes in the layout:

- `per_leaf` → duplicated in Leaf 1 and Leaf 2 sections
- `per_opening` → visual split: total qty divided across leaves, one instance per leaf. E.g., "2 closers" shown as "1 on Leaf 1, 1 on Leaf 2"
- `per_pair` → "Shared (both leaves)" section
- `per_frame` → "Shared (both leaves)" section  
- `unknown` → "Other / Unknown" section (edge case, rare)

**Known inconsistency:** `hardware-taxonomy.ts:220` has closer as `per_leaf`, but Python's `DIVISION_PREFERENCE` has closer as `"opening"`. Phase 2 must reconcile this. The right answer for closer is `per_leaf` (physically there's one closer per leaf), but the current data stores closer as per-opening values (qty=2 for a pair). Options:

1. **Fix TS taxonomy to match Python:** closer becomes `per_opening`. Visual split: "2 closers" → "1 on Leaf 1, 1 on Leaf 2."
2. **Fix Python to match TS taxonomy:** closer becomes `per_leaf`. Normalize stores "1 closer per leaf," and the UI duplicates across leaves.

Recommendation: **Option 1 (fix TS taxonomy).** It's the cheaper change, matches what Python already stores, and doesn't require re-normalizing existing data.

### 4.5 UI layout

```
┌─────────────────────────────────────────────────────────┐
│ 120-02A                                                  │
│ [DH4A] [45MIN] [A] [F2] [PAIR]                          │
│ PROGRESS 0 / 23                                          │
├─────────────────────────────────────────────────────────┤
│ [HARDWARE] [FILES] [NOTES] [QR]                          │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ ══ SHARED ═══════════════════════════════════════════   │
│   FRAME             F2                          ■  ■  ■ │
│   FLUSH BOLT KIT    FB32                        ■  ■  ■ │
│   COORDINATOR       3780                        ■  ■  ■ │
│   SMOKE SEAL        5075 C 25'                  ■  ■  ■ │
│   THRESHOLD         (if applicable)             ■  ■  ■ │
│                                                          │
│ ══ LEAF 1 ═══════════════════════════════════════════   │
│   DOOR (ACTIVE)     Type A                      ■  ■  ■ │
│   HINGES NRP        5BB1 · qty 4                ■  ■  ■ │
│   HINGES CON TW8    5BB1 · qty 1                ■  ■  ■ │
│   EXIT DEVICE       9875L-F · qty 1             ■  ■  ■ │
│   ELEC EXIT MOD     ME-1520-9875 · qty 1        ■  ■  ■ │
│   CLOSER            4040XP EDA · qty 1          ■  ■  ■ │
│   PROTECTION PLATE  8400 10" × 35"              ■  ■  ■ │
│                                                          │
│ ══ LEAF 2 ═══════════════════════════════════════════   │
│   DOOR (INACTIVE)   Type A                      ■  ■  ■ │
│   HINGES NRP        5BB1 · qty 4                ■  ■  ■ │
│   CLOSER            4040XP EDA · qty 1          ■  ■  ■ │
│   PROTECTION PLATE  8400 10" × 35"              ■  ■  ■ │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

Key UX decisions:
- **Header order:** Shared first (stuff that applies to both leaves), then Leaf 1, then Leaf 2. This matches the installer's workflow — they install shared items first (frame, thresholds) then move to hanging and fitting each leaf.
- **Active vs Inactive labeling:** display "DOOR (ACTIVE)" on Leaf 1's door row, "DOOR (INACTIVE)" on Leaf 2's door row. Keep the DFH jargon but pair it with the leaf number for clarity.
- **Progress count in header:** the "0 / 23" counter shows completion across ALL items including duplicated per-leaf items. For a pair door with 8 hinges split into "4 on Leaf 1 + 4 on Leaf 2," each leaf's hinge row counts as 1 item in the tally (whether checklist progress is per-leaf or shared).
- **Single doors:** no Leaf 2 section. Render "SHARED" + "LEAF 1" only. For extreme minimalism, collapse to a flat list when there's only 1 leaf (opt-in toggle).

### 4.6 Mobile responsiveness

The split view must work on a 375px viewport. Key considerations:
- Each leaf section becomes a collapsible accordion on mobile, auto-expanded when the user scrolls to it
- Shared section is always expanded (it's short)
- Headers should be sticky so the installer knows which leaf they're scrolling in
- Bench/Field toggle per item must stay tappable at 44×44 (unchanged from PR #106)

## 5. Implementation plan

Three sub-sessions:

### Session 2.1 — Schema + data flow (backend)

- [ ] Migration 012: add `leaf_count` to `openings` and `staging_openings`, update `promote_extraction()` to copy it
- [ ] `StagingOpening.leaf_count` type + `writeStagingData` sets it from `detectIsPair(hwSet, doorInfo) ? 2 : 1`
- [ ] Wizard Step 4 save path populates `leaf_count` on each opening
- [ ] `DoorEntry` / opening read types include `leaf_count`
- [ ] API routes return `leaf_count` in opening payloads
- [ ] **Revert Phase 1's per-leaf doubling in `buildPerOpeningItems`** — data goes back to per-leaf storage, UI will handle the split
- [ ] Fix the `hardware-taxonomy.ts` closer/wire_harness inconsistency (change to `per_opening`)
- [ ] Unit tests for all of the above

### Session 2.2 — Door detail page UI + Step 4 Review split (frontend)

- [ ] Read `opening.leaf_count` and `classifyItemScope(item.name)` at the top of the door detail page
- [ ] Group items into `shared` / `leaf1` / `leaf2` arrays based on scope:
  - `per_leaf` → `leaf1` + `leaf2` (duplicated visual rows, same underlying item)
  - `per_opening` → `leaf1` + `leaf2` (split: qty ÷ leaf_count on each, or qty=1 on each if per-leaf by physical convention)
  - `per_pair` / `per_frame` / `unknown` → `shared`
- [ ] Render three sections: Shared → Leaf 1 → Leaf 2
- [ ] Section headers use "LEAF 1 (ACTIVE)" / "LEAF 2 (INACTIVE)" naming (approved compromise)
- [ ] Leaf 2 section is hidden if `leaf_count === 1`
- [ ] **Step 4 Review in the wizard also splits per-leaf** (same classification logic, same section headers — NOT deferred)
- [ ] Preserve all existing interactions (Bench/Field toggle, Report Issue, classify modal)
- [ ] Per-leaf checklist progress: each leaf section renders its own checkboxes per item (from `checklist_progress` rows with `leaf_index=1` and `leaf_index=2`). Shared items render one set of checkboxes.
- [ ] Mobile responsive: accordion collapse on narrow viewports
- [ ] Visual regression tests

### Session 2.3 — ~~Progress tracking decisions~~ Revision submittal per-leaf update

- [ ] ~~User testing of Session 2.1 + 2.2 output~~ (per-leaf progress is NOT deferred — ships with 2.2)
- [ ] ~~Decide Option A (shared progress) vs Option B (per-leaf progress)~~ (Option B confirmed)
- [ ] Verify revised submittal flow (compare wizard) correctly updates per-leaf progress when items change on one leaf
- [ ] Test: if hinge qty changes on Leaf 1 only, Leaf 1 progress resets but Leaf 2 stays
- [ ] Test: if a new item is added to Leaf 2 only, Leaf 1 progress is unaffected

## 6. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `leaf_count` populated wrong for existing imports (they're all `1` by default) | HIGH | Existing imports get the flat view via Leaf 2 hidden. User can re-import to get the new view. |
| Closer taxonomy fix breaks existing closer quantities | MEDIUM | Run golden PDF tests before merging. Add a migration script to convert closer qty values if needed. |
| Per-leaf UI makes the page visually busy on single doors | LOW | When `leaf_count === 1`, render a flat list (no section headers). Toggle to use the section view if user prefers. |
| Schema change breaks existing `promote_extraction()` | LOW | Migration 012 follows the same `CREATE OR REPLACE FUNCTION` pattern as migration 010. Tested against the function's current body before committing. |
| Installers don't actually want Leaf 1 / Leaf 2 visualization | MEDIUM | Ship Session 2.1 + 2.2 to staging, get user feedback before Session 2.3. If rejected, revert Session 2.2 and keep the flat list. The backend `leaf_count` column is harmless. |

## 7. Open questions — RESOLVED

1. **Naming:** "LEAF 1 (ACTIVE)" / "LEAF 2 (INACTIVE)" — **approved compromise.**
2. **Step 4 Review per-leaf split:** **YES, do it at the same time as the door detail page (Session 2.2), not deferred.**
3. **Triple doors:** **Out of scope. Not needed for now.** Schema constraint narrowed to 1-2.
4. **Data migration for existing Radius DC:** **No migration. User will re-import after Phase 2 ships.**
5. **Progress per leaf:** **YES. Progress must be trackable per leaf. Per-leaf checklist progress ships with Phase 2.0, not deferred. Revised submittals must update progress per leaf.**

## 8. Success criteria

Phase 2 is done when:

- [ ] A pair door's detail page shows clearly-labeled Shared / Leaf 1 / Leaf 2 sections
- [ ] Single door detail page looks visually similar to today (no empty Leaf 2 section cluttering the view)
- [ ] Closer shows as "1 on Leaf 1 + 1 on Leaf 2" on pair doors (not "2 closers" in a flat list)
- [ ] Hinges show per-leaf ("4 on Leaf 1 + 4 on Leaf 2"), matching the installer's mental model
- [ ] Smoke seals and thresholds show in Shared section (not duplicated)
- [ ] `leaf_count` is persisted on openings and doesn't need re-derivation at every read
- [ ] `detectIsPair` from Phase 1 is still the single source of truth for pair classification
- [ ] hardware-taxonomy.ts closer/wire_harness inconsistency resolved
- [ ] All golden PDF tests pass
- [ ] User validates the UI change on Radius DC and at least one other project before we merge

## 9. Related work

- **Phase 1** (this session): pair detection + per-leaf doubling — commit `8f57e08`
- **Python normalize_quantities fix:** PR #107 (merged)
- **Save validation fix:** PR #108 (merged)
- **Door detail card visual polish:** PR #106 (merged)
- **`hardware-taxonomy.ts:220` closer inconsistency:** flagged in Phase 1 commit message, needs resolution in Session 2.1
- **Architecture pivot to Step 0 background review:** deferred; should be scoped separately after Phase 2 ships
