# Roadmap — Door Hardware Tracker

> **The bar: every project must finish at 100% accuracy. Extraction gets us close, Darrin closes the gap. That is the product promise.**

Last updated: 2026-04-16 — reframed around DPR pilot (Grid-RR) accuracy + demo-ready dashboard. Phase 0–2 scaffolding is shipped and healthy; the work now is making the system *demonstrably reliable* on real DPR submittals and telling that story cleanly on the dashboard.

---

## Guiding Principles

1. **100% accuracy, delivered by extraction + Darrin.** The extractor will never be perfect. Darrin's job is to catch, question, and resolve anything that wasn't extracted cleanly — and the user must be able to *see* when that's complete. "Darrin has resolved everything" is a state the UI must render.
2. **Scope stays DFH.** Material submittal → approval → procurement → receive → install → QA is the end-to-end we're perfecting. Other scopes (interiors, MEP, finishes) and other submittal types (shop drawings, cut sheets) are parked until DFH is airtight.
3. **Real data as the test corpus.** Grid-RR is the pilot; Lyft/Waymo is the next template. Golden PDFs stay in place as regression gates, but the accuracy target is defined on these live DPR projects.
4. **Demo-first on the dashboard.** Every new project lands at 0% progress. The dashboard has to look great at 0 and let Matthew demo "their project at 50%" or "100%" during sales calls without writing fake data to the DB.

---

## Active Focus (next ~4 weeks)

Three parallel tracks. All others are maintenance or parking lot.

### Track 1 — 100% Reliable Extraction (Extraction + Darrin)

**Outcome:** For every DPR submittal uploaded, the final promoted dataset matches the PDF exactly, and the UI shows the user that's the case.

- **1A. Accuracy on live corpus (Grid-RR + Lyft/Waymo)**
  - Build a test harness that re-runs extraction on every real DPR submittal and diffs against a known-good snapshot.
  - Diffs become the bug queue. Each delta is either a fix in the extractor, a fix in normalization/reconciliation, or a Darrin question.
  - Target: zero unreconciled deltas on Grid-RR; zero on Lyft/Waymo once it's templated.

- **1B. Darrin coverage: every low-confidence field has a question**
  - Audit every confidence signal (`suggest_deep_extraction`, field-level confidence, Darrin-triggered corrections) and ensure Darrin asks a user question for anything that isn't high-confidence.
  - No silent acceptance of low-confidence data. No field promoted without either a green confidence badge or a Darrin resolution.

- **1C. User-visible certainty**
  - UI state: "Darrin has resolved everything — this project is ready to use."
  - Badge/banner that flips based on whether any unresolved low-confidence fields remain.
  - Sits on review page, dashboard header, and export gate.

- **1D. Regression safety net**
  - Golden PDF tests stay green (hard gate before merge).
  - Real-corpus harness runs as part of the pre-release check (nightly or on-demand).
  - Extraction paths matrix (`docs/architecture/extraction-pipeline.md`) stays current.

**Files to touch most often:** `api/extract-tables.py`, `src/lib/extraction/*`, `src/components/Darrin/*`, `src/components/ImportWizard/StepReview/*`, tests under `tests/` and `src/**/__tests__/`.

---

### Track 2 — Demo-Ready Dashboard

**Outcome:** A DPR executive can look at the dashboard for a brand-new project (0% progress) and immediately understand what they're looking at. During a sales call, Matthew can click a filter and demo what "50% through" or "100% delivered" looks like *for the exact project on screen*, with real opening/item counts but synthetic progress.

- **2A. Empty-state excellence (0% progress)**
  - Every panel (stage funnel, floor progress, zone heatmap, timeline, blocked items) renders meaningfully with zero workflow data.
  - No "no data" voids. Every panel explains what it *will* show once work starts.
  - Hero metric at 0% conveys "project set up, ready to execute," not "nothing here."

- **2B. Demo simulation filter**
  - Client-side only. No DB writes.
  - Toggle: `Off | 50% | 100%`. Visible only in a demo-enabled role or via a URL param initially.
  - Reads the project's real opening/hardware counts and distributes them realistically across stages:
    - 50% → most items in Installed/QA, rest spread back through Shipped/Received; ~half of blocked openings cleared.
    - 100% → everything in Done, all QA resolved, blocked items at zero.
  - Obvious visual indicator: "Demo view — simulated progress for [Project Name]."
  - Dynamic for any project; uses the real project name/counts so DPR sees *their* project.

- **2C. Dashboard reliability**
  - Correctness of aggregates (stage counts, floor/zone breakdowns) audited against ground truth.
  - Loading states, error states, empty states explicit and consistent.
  - Chart resize, mobile breakpoints, share-token refresh flows verified.

- **2D. Track 3 panels (feeds into 3A + 3B below)**
  - Submittal & procurement lifecycle panel.
  - Install progress panel.
  - Both honor the demo simulation filter.

