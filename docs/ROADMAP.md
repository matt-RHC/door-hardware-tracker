# Roadmap — Door Hardware Tracker

> **Guiding principle:** Hardware counts coming out of PDFs must be accurate before we build features on top of them. Scope is DFH only — door, frame, hardware submittals. All other submittal types, trade data, and non-DFH features go to the Parking Lot.

Last updated: 2026-04-18 (Track 1 §1D extraction architecture sequence added; Track 4 UX/Review Polish parked)

---

## Active Tracks

Three parallel workstreams. All three must reach baseline before the DPR pilot goes live.

---

### Track 1 — 100% Reliable Extraction

**Goal:** End-to-end extraction that a GC can trust without manually auditing every line.  
**Measure:** Pass all cases in the Grid-RR + Lyft/Waymo regression corpus with zero systematic errors.

#### 1A. Accuracy Bar — Grid-RR + Lyft/Waymo Corpus

The old "Phase 1 COMPLETE" label is retired because accuracy isn't a checkbox — it's a bar.  
Grid-RR and the Lyft/Waymo PDFs represent the hardest real-world cases in the current corpus.  
See: `docs/architecture/extraction-pipeline.md` for pipeline detail.

Status: **IN PROGRESS**  
Remaining gaps: populate from metrics log (sheet 2206493777547140) after next corpus run.

#### 1C. Extraction Invariants Layer

Post-promote structural gate that refuses silent garbage. Catches the four
bug classes behind the 2026-04-17 Radius DC regression:

- Opening with > 2 `Door*` rows
- Opening with both bare `Door` AND a `Door (Active/Inactive Leaf)` row
- Opening with > 1 `Frame` row
- `leaf_count=1` with ≠ 1 `Door*` row / `leaf_count=2` with ≠ 2 Door rows
- `openings.location` that matches a fire-rating regex
- A door listed under a sub-set's `heading_doors[]` promoted to the generic
  set token
- Per-leaf item qty-sum outside the expected band on pair openings

Status: **DONE** — 2026-04-17

- [x] `src/lib/extraction-invariants.ts` with `validateExtractionRun(runId, supabase)`
- [x] Unit tests per rule in `src/lib/extraction-invariants.test.ts`
- [x] Post-promote gate in `src/app/api/parse-pdf/save/route.ts` behind
      `DHT_INVARIANT_CHECKS=1` feature flag (warnings always returned to
      wizard; blockers only 500 when flag is on)
- [x] Audit script `scripts/audit-extraction-invariants.ts` + npm script
      `npm run audit:invariants -- --project <id> | --all`
- [x] Sentry breadcrumbs in `save/route.ts` and `buildPerOpeningItems` for
      input/output size + per-opening histogram context
- [x] Golden PDF smoke assertion in `parse-pdf-helpers.test.ts`

Rollout: flag stays `0` for one week after merge; flip default on after
the audit report confirms no false positives on the Grid-RR + Radius DC
corpus.

#### 1B. Darrin Review Layer

Darrin is the AI auto-resolve pass that runs after pdfplumber extraction. It catches quantity convention errors, ambiguous item names, and set-header misreads before the user sees them.

Status: **IN PROGRESS** — backend logic merged; human-confirm UI pending

Key behaviors:
- Auto-resolve all import paths (chunked + unchunked)
- Staging-first: Darrin writes candidates to staging, human confirms before promote
- Confidence scoring gates which items need human review vs. auto-accept

#### 1D. Extraction Architecture (5-piece sequence)

The extraction pipeline today relies on **implicit row typing** scattered across four regexes (`NON_HARDWARE_PATTERN` in `extract-tables.py`, `_PAIR_LEAF_NAMED_DOOR_RE` in `parse-pdf-helpers.ts`, the PRIMARY tier in `detectIsPair`, and the Fix 1 guard in `applyCorrections`). That works, but it makes the next phase of Darrin work (lane-based review, grouped questions, infill proposals) harder than it needs to be — every lane has to re-derive what kind of row it's looking at.

The 5-piece sequence below lands the structural changes needed to make lanes and the "Darrin resolved everything" ready-state achievable without rewrites.

| # | Piece | Type of fix | Size (est) | Why it comes here |
|---|-------|-------------|-----------|-------------------|
| 1 | **Row typing** | Information fix | M | Prerequisite — lanes and the ledger both reason about typed rows. Consolidates 4 implicit regexes into one explicit classifier: `hardware_item` / `door_leaf` / `door_frame`. Opening stays the parent entity. |
| 2 | **Darrin decision ledger** | Observability fix | S | Small, landable standalone. Supabase table `darrin_decisions` captures every Darrin action (confidence, reasoning, siblings, cost, outcome). Unblocks diagnosis of the lane work once it ships. Lane-agnostic, so it pays off even if lanes slip. |
| 3 | **Lane-based Darrin review** | Behavior fix | L | The actual product win — multi-lane CP2 (hardware / opening / leaf / frame) producing typed proposals (`infill_proposals`, `grouped_questions`) instead of free-form corrections. Needs #1 to know what kind of row each lane owns; needs #2 to prove the lanes are doing the right thing in prod. |
| 4 | **Canonical two-slot representation** | Shape fix | M | Every opening gets L1 + L2 slots; singles have L2 empty. Uniform shape downstream (review, export, simulation). Cleaner to land after lanes because lanes already write typed leaf rows. |
| 5 | **Rule-mining loop** | Process fix (ongoing) | Ongoing | Rides on top of the ledger. Accept-heavy Darrin actions promote to deterministic rules (no more LLM cost); reject-heavy actions get guardrails. Turns the ledger into a feedback loop for extraction accuracy. |

