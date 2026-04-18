# Wizard Questions Step — Section Grouping Plan

**Status:** Read-only plan. No code changes. Sequenced AFTER Prompt 3
(strategy propagation) — this plan depends on that design.

## Problem

The Import Wizard's "Questions" step (`src/components/ImportWizard/StepQuestions.tsx`)
renders every Darrin prompt in a single flat, vertically-stacked
conversation. The user cannot tell at a glance which answers fix the
current import and which set a rule that propagates to future imports.
All prompts share the same chat-bubble UI, so the purpose of each one
is visually indistinguishable.

Today every bubble lives inside one `<div className="space-y-4">`
container at `StepQuestions.tsx:455`, with no headers, dividers, or
grouping affordances.

---

## A) Inventory — current prompts and their classification

All prompts are emitted from `StepQuestions.tsx` in the order below.
File:line refers to the JSX block that renders each prompt.

| # | Prompt | file:line | Answer key (`QUESTION_KEYS`) | Classification |
|---|--------|-----------|------------------------------|----------------|
| 0 | Opener — "Hey, I'm Darrin. I just picked up your PDF…" | `StepQuestions.tsx:457–460` | — (no answer) | N/A |
| 1 | **Classify check** — "I went through all N pages… Does the breakdown look right?" with Schedule / Hardware / Reference / Cover page lists and heuristic warnings | `StepQuestions.tsx:463–568` (+ flags `571–584`, correction panel `587–602`) | `classify_check` (`ok` / `off` / `corrected`) | **Structural** |
| 1b | **Per-page reclassification / skip** (inside correction panel: Schedule / Hardware / Reference / Cover / Other, plus "Skip" checkbox) | `questions/ClassifyCorrectionPanel.tsx:180–233`; row picker `254–343`; page-type options `10–16` | POSTs `ClassifyOverride[]` to `/api/jobs/[id]/classify-overrides`; also stamps `classify_check=corrected` (`StepQuestions.tsx:293`) | **Structural** |
| 2 | **Door count sanity** — "I pulled N openings across M hardware sets. Does that ballpark match? If you know the opening count, type it in." | `StepQuestions.tsx:607–661` | `opening_count` (`about_right` / number) | **Semantic (scope)** |
| 3 | **Fire-rating split** — "Fire-rating field is filled in on X%… Does that split look right?" | `StepQuestions.tsx:664–736` | `fire_rated_pct` (`yes` / `most_rated` / `few_rated`) | **Semantic (scope)** |
| 4 | **Manufacturer list** — "I pulled N unique values from the manufacturer column… Is anyone missing?" / "Does this look like manufacturers?" when noisy | `StepQuestions.tsx:739–818` | `manufacturers` (`complete` / `wrong_column` / `also:<name>`) | **Semantic (scope)** |
| 5 | **Pair doors** — "I noticed N pair doors (e.g., D101A + D101B). Want me to split the hardware automatically?" | `StepQuestions.tsx:821–858` | `has_pairs` (`yes` / `no` / `not_sure`) | **Strategy (rule)** |
| 6 | **Orphan doors** — "I found N door entries with no hardware items… I'll exclude them automatically." | `StepQuestions.tsx:861–888` | `orphan_handling` (`exclude` / `keep`) | **Strategy (rule)** |
| 7 | Done — "All done! Found N doors ready for review." | `StepQuestions.tsx:891–904` | — (no answer) | N/A |

`QUESTION_KEYS` constant: `StepQuestions.tsx:109–116`.
Answers persist via `job.submitAnswers()` → `POST /api/jobs/[id]/answers`
(`useExtractionJob.ts:163–188`), debounced 1500ms
(`StepQuestions.tsx:19, 244–250`). Server-side storage is the
`job_user_constraints` Supabase table (`{job_id, question_key,
answer_value, answered_at}`), read by the orchestrator at
`api/jobs/[id]/run/route.ts` to build triage `userHints`. Classify
overrides are a separate endpoint (`/api/jobs/[id]/classify-overrides`)
and are saved explicitly, not debounced (`StepQuestions.tsx:270–304`).

Heuristic flags shown beneath prompt #1 are produced by
`questions/classify-heuristics.ts` (codes: `missing_hardware`,
`sequential_gap`, `small_job_overclassification`, `low_confidence`).
They are advisory text only — no user answer is collected on them.

---

## B) Proposed structure — three labeled sections

Inside the same `<div className="space-y-4">` we introduce three
section wrappers, each with a tiny uppercase header and a one-line
description. Bubbles stay as chat bubbles; only the outer grouping
changes.

### Section 1 — "Page classification — fix what Darrin mis-sorted"