---

### Track 3 — Lifecycle Tracking (Submittal/Procurement + Install)

A and B are independent flows. No forced sequencing.

#### 3A. Submittal & Procurement Tracking (NEW)

**Outcome:** For every hardware item, the user can see where it is in the material lifecycle — submitted, approved, in production at the manufacturer, shipped, received on site.

- Model the lifecycle states: `Submitted → Approved → In Production → Shipped → Received`.
- Decide whether this is a new table (`procurement_events` or `material_status`) or additional columns on `hardware_items`. Probably events table — transitions matter, and vendor/PO info attaches to each state.
- UI: a material-lifecycle view per project. Individual item lookup. Batch update when a PO is submitted/approved.
- Dashboard panel: count by stage, aging items (e.g., "shipped > 30 days, not received").
- Honors demo simulation filter.

#### 3B. Install Tracking (EXTEND)

**Outcome:** Field workers mark hardware installed → QA'd → done. Dashboard shows field progress cleanly.

- Leverage existing `stage` enum on `hardware_items` (migration 031) + workflow tabs (PR #217) + QA findings (PR #225 / migration 030).
- Gaps to close: consistent state transitions from the field UI, offline-sync correctness, per-item install attribution.
- Dashboard panel: count by stage, per-floor/zone install progress, blocked items.
- Honors demo simulation filter.

---

## Maintenance (shipped — keep healthy, no proactive feature work)

These are product surface areas that are working. Bugs get fixed; new features wait until accuracy + dashboard tracks are locked.

| Area | Shipped via | Current state |
|---|---|---|
| Wizard (upload, map, triage, questions, review) | Phases 0–2, PR #259, #267, #268, #276 | Stable; Darrin conversational flow is active investment surface via Track 1 |
| Review page | PRs #263, #264, #268 | Dual-mode view; keep polished but no redesign |
| CSV export | PR #265 | Filters + extraction source column shipped |
| Offline-first / PWA | PRs #218–#221 | Installable, service worker, sync queue |
| Activity log | PR #227 | Complete unions, feed page |
| Issue tracking | PRs #228, #230, #231 | Full CRUD, Kanban, email parsing |
| QA findings + punch list | PR #225, fix #232 | Multi-dimension tracking |
| Delivery tracking | PRs #222, #223 | `delivery_items` table, photos/damage |
| Dashboard (baseline) | PR #229 | Recharts panels; now goes deeper in Track 2 |
| Security (IDOR) | PR #210 | `assertProjectMember()` on all parse-pdf routes |
| Zoom / region extract | PRs #206–#209, #212, #214 | Stable |
| Deep extraction (Nuclear Option) | PRs #172–#179 | Complete, auto-fallback works |

---

## Parking Lot (Post-Accuracy Growth)

Explicitly **not** active. Listed so we can say "great idea, on the list, not yet."

- **Other DFH lifecycle stages** — warranty, change orders, closeout.
- **Other scopes** — interiors (partitions, ceilings, finishes), MEP, site.
- **Other submittal types** — shop drawings, cut sheets (prompts already exist), RFIs.
- **Cut sheet fetching prompt** — prompts folder has a stub; not wired up.
- **Turbopack production build** — `next build --turbopack` fails on `pdf-lib` (CJS) and `@supabase/supabase-js` (missing ESM types). Webpack production build works; Vercel production deploys are unaffected. Fix requires `turbopack.resolveAlias` config or dep updates.
- **`next build` as CI gate** — blocked on Turbopack above (if we want Turbopack) or can land immediately (if we accept webpack).
- **Python/TS classification unification** — duplicated logic; medium drift risk.
- **Transform function duplication** — partially addressed in PR #275 (wizard transforms extracted); audit remaining duplications.
- **Keyboard / ARIA on drag handles** — desktop accessibility for region selector.
- **Inline PDF viewer** — future feature mentioned in notes.
- **Product Families rethink** — open design question; wired to persistence in #267 but UX is still a placeholder.

---

## Deferred Debt

Known issues we are *consciously not fixing now*. Resurface if any becomes load-bearing.

| Item | Impact | Notes |
|---|---|---|
| E: Point/table threshold misfires | Occasional tight-zoom misrouting | `isPointScan = area < 0.15`; route by item count instead of bbox area |
| F: PDF re-parse on every page change | Performance, not correctness | `pdfBuffer.slice(0)` re-parses entire PDF; cache `PDFDocumentProxy` in ref |
| G: Zero Sentry on region-extract | Blind spot in error reporting | Only `console.error`; add `Sentry.captureException` in region-extract routes + client |
| J: No keyboard/aria on drag handles | Low; iPad is primary | Desktop a11y |
| K: Stale worktrees in `.claude/` | Housekeeping | Sweep on next fresh-clone git op |
| Storage policy naming | Cosmetic | Pre-existing |
| 164 skipped Python tests | By design | Require golden PDF fixtures not in repo |
| `test_zero_doors` xfail | Edge case | Extractor finds 1 opening in a 0-door doc |
| `next.config.ts` cleanup | Low | Deprecated `eslint` key; `middleware` → `proxy` rename |

---

## Bug Index (extraction regression gates)

| Bug | Description | Status |
|---|---|---|
| BUG-1 | Full PDF extraction finds doors | Passing |
| BUG-2 | No duplicate hardware items after dedup | Passing |
| BUG-3 | Quantity capping per category | Passing |
| BUG-4 | Mojibake cleaning | Passing |
| BUG-5 | Door number validation rejects HW set codes | Passing |
| BUG-7 | Quantity normalization (float, pair doors) | Passing (39 tests) |
| BUG-8 | Page classification for 306169 format | Passing (4 tests) |
| BUG-9 | Float division fix (modulo-based) | Passing |
| BUG-10 | AKN non-standard format | Fixed (PR #173) |
| BUG-11 | Test infrastructure expansion | Passing |
| BUG-12 | MCA field concatenation | Fixed (PR #169) |
| BUG-24 | BHMA finish code rejection | Passing |

Any change to `api/extract-tables.py`, normalization, reconciliation, or classification requires the three golden PDFs to stay green before merge.

---

## PDF Corpus Reference

21 test PDFs analyzed (report: `pdf_analysis_report.md`). Key stats:

| Metric | Value |
|---|---|
| Format types | Grid (5), Schedule (8), Kinship (3), Mixed (1), Reference (3) |
| Aggregate qty PDFs | 9 |
| Per-opening qty PDFs | 8 |
| PDFs with real pdfplumber tables | 2 of 21 |
| Distinct set heading formats | 10 |
| Difficulty range | 1/10 (Barnstable) to 9/10 (kinship-GTN3) |

**Live corpus (source of truth for accuracy target):** Grid-RR (DPR pilot project, primary). Lyft/Waymo (next template, staged for after Grid-RR is airtight).

---

## History (what got us here)

Detailed phase history moved to `docs/ROADMAP-history.md` (to be created) once space pressure warrants. For now, here is the condensed version:

### Phase 0 — Infrastructure & Stability (COMPLETE — PRs #155–#166)
Foundation: qty normalization, CI, background jobs, storage RLS, merge-based promote, hinge regression, retries, confirmations, vitest in CI, blind-spots audit.

### Phase 1 — Extraction Accuracy (COMPLETE — PRs #168–#173)
Qty convention detection, MCA field splitting, applyCorrections fuzzy matching, CP2 door sample cap, AKN format support.

### Nuclear Option — Deep Extraction (COMPLETE — PRs #172, #174, #175, #178, #179)
Confidence scoring (A), vision extraction (B), reconciliation engine, auto-fallback trigger, confidence UI.

### Phase 2 — Wizard UX + Bug Fixes (CLOSED — PR #275)
UX/skin overhaul (#185), comprehensive null safety (#186, #197), `write_staging_data` RPC (#183), hinge qty normalization (#188–#192), taxonomy overhaul (#193), `leaf_side` in SELECT (#196), context-aware re-scan (#198, #206–#209), zoom overhaul (#212, #214), electric hinge classification (#203), batch job path (#200), architecture docs (#199), migrations 020–025, code quality standards, IDOR fix (#210), transform dedup + migration renumber (#275).

### Phase 3 — Review Page + API Boundaries (PARTIAL — folded into Maintenance + Track 1C)
Review page redesign (#263), StepReview sub-components (#264), dual-mode view (#268), Zod validation on parse-pdf routes (#266), Product Families persistence (#267), rich classification context + correction UI (#276).

### Phase 4 — Export (PARTIAL — folded into Maintenance)
CSV filter query params + extraction source column (#265). No further proactive work until Track 1 complete.

### Field Ops & Offline (COMPLETE — PRs #217–#224)
Workflow phase tabs, offline-first architecture (SW, queue, sync), delivery tracking, qty audit columns.

### Dashboard, Issues, QA (COMPLETE — PRs #225, #227–#232)
QA findings + punch list (#225, fix #232), activity log completeness (#227), issue tracking schema (#228) + API (#230) + UI (#231), dashboard visualization (#229).

### Darrin (NEW NAME, PR #257)
Punchy → Darrin rename. Persistent Darrin in review (#268), conversational wizard (#259), avatar system (#256, #261), rich classification context + correction UI (#276). **This is now the active investment surface via Track 1B/1C.**

### Smartsheet Removal
Historical integration ripped out (#111, migration 015); Smartsheet sync is no longer a pilot deliverable. Export is CSV (#265).
