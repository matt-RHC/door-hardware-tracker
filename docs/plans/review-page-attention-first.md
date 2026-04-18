# Review Page — Attention-First Redesign Plan

**Status:** Draft · 2026-04-17  
**Branch:** `claude/improve-opening-classification-wKLRS`  
**Author:** Claude (subagent)  
**Scope:** Design + implementation plan only. No code changes in this document.

---

## A. Current Component Map

All paths are relative to `src/` unless noted.

### Page / Orchestrator

| File | Role |
|------|------|
| `components/ImportWizard/StepReview.tsx` | Top-level step. Owns all state: door array, view mode, filter level, search, expansion, inline-edit cell, rescan modal, propagation modal. Calls `/api/parse-pdf/region-extract` (POST) for rescans. Renders `ReviewSummary`, `ReviewFilters`, and either `DoorView` or `SetView`. |
| `components/ImportWizard/ImportWizard.tsx` | Outer wizard shell. Routes between steps, manages `WizardState`, holds the PDF buffer in memory, feature-flags job vs. legacy wizard flow. |

### View Renderers

| File | Role |
|------|------|
| `components/ImportWizard/review/DoorView.tsx` | Renders a flat list of `DoorRow` cards, each expanding to `DoorDetailPanel`. Used when view mode = `'door'`. |
| `components/ImportWizard/review/SetView.tsx` | Renders hardware sets as panels with a sortable inline-editable door table inside each. Used when view mode = `'set'`. Contains nested `DoorTableRow` for cell-level editing. |
| `components/ImportWizard/review/DoorRow.tsx` | Collapsed summary row for one door: number, hw_set, location, fire_rating, confidence badge, issue hints. |
| `components/ImportWizard/review/DoorDetailPanel.tsx` | Expandable detail under a `DoorRow`: hardware items, rescan triggers, `SetPanel`, PDF preview. |
| `components/ImportWizard/review/SetPanel.tsx` | Hardware items grouped by leaf (shared / leaf1 / leaf2) with confidence badges and audit trail toggle. |

### Review Chrome

| File | Role |
|------|------|
| `components/ImportWizard/review/ReviewSummary.tsx` | Header card: door count stats, confidence bar, orphan notice, Darrin recap. **Currently hosts the Door/Set toggle** as a small button pair. |
| `components/ImportWizard/review/ReviewFilters.tsx` | Three filter pills (`All`, `Needs Attention`, `Missing Data`) plus search box. |

### Field Correction Flow

| File | Role |
|------|------|
| `components/ImportWizard/review/InlineRescan.tsx` | Modal: user draws a region on the PDF, extracts text or items; drives `FieldAssignmentPanel` in `'field'` mode. |
| `components/ImportWizard/review/FieldAssignmentPanel.tsx` | The "apply-to-doors" panel: pick field, edit value, toggle which doors to update. Pre-selects doors missing that field. Fires `onConfirm(field, value, doorNumbers[])`. |
| `components/ImportWizard/review/PropagationSuggestionModal.tsx` | Post-apply modal: shows server-generated fills for sibling doors. User accepts/rejects per-door-per-field. |

### Pure Logic

| File | Role |
|------|------|
| `components/ImportWizard/review/utils.ts` | `getDoorIssues()`, `getConfidence()` (high / medium / low), `isOrphanDoor()`, `confBorder()`. |
| `components/ImportWizard/review/rescan-apply.ts` | Immutable helpers: `applyFieldToDoors()`, `applyPropagationSuggestions()`. |
| `components/ImportWizard/review/types.ts` | `DoorStringField`, `FilterLevel`, `SortDir`, `DoorGroup`, `EditingCell`, `ISSUE_LABELS`. |

### API Routes

| File | Role |
|------|------|
| `app/api/parse-pdf/region-extract/route.ts` | POST. Crop + OCR a PDF bbox; in `field` mode detects field type, optionally fills sibling doors (`propagate=true`). Returns `siblingFills` map. |
| `app/api/parse-pdf/route.ts` | POST. Full document extraction → doors + hardware sets + flagged doors. |

### Feature-Flag Utility

| File | Role |
|------|------|
| `lib/feature-flags.ts` | `useJobWizardEnabled()` — reads `NEXT_PUBLIC_USE_JOB_WIZARD` env var or `?jobWizard=true` query param. The only feature-flag mechanism in the codebase. |