> Tells Darrin which pages are Schedule / Hardware / Reference / Skip.
> Applies to this PDF only — re-runs extraction on save.

Contains: prompt #1 (classify check) and the `ClassifyCorrectionPanel`
expansion (#1b). Orange/yellow-tinted section header to signal
"structural — changing this re-extracts."

### Section 2 — "Scope check — confirm the numbers"

> Sanity-check Darrin's counts against what you uploaded. Your answer
> refines review; no rule is saved.

Contains: prompts #2 (door count), #3 (fire ratings), #4 (manufacturers).
Neutral header color — these are observations about the current import,
not decisions.

### Section 3 — "Extraction rules — set once, apply to this and future imports"

> Your pick here is saved as a default for future imports on this
> project. Change it anytime in project settings.

Contains: prompts #5 (pair doors), #6 (orphans). Accent-colored header
and a small pin/bookmark icon on each answered strategy bubble:
`✦ Saved as a project rule`.

**Strategy-rule badge.** Each strategy answer gets a small line under
the action row:

```
Saved as a rule for this project — future imports will default to "yes, split pair doors".
```

See [D) Dependencies](#d-dependencies) — this badge is truthful only
once the strategy store from Prompt 3 ships. Until then the text must
read `Your choice applies to this import only` and an inline
`// TODO: swap copy when strategy store lands` comment stays in the
code.

### Visual treatment

- Section header: `text-[11px] font-semibold uppercase tracking-wider`
  matching the existing "Guided Questions" heading style
  (`StepQuestions.tsx:351–356`).
- One-line description immediately under the header using
  `text-xs text-tertiary`.
- Thin `border-t border-border-dim` between sections.
- Chat bubbles stay untouched — we don't restyle `DarrinMessage`.

### Rendering order

Section 1 → Section 2 → Section 3 → Done message. Within each section,
current order is preserved. The conditional render guards
(`{classify && …}`, `{extraction && …}`, `{triage && …}`) move into
their respective sections. A section with zero visible prompts (e.g.,
triage hasn't returned yet) collapses to header-only "Waiting…" or is
hidden entirely — see C.

---

## C) Interaction details

### Do sections collapse when complete?

No. Rationale: chat bubbles already carry their answer state
(selected pill, entered number), so a user who scrolls back to verify
shouldn't have to re-expand. Instead we add a small right-aligned
status in the section header:

- `— answer pending` (any unanswered non-skippable prompt)
- `— 2 of 3 answered`
- `— answered` (all answered or explicitly skipped)

A future iteration can add collapse if the step becomes too tall, but
today the total vertical height is modest (7 bubbles max) and
collapsing would hide Darrin's observations which are the most useful
part.

### What's the "Continue to Review" gate?

**Today (current behavior).** `WizardNav` is at `StepQuestions.tsx:908–920`.
`nextDisabled={!job.isComplete && !job.isFailed}` — the only gate is
whether the extraction job finished. Answer completeness is NOT gated.
The user can skip every prompt and still continue.

**Proposed.** Keep the job-completion gate and add a soft
answer-completeness gate for Section 1 only:

- **Section 1 (Structural):** If `classify_check` is unanswered, show
  an inline warning next to "Continue to Review" — "Confirm the page
  breakdown first." Button stays enabled but with a warning tint.
  Rationale: structural answers drive re-extraction; silently
  advancing means the user is implicitly saying "the breakdown is
  fine."
- **Section 2 (Semantic):** No gate. These refine review heuristics;
  skipping is fine.
- **Section 3 (Strategy):** No gate, because the defaults are sensible
  (orphans already default to auto-exclude via Darrin's copy). If the
  user never answers, the rule is NOT persisted — we only write a
  strategy row when the user explicitly picks one.

### Pending-changes counter — where does it live, when does it flush?

**Today.** The only pending-changes counter is inside
`ClassifyCorrectionPanel` (prompt #1b): `overrideCount` at
`ClassifyCorrectionPanel.tsx:166–169`, surfaced in the header
(`:189–191`) and Save button label (`:229`). It flushes on Save
click via `onSave` (`:171–178`) which calls the
`classify-overrides` endpoint. Cancelling discards.

All other answers auto-save via the 1.5s debounced
`debouncedSave` → `submitAnswers` path
(`StepQuestions.tsx:19, 244–250, 226–242`). There is no cross-section
"N unsaved changes" indicator; the only UI feedback is the
`"Saving answers…"` text at `StepQuestions.tsx:394–398`.

**Proposed — tie to Prompt 2 (answers persistence).**

Prompt 2's findings (assumed: each answer should persist atomically
and survive reload via the `/api/jobs/[id]/answers` table) do not
require a cross-section counter. The debounced auto-save is fine for
Sections 2 and 3. For Section 1 we keep the explicit "Save N changes"
button inside `ClassifyCorrectionPanel` — structural corrections
trigger re-extraction, so batching them is a feature, not a bug.

Add one new thing: a small status line under the "Guided Questions"
header — `Saving…` / `Saved just now` / `Unsaved changes` — sourced
from the existing `saving` state (`StepQuestions.tsx:136`) plus a
"dirty since last successful save" boolean. This replaces the
bottom-right `"Saving answers…"` text which users currently miss.

### Empty / loading sections

- `classify` not yet available → Section 1 shows header + `Waiting for
  page classification…`
- `extraction` / `triage` not yet available → Section 2 / 3 show
  header + `Waiting for first extraction pass…`
- No pair doors detected (`triage.pair_doors_detected.length === 0`)
  → prompt #5 is omitted (current behavior, preserved).
- No orphans (`triage.orphan_doors.length === 0`) → prompt #6 is
  omitted (current behavior, preserved).
- If Section 3 ends up with zero visible prompts, hide the section
  entirely rather than showing an empty header.

---

## D) Dependencies

### Frontend-only changes

- Adding the three section wrappers, headers, and descriptions in
  `StepQuestions.tsx`.
- Per-section "N of M answered" status line.
- Soft warning for unanswered classify check.
- Replacement top-bar save status indicator.

These can ship without any backend work.

### Requires backend — depends on Prompt 3 (strategy store)

The Section 3 promise — "set once, apply to this and future imports"
— is only truthful if there's somewhere to persist the rule. As of
this plan no `import_strategy` / `project_strategies` table or
equivalent exists (grep for `strategy|strategies` in
`src/lib/schemas/`, `src/lib/`, and `supabase/migrations/` returns
only `reconciliation.ts` and unrelated uses). Persistence today is
per-job via `/api/jobs/[id]/answers` → `job_user_constraints` only;
there is no project-scoped rules table. **No formal Prompt 2 or
Prompt 3 plan documents exist in `docs/plans/` yet** — this plan
assumes their design but does not cite concrete file references.

**What needs to land from Prompt 3 before Section 3 ships as labeled:**

1. A table (likely `project_extraction_strategies` or similar) keyed
   by `project_id` (or `org_id`) with columns for `has_pairs_default`
   and `orphan_handling_default`.
2. A read path in the wizard's initial-phase fetch that pre-selects
   the current default on prompts #5 and #6 (`Already saved as
   "split pair doors — yes"`).
3. A write path — likely piggy-backed on `submitAnswers` server-side,
   or a new `PATCH /api/projects/[id]/strategies` route.
4. A UI entry point in project settings to view/edit the saved rules
   (out of scope for this plan, but the Section 3 copy promises it).

### Shipping order

1. **Prompt 2** — answers persistence correctness (prerequisite for
   even the debounced auto-save story).
2. **Prompt 3** — strategy store (prerequisite for Section 3 copy to
   be truthful).
3. **This plan** — visual grouping. If Prompt 3 has not shipped, ship
   Sections 1 + 2 with the labels as proposed, and ship Section 3
   with the transitional copy (`Your choice applies to this import
   only`) plus a follow-up ticket.

---

## Out of scope

- Restyling `DarrinMessage` itself.
- Changing answer keys / the `QUESTION_KEYS` constants.
- Removing any existing prompts or merging Section 2 items.
- Redesigning the PDF preview or the classify correction panel
  internals.
- Any migration of existing in-flight jobs' answers.

---

## Status

```
DONE: Wrote docs/plans/wizard-questions-sections.md — an inventory
  of every Questions-step prompt (with file:line + Structural /
  Semantic / Strategy classification), a three-section grouping
  proposal, interaction details (gating, pending-changes counter,
  empty states), and a dependency map on Prompt 2 (answers
  persistence) and Prompt 3 (strategy store).
PLANNED (not done): Implementation of the section wrappers in
  StepQuestions.tsx; strategy-rule badge copy swap once the
  strategy store lands.
NOTICED BUT DID NOT TOUCH:
  - The "Continue to Review" button today does not gate on answer
    completeness at all (StepQuestions.tsx:918) — flagged in
    section C but not fixed.
  - The "Saving answers…" indicator at StepQuestions.tsx:394–398
    is bottom-right and easy to miss — flagged as a replacement
    target.
  - ClassifyPageType has both `hardware_set` and `hardware_sets`
    (plural) variants handled throughout
    ClassifyCorrectionPanel.tsx:18–42, 111 — smells like a
    historical rename that was never cleaned up. Out of scope.
SHADOW CHANGES: None.
```