**Sequencing rationale**

- **Why ledger before lanes:** the ledger is lane-agnostic, so every lane inherits observability. Without it, we can't tell in production whether lanes are noticing the right things, grouping questions correctly, or burning cost on re-extracts that should have been infills.
- **Why typing first:** lanes reason about row kinds. If we skip typing, each lane re-implements the regex classification and they WILL diverge ("two implementations of the same rule WILL diverge").
- **Alternative lighter path:** ledger (#2) can ship against today's implicit typing, and the typing refactor (#1) can land alongside lanes (#3) — the first consumer that actually benefits from explicit types. Default sequence above is the cleaner path; this is the smaller first step if we want faster signal.

**Success criteria (Track 1 as a whole)**

- Extraction + Darrin resolves to 100% on Grid-RR and Lyft/Waymo corpora, DFH-only.
- `/debug/darrin/:projectId` shows every Darrin decision with reasoning and outcome.
- Rule-mining loop promotes at least one Darrin pattern to a deterministic rule within 30 days of ledger going live.
- Users see a clear "Darrin has resolved everything, this project is ready" state (per the Extraction + Darrin = 100% product promise).

Status: **Piece #2 IN PROGRESS** (this PR — foundation only, no behavior change). Pieces #1, #3, #4, #5 NOT STARTED.

---

### Track 2 — Demo-Ready Dashboard

**Goal:** A dashboard any stakeholder can read in 30 seconds. Used for sales demos and DPR pilot onboarding.  
**Measure:** Project page loads with realistic data and a clear "X% complete" story.

#### 2A. Per-Project Simulation Filter (50% / 100%)

Toggle a project between "50% installed" and "100% installed" states for demo purposes, without modifying real checklist data.

Status: **NOT STARTED**

Spec:
- Filter lives on the dashboard page (demo-only flag; hidden in production after pilot)
- Simulation overlays progress onto existing opening data
- Does NOT write to `checklist_progress` — purely presentational

---

### Track 3 — Material Lifecycle

**Goal:** Track hardware from submittal approval through delivery and install — one flow, not three separate tools.

#### 3A. Submittal/Procurement (New Build)

Pre-install phase for new construction: submittal review, approval tracking, procurement status per hardware set, expected delivery dates.

Status: **NOT STARTED**

#### 3B. Install Tracking (Extend Existing)

Build on the existing Receive/Install/QA workflow (PRs #217–#221) to close the loop: link delivery records to install events, flag backorders, surface blocked openings.

Status: **IN PROGRESS** — foundational schemas merged (PRs #222–#224); UI phase pending

---

### Track 4 — UX / Review Polish (DEFERRED, post-accuracy)

Captured here so it doesn't get lost. **Do not schedule until Track 1 pieces 1–3 are merged and verified in production.**

Source: Matthew's Google Drive review doc `TrackDoorHardware`, notes dated 2026-04-18.

- **Landing page cleanup** — remove PDF import, QR, and checklist buttons; remove "passkey coming soon" copy; brand SSO URL.
- **Post-creation auto-navigation** — jump into new project automatically; add 1/2/3/4 explainer on the project page.
- **Wizard sub-stage refactor** — 7 sub-stages spelled out in Matthew's notes. Maps almost 1:1 to the lane proposal (Track 1 §1D, piece #3), so revisit order once lanes ship: may be trivial after lanes.
- **Visual-updates-on-answer UX bug** — when a user answers "page 43 isn't the door schedule," the page should visibly disappear from the review UI. Today it doesn't.
- **Product families page redesign** — "overwhelming, I skip it every time."

Status: **DEFERRED** — gated on Track 1 §1D pieces 1–3.

---

## Maintenance

Functionally complete items that need polish or are gated on upstream work.

| Item | Status | Notes |
|---|---|---|
| Review page redesign (ex-Phase 3) | Deferred | Gated on Track 1 accuracy bar |
| Zod boundary validation | Deferred | Add Zod schemas for ImportWizard API responses |
| Export (ex-Phase 4) | Deferred | Gated on review page correctness |
| `next build` as CI gate | Deferred | Gated on Turbopack module resolution fix |
| Migration 022 renumber | Low | Two files share `022_` prefix |
| `next.config.ts` cleanup | Low | Remove deprecated `eslint` key |

---

## Parking Lot (Out of Scope — DFH Only)

Intentionally deferred. Not "someday" — explicitly out of scope until DFH extraction is solid.

- **Interiors / MEP / other trades** — different domain, different schema, different clients
- **Shop drawings / cut sheets / product data sheets** — not submittal tracking
- **Warranty / change orders** — different lifecycle phase, out of DFH scope
- **Turbopack production build** — module resolution errors with `pdf-lib` (CJS) + `@supabase/supabase-js` (missing ESM types); revisit after dependency updates
- **Cut-sheet fetching** — prompt exists in `prompts/`; wiring deferred
- **Product families rethink** — open design question; deferred until Track 1 is stable

---

## Deferred Debt

Known technical debt. Not blockers, but each carries latent risk.

| Item | Description | Risk |
|---|---|---|
| E: Point/table threshold misfires | `isPointScan = area < 0.15` misfires with tight zoom — route by item count instead of bbox area | Medium |
| F: PDF re-parse on every page change | `pdfBuffer.slice(0)` re-parses entire PDF on each `renderPage` — cache `PDFDocumentProxy` in ref | Low |
| G: Zero Sentry on region-extract | Only `console.error` — no `Sentry.captureException` in region-extract routes or client-side | Low |
| J: No keyboard/aria on drag handles | Low priority for iPad-first; needed for desktop accessibility | Low |
| K: Stale worktrees in .claude/ | Sweep `.claude/worktrees/` during next fresh-clone git operation | Low |

---

## Bug Index

Regression references. All items below are passing as of last merge.

| Bug | Description | Status |
|---|---|---|
| BUG-1 | Full PDF extraction finds doors | Passing |
| BUG-2 | No duplicate hardware items after dedup | Passing |
| BUG-3 | Quantity capping per category | Passing |
| BUG-4 | Mojibake cleaning | Passing |
| BUG-5 | Door number validation rejects HW set codes | Passing |
| BUG-7 | Quantity normalization (float division, pair doors) | Passing (39 tests) |
| BUG-8 | Page classification for 306169 format | Passing (4 tests) |
| BUG-9 | Float division fix (modulo-based) | Passing |
| BUG-10 | AKN non-standard format | Fixed (PR #173) |
| BUG-11 | Test infrastructure expansion | Passing |
| BUG-12 | MCA field concatenation | Fixed (PR #169) |
| BUG-24 | BHMA finish code rejection | Passing |

---

## PDF Corpus Reference

21 test PDFs analyzed (report: pdf_analysis_report.md). See `docs/ROADMAP-history.md` for per-PDF notes.

| Metric | Value |
|---|---|
| Format types | Grid (5), Schedule (8), Kinship (3), Mixed (1), Reference (3) |
| Aggregate qty PDFs | 9 |
| Per-opening qty PDFs | 8 |
| PDFs with real pdfplumber tables | 2 of 21 |
| Distinct set heading formats | 10 |
| Difficulty range | 1/10 (Barnstable) to 9/10 (kinship-GTN3) |

---

## History

Retired phase scaffolding — preserved for context. Labels below are no longer active.

### Phase 0 — Infrastructure & Stability (COMPLETE)

PRs #155–#166. Quantity normalization overhaul, CI noise reduction, background extraction infrastructure, storage RLS project scoping, merge-based promote (replaces destructive delete/reinsert), hinge dedup fix, retry/backoff, TypeScript CI (vitest), blind spots audit.

### Phase 1 — Extraction Accuracy (label retired — see Track 1A)

Core accuracy work merged in PRs #168–#173: quantity convention detection, MCA field concat fix, 5-tier fuzzy matching, door sample cap, AKN format support. The "COMPLETE" label is retired — Track 1A sets the new bar against the full regression corpus.

### Nuclear Option — Deep Extraction Mode (COMPLETE — backend + UI)

Multi-strategy extraction (pdfplumber + vision) with per-field reconciliation, confidence scoring, auto-fallback, and audit trail. PRs #172–#175, #178–#179.

### Phase 2 — Wizard UX + Bug Fixes (NEARLY COMPLETE)

UX/skin overhaul (#185), null safety (#186, #197), `write_staging_data` RPC (#183), hinge quantity normalization (#188–#192), hardware taxonomy overhaul (#193), `leaf_side` in API SELECT (#196), electric hinge classification (#203), context-aware re-scan (#198, #206–#209), security IDOR fix (#210), zoom overhaul (#212, #214), batch job path (#200), architecture docs (#199).

### Field Operations & Offline Readiness (COMPLETE — 2026-04-14/15)

Workflow phases / Receive-Install-QA tabs (#217), offline-first architecture (#218–#221, PWA manifest, service worker, sync coordinator), delivery tracking (#222–#223), extraction audit trail / `qty_source` (#224), QA findings + punch list (#225), activity log completeness (#227), dashboard visualization with Recharts (#229, migration 031), issue tracking schema + API + UI (#228, #230, #231, migration 032).

### Phase 3 — Review Page (moved to Maintenance)

Review page redesign, Zod schemas for ImportWizard API boundaries, product families design question. Gated on Track 1. See Maintenance section.

### Phase 4 — Export (moved to Maintenance)

Gated on Phase 3 / review page correctness. See Maintenance section.