---

## B. Proposed New Default Layout

### Design Principles

1. **Attention-first, not count-first.** The page opens showing only the doors that need action. 75 auto-approved doors are noise until the user explicitly wants them.
2. **Group before list.** Doors share reasons for needing attention; fixing one reason in a group should fix all of them in one action.
3. **Promote the view toggle.** Door view vs. Set view is a primary navigation choice that affects every affordance below it; it belongs at the top as a segmented control.
4. **Progress by cleared items, not raw count.** The user is done when all flagged groups are resolved, not when they've scrolled past 80 rows.

### ASCII Wireframe

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Review Openings — Haverford Medical Center Submittal                   │
│                                                                         │
│  ┌──────────────────────┬──────────────────────┐                       │
│  │      Door view       │       Set view        │  ← segmented control  │
│  └──────────────────────┴──────────────────────┘                       │
│                                                                         │
│  ┌─ Attention needed ──────────────────────────────────────────────┐   │
│  │  2 of 5 items cleared   ████████████░░░░░░░░░░░░░░░░   [Next ▶]│   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ╔═ Missing door type  ·  3 doors ══════════════════════════════════╗  │
│  ║  Darrin: "I couldn't read door type for these. Draw the region." ║  │
│  ║  [ Fix all 3 → ]                                                 ║  │
│  ║  ─────────────────────────────────────────────────────────────  ║  │
│  ║  ▶  Door 042  ·  HW-1  ·  Rm 201 North          [Fix this one]  ║  │
│  ║  ▶  Door 043  ·  HW-1  ·  Rm 201 South          [Fix this one]  ║  │
│  ║  ▶  Door 057  ·  HW-3  ·  Corridor 2E           [Fix this one]  ║  │
│  ╚══════════════════════════════════════════════════════════════════╝  │
│                                                                         │
│  ╔═ Uncertain hand  ·  2 doors ══════════════════════════════════════╗ │
│  ║  Darrin: "Hand was ambiguous — 48% confidence. Please confirm."  ║  │
│  ║  [ Fix all 2 → ]                                                 ║  │
│  ║  ─────────────────────────────────────────────────────────────  ║  │
│  ║  ▶  Door 012  ·  HW-2  ·  Lobby Entry            [Fix this one] ║  │
│  ║  ▶  Door 019  ·  HW-2  ·  Stair B                [Fix this one] ║  │
│  ╚══════════════════════════════════════════════════════════════════╝  │
│                                                                         │
│  ▸  Show 75 auto-approved doors                                        │
│     (all confidence ≥ high · no missing required fields)               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Group-to-Issue Mapping

The existing `getDoorIssues()` in `review/utils.ts` already classifies every door. Groups for the attention panel map as follows:

| Group label | `getDoorIssues()` keys | Confidence bucket |
|-------------|------------------------|-------------------|
| Missing door number | `missing_door_number` | low |
| Missing hardware set | `missing_hw_set` | low |
| Missing door type | `missing_door_type` | medium |
| Missing frame type | `missing_frame_type` | medium |
| Missing location | `missing_location` | medium |
| Missing fire rating | `missing_fire_rating` | medium |
| Uncertain hand | `missing_hand` OR `low_confidence_hand` | medium |
| Low-confidence field | `low_confidence_{field}` (score < 0.6) | medium |

A door may appear in multiple groups (e.g., missing both location and door type). It should be counted once toward the "X of N cleared" progress, cleared when **all** its issues are resolved.

### "Fix for all N" Action

- Clicking "Fix all N →" on a group opens `InlineRescan` (or goes straight to `FieldAssignmentPanel` if the issue is a missing known field) pre-filled:
  - `triggerDoorNumber` = null (group-level trigger, not single door)
  - `doorsInSet` = scoped to all doors in the group, pre-selected
  - `detectedField` = the group's field (e.g., `door_type`)
- This is a **surface-level wiring change** in `StepReview.tsx` — the underlying `handleFieldApply` / `handleFieldApplyWithPropagation` already accept an arbitrary `doorNumbers[]` array.

### Progress Indicator Semantics

- "N of M attention items cleared" counts **unique doors that had at least one issue and now have none**.
- Auto-approved doors do not participate in the count — approving them silently is already the correct behavior.
- When `N === M`, show a brief celebration (Darrin `success` avatar + "All attention items resolved"), then enable the Next button.

### Door / Set Toggle Promotion

Move the `ViewMode` segmented control from `ReviewSummary` (buried in a header card) to the very top of `StepReview`, above the progress bar — a standard tab-bar pattern. The toggle remains localStorage-persisted (`'review.viewMode'`). No change to underlying rendering.

---

## C. Strategy Propagation

### Current State: One-Shot per Batch

The apply-to-doors flow today is **entirely session-local and batch-scoped**:

1. `FieldAssignmentPanel` → `onConfirm(field, value, doorNumbers[])` → `handleFieldApply()` updates in-memory `DoorEntry[]`.
2. If `propagate=true`, the server returns `sibling_fills` (other doors in the same set whose values can be inferred from the same PDF region). `PropagationSuggestionModal` shows these; the user accepts, and they are applied to the in-memory array.
3. Nothing is written to a durable store until `StepConfirm` calls the save API. Even then, the **rule** is not saved — only the resulting field values.
4. On the next PDF import, the extractor has no memory of what Matthew corrected last time.

This is the gap Matthew identified: when he fixes one door, the system should learn the pattern and apply it to all future doors that match.

### Proposed Strategy Object

A **strategy** is a persisted rule of the form:

> "When an opening matches condition C, set field F to value V."

#### Table: `extraction_strategies`

```sql
CREATE TABLE extraction_strategies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Matching conditions (JSONB for flexibility):
  -- e.g. {"hw_set": "DH1-10", "pair": true}
  -- e.g. {"door_type": "Dutch Door"}
  -- e.g. {"hw_set_prefix": "DH1-"}
  condition     JSONB NOT NULL,
  field_name    TEXT NOT NULL,        -- 'location' | 'hand' | 'fire_rating' | 'door_type' | 'frame_type' | 'leaf_count'
  field_value   TEXT NOT NULL,
  shape_rule    JSONB,                -- null for scalar fields; see §Opening Shape Rules below
  source        TEXT DEFAULT 'manual_review',  -- 'manual_review' | 'propagation' | 'api'
  confidence    NUMERIC(3,2) DEFAULT 1.0,
  created_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  applied_count INTEGER DEFAULT 0,   -- how many openings have been set by this rule
  project_id    UUID REFERENCES projects(id) ON DELETE CASCADE  -- NULL = company-wide
);

CREATE INDEX ON extraction_strategies (company_id, field_name);
CREATE INDEX ON extraction_strategies (project_id) WHERE project_id IS NOT NULL;
```

#### Scoping: project vs. company-wide

- `project_id IS NULL` → company-wide strategy (reusable across all projects for this customer).
- `project_id IS NOT NULL` → project-scoped override (takes precedence over company-wide).
- When Matthew clicks "Save as rule for all future imports", the UI offers a toggle: **This project only / All future projects for this customer**.

#### Condition matching

Conditions are JSONB objects evaluated against a flattened view of the door + set:

| Condition key | Matches against |
|---------------|-----------------|
| `hw_set` | Exact `DoorEntry.hw_set` |
| `hw_set_prefix` | `DoorEntry.hw_set` starts with value |
| `pair` | `HardwareSet.pair_handling !== null` |
| `door_type` | `DoorEntry.door_type` (for shape rules) |
| `fire_rating_present` | Boolean — fire rating is not empty |

Start with exact-match conditions; fuzzy/regex conditions can be added later.

#### How the extractor consults strategies

After extraction and before surfacing the Review page, a new step (`applyStrategies`) runs:

```
for each DoorEntry in extractedDoors:
  for each strategy in matchingStrategies(door, hwSet):
    if door[strategy.field_name] is empty OR door.field_confidence[field] < strategy.confidence:
      door[strategy.field_name] = strategy.field_value
      door.field_confidence[field] = strategy.confidence
      mark door as 'strategy_filled' (new source flag for audit trail)
      increment strategy.applied_count
```

Doors filled by a strategy still appear in the auto-approved section **unless** the strategy confidence is below 0.8 (configurable), in which case they appear in an "Auto-filled — please confirm" attention group.

#### Saving a strategy from the Review page

After a user applies a value via `FieldAssignmentPanel`, the confirmation UI gains a new optional step:

```
┌────────────────────────────────────────────────────┐
│  Applied "DELHR" → location for 4 doors.           │
│                                                    │
│  💡 Save as rule for future imports?               │
│     When hw_set starts with "DH1-", location = DELHR│
│     [ Save for this project ]  [ Save for all ]   │
│     [ No thanks ]                                  │
└────────────────────────────────────────────────────┘
```

The pattern suggestion is auto-generated from the door's `hw_set` value (prefix or exact match, whichever is narrower while still covering all affected doors). The user can edit it before saving.

### Opening Shape Rules

Opening shape rules are a special class of strategy where `shape_rule` is non-null. They capture **structural** corrections, not scalar field values — specifically: how many Doors and Frames an opening should have based on its type.

Today, Frame/Leaf assignment is hardcoded in the Python extractor (the logic this document references as the subject of `docs/investigations/hardcoded-door-frame-legacy.md`, which does not yet exist but is planned). When Matthew corrects a case — e.g., "this Dutch door should have 2 Doors + 2 Frames, not 1 + 1" — the Review page should offer to save that correction as an opening shape strategy.

#### Shape rule extension to `extraction_strategies`

```jsonc
// condition
{ "door_type": "Dutch Door" }

// shape_rule (field_name = 'opening_shape', field_value = null)
{
  "leaf_count": 2,
  "door_count": 2,
  "frame_count": 2,
  "notes": "Dutch doors have active + inactive leaf, each needing a door and frame unit"
}
```

When the extractor encounters a door matching the condition, it applies the shape rule to override the hardcoded logic. The audit trail in `AuditTrailPanel` gains a new `strategy_filled` source indicator.

Cross-reference: once `docs/investigations/hardcoded-door-frame-legacy.md` is written (planned work, Prompt 1), the remediation section should point here as the user-facing correction pathway.

---

## D. Migration Path

### Feature Flag

The new layout can ship behind an env-var flag using the existing pattern in `lib/feature-flags.ts`:

```
NEXT_PUBLIC_REVIEW_ATTENTION_FIRST=true
```

or `?reviewAttentionFirst=true` query param. No new infrastructure needed. The flag gates the `StepReview` rendering path; the underlying components (`FieldAssignmentPanel`, `PropagationSuggestionModal`, `InlineRescan`) are unchanged.

### Door view / Set view toggle semantics

The toggle semantics do **not** change — `'door'` still renders `DoorView`, `'set'` still renders `SetView`. What changes:

- **Placement**: moved from `ReviewSummary` interior to a top-level segmented control above the progress bar.
- **Default**: today defaults to `'door'` (from localStorage). The new layout has no reason to change this default.
- **Scope**: the attention-grouping is a **filter layer** that sits above both views. Whether the user is in door or set view, the attention-first grouping applies. The "Show N auto-approved" disclosure reveals the full door/set list for the collapsed section.

No localStorage key changes; the `'review.viewMode'` key remains compatible.

### Changes Required (implementation scope)

1. **`StepReview.tsx`** — Add attention-group computation above the render; add "Fix all N" handler that pre-populates `InlineRescan`/`FieldAssignmentPanel` with a group's door list; wire progress counter.
2. **`ReviewSummary.tsx`** — Remove the Door/Set toggle; it moves up to `StepReview`.
3. **New segmented control** — Inline in `StepReview` (or tiny shared component). ~20 lines.
4. **New `AttentionGroup` section component** — Renders the bordered group card with "Fix all N" and per-door rows. Consumes existing `DoorRow` for the per-door secondary path.
5. **`FieldAssignmentPanel`** — Add optional "Save as rule" footer (only shown post-confirm, gated by strategy feature flag).
6. **New API route** `POST /api/projects/[id]/extraction-strategies` — Create/list strategies.
7. **New migration** `048_extraction_strategies.sql`.
8. **Python extractor** — `applyStrategies()` pre-processing step before surfacing results.

### Golden PDF Test Gap

There are **no golden tests that exercise the Review page UI behavior** (confirmed: `scripts/run-golden-suite.mjs` tests extraction output, not Review page interactions). The gap to fill:

- Add a Playwright/Vitest test that loads a known PDF result, verifies attention groups render correctly, simulates a "Fix all N" action, and asserts the door array is updated.
- Add a golden fixture: a `ClassifyResult` with deliberate missing fields, used as the baseline for these tests.

This is a known gap; it should be created alongside the new layout, not deferred.

---

## E. Risks and Open Questions

### 1. Auto-approved doors that actually need human eyes

`getConfidence()` returns `'high'` for any door where `hw_set` is non-empty, `door_number` is present, and fewer than 3 optional fields are missing, **regardless of individual field confidence scores** — as long as no single field is below 0.6. A door could have `location` at 0.65 confidence (above the threshold) and still be auto-approved, even though the value might be wrong.

**Risk:** Matthew silently approves an incorrect location on a high-count set.

**Mitigation options:**
- Lower the `low_confidence` threshold from 0.6 → 0.7 for location/hand specifically (the fields most likely to be misread).
- Add a "low-confidence but approved" disclosure in the auto-approved section: "3 doors have fields below 75% confidence — expand to review."

### 2. Strategy store scope: per-project vs. per-company vs. global

Currently, hardware-set naming conventions (DH1-*, SC-*, etc.) tend to be customer-specific, not universal. A strategy that works for Haverford Medical Center may incorrectly fill values for a different customer's DH1-10 set.

**Recommendation:** Default to **company-scoped** strategies (all projects for the same customer share them), with a per-project override path. Do not make strategies global across all customers.

### 3. Strategy conflicts and precedence

Two strategies might match the same door with conflicting values. The system needs a precedence rule before the first strategy is saved.

**Recommendation:** Most-recently-created wins, with project-scoped overriding company-scoped. Surface conflicts in the strategy management UI (future work) rather than silently picking one.

### 4. Opening shape rules depend on unwritten investigation

The `docs/investigations/hardcoded-door-frame-legacy.md` document referenced in the task does not yet exist. The shape rule design in §C assumes a clear inventory of the current hardcoded logic. If that logic is more complex than expected (e.g., it depends on manufacturer-specific rules, not just door_type), the `condition` JSONB schema may need to expand.

**Recommendation:** Write the investigation first. The shape-rule strategy can be implemented in a second pass once the existing logic is mapped.

### 5. Propagation suggestions vs. saved strategies: user mental model

The existing `PropagationSuggestionModal` is ephemeral (session-only). The new "Save as rule" footer is durable. These are different concepts but both surface after the same user action (fixing a field). There is a risk of confusion: "Did I already save this as a rule, or did I just fix it for this batch?"

**Recommendation:** Add a visual distinction in the confirmation flow: "Applied to this import (4 doors)" vs. "Saved as rule for future imports." The audit trail in `AuditTrailPanel` should show `strategy_filled` as a distinct source.

---

## Questions for Matthew

Before implementation begins, please answer the following:

1. **Strategy scope default:** When you fix a field for a set (e.g., "DH1-10 → location = DELHR"), should the system default to asking "Save for all future projects at this customer?" or is it too dangerous to apply rules across projects without an explicit opt-in each time?

2. **Low-confidence auto-approvals:** Are you comfortable with doors at, say, 65% field confidence being auto-approved without a flag, or would you like a secondary "soft flag" group for doors that passed the threshold but aren't high-confidence (e.g., "8 doors — review if time allows")?

3. **Opening shape rules priority:** Is the Frame/Leaf correction workflow (Dutch door → 2 Doors + 2 Frames) important enough to be in the first implementation pass, or should it follow after the simpler scalar-field strategies (location, hand, fire_rating, door_type) are working and proven?

4. **Group-level "Fix all N" UX:** When you click "Fix all 3" for the Missing Door Type group, should the system open the PDF region-selector (letting you draw the region that contains the door type), or go straight to the field entry form? The region-selector is more accurate but requires an extra interaction.

5. **Auto-approved section behavior:** Should the "Show N auto-approved" disclosure be collapsed by default on every visit, or should it remember its open/closed state in localStorage (like the view mode)? Collapsing by default enforces the attention-first mental model; remembering state may be friendlier for repeat reviewers who like to scan the full list.
