# Roadmap — Door Hardware Tracker

> **Guiding principle:** Hardware counts coming out of PDFs must be accurate before we build features on top of them. Export is gated on extraction accuracy.

Last updated: 2026-04-15 (memory-layer sweep — capture PRs #215, #217–#224)

---

## Phase 0 — Infrastructure & Stability (COMPLETE)

PRs #155–#166. Foundation work:

- Quantity normalization overhaul — single TS division pass, Python annotates only
- CI noise reduction — xfail, ESLint rules, tsc + vitest in CI
- Background extraction job infrastructure (Phase 1 + Phase 2 wizard)
- Storage RLS project scoping, internal auth hardening
- Merge-based promote replacing destructive delete/reinsert
- Hinge duplication regression fix (electric hinge consolidation)
- Triage retry with exponential backoff + clean error messages
- Confirmation dialogs, chunk failure visibility
- TypeScript unit tests (vitest) added to CI pipeline
- Blind spots audit: activity trail, rate limiting, legal pages, backup docs

---

## Phase 1 — Extraction Accuracy (COMPLETE)

All items merged. Hardware counts are now significantly more reliable.

### 1A. Quantity Convention Detection (PR #168)
- Preamble-based detection ("Each opening to have:", "Each to receive:") replaces brittle statistical heuristic
- Per-heading door count normalization — single-door headings always per-opening
- Dual-quantity format support for SpecWorks `(total) per_door EA`

### 1B. BUG-12: MCA Field Concatenation (PR #169)
- `apply_field_splitting()` now called in `extract_all_hardware_sets()` — fixes all code paths
- 4 previously-xfail tests now passing, markers removed

### 1C. applyCorrections Fuzzy Matching (PR #170)
- `findItemFuzzy()` upgraded from 2 tiers to 5: exact → case-insensitive → normalized → substring → Jaccard
- Cross-category guard prevents "Hinge" matching "Closer"
- Ambiguous tied scores skip correction (safe default)

### 1D. CP2 Door Sample Cap (PR #171)
- `selectRepresentativeSample()` replaces `slice(0, 10)`
- One door per unique hardware set guaranteed, pair doors prioritized
- CP2 bumped to 15 doors, CP3 to 20

### 1E. BUG-10: AKN Format Support (PR #173)
- ESC/Comsense (SpecWorks) format now extracts properly
- `Heading #:` pattern, PRA/PRI pair notation, multi-line item joining

### Bug Index (updated)

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
| BUG-10 | AKN non-standard format | **Fixed** (PR #173) |
| BUG-11 | Test infrastructure expansion | Passing |
| BUG-12 | MCA field concatenation | **Fixed** (PR #169) |
| BUG-24 | BHMA finish code rejection | Passing |

---

## Nuclear Option — Deep Extraction Mode (COMPLETE — backend + UI)

Multi-strategy extraction with cross-validation for near-guaranteed accuracy.

### Phase A: Confidence Scoring (PR #172)
- Field-level confidence on every extracted item (name, qty, mfr, model, finish)
- `suggest_deep_extraction` flag when confidence is low
- Signals: empty fields, Punchy corrections, fuzzy match usage, statistical qty convention

### Phase B: Vision Extraction — Strategy B (PR #174)
- Claude Sonnet reads each schedule page as an image
- DHI-domain-aware prompt with hardware categories + manufacturer abbreviations
- Batched page processing (groups of 5), cut sheet filtering, continuation merging

### Phase C: Reconciliation Engine (PR #175)
- Cross-validates Strategy A (pdfplumber) vs Strategy B (vision)
- Per-field voting: agree → high confidence, conflict → prefer A for qty, B for names
- Audit trail: every field records what each strategy extracted and why the final value was chosen
- Weighted scoring: 0-100 overall confidence

### Phase D: Auto-Fallback Trigger (PR #178)
- Low confidence auto-queues deep extraction background job
- In-place job upgrade: normal job detects low confidence mid-run → becomes deep extraction
- Threshold constants in `DEEP_EXTRACTION_AUTO_TRIGGER_THRESHOLD`

### Phase E: Confidence UI (PR #179)
- Confidence badges (colored dots) on hardware item fields — hidden for high, yellow/red/gray for medium/low/unverified
- "Deep Extract" button with confirmation dialog and progress animation
- Auto-trigger banner: "Running deep extraction for higher accuracy"
- Collapsible audit trail showing reconciliation decisions per set

---

## Phase 2 — Wizard UX + Bug Fixes (NEARLY COMPLETE)

The wizard flow shipped in Phase 0 (PRs #161–#162). Phase 2 focused on UX polish, hinge accuracy, taxonomy, and pipeline robustness.

### 2A. UX/Skin Overhaul (PR #185)
- Border-radius, info density, table layout, and login cleanup
- Professional B2B aesthetic applied across all wizard and review pages

### 2B. Null Safety (PRs #186, #197)
- PR #186: `.toLowerCase()` null guards across 31 sites in 9 files
- PR #197: Comprehensive null safety for array access throughout the wizard pipeline (`.items?.length`, optional chaining on triage/classification arrays)

### 2C. write_staging_data RPC (PR #183)
- Supabase migration 023: server-side RPC replaces client-side multi-step staging writes
- Atomic operation — either all staging data is written or none is

### 2D. Hinge Quantity Normalization (PRs #188–#192)
- PR #188: Prevent mixed hinge type qty merging on pair doors
- PR #189: Route electric hinges to active leaf only in wizard preview
- PR #190: Adjust standard hinge qty on active leaf when electric hinge present
- PR #191: Null safety for `.items.length` calls in parse-pdf-helpers
- PR #192: Remove double subtraction of electric hinge qty from standard hinges
- Consolidated fixes across `normalizeQuantities`, `groupItemsByLeaf`, `buildPerOpeningItems`

### 2E. Hardware Taxonomy Overhaul (PR #193)
- Scope annotations (per_opening, per_leaf, per_door) on all hardware categories
- Granular categories split from coarse groupings (e.g., hinge types now distinguished)
- Foundation for correct per-leaf quantity routing

### 2F. leaf_side in API SELECT (PR #196)
- Root cause fix for persistent hinge qty bug: `leaf_side` was missing from API SELECT queries
- All Supabase queries now include `leaf_side` for correct per-leaf hardware assignment

### 2L. Electric Hinge Classification — Name+Model + Standalone CON TW (PR #203)
- Second root-cause fix for the electric-hinge-misclassification bug family
- `classifyItem()` now concatenates `item.name + item.model` before regex matching (previously checked `name` only, missing "CON TW8" which lives in `model`)
- Added standalone `CON TW` regex pattern for identifiers without the "Hinge" prefix
- Chunk insert resilience: non-critical inserts no longer abort the whole job on partial failure
- Regression tests (PR #204, merged): 52 dedicated tests in `electric-hinge-regression.test.ts` locking down PRs #196, #197, #203 fixes; full suite 429/429 green

### 2G. Context-Aware Re-Scan from Data Badge (PR #198) — FIXED (PRs #206–#209)
- Users can re-scan specific items from the data badge with PDF region selection
- All critical issues resolved in dedicated fix cycle:
  - PR #206: Name matching (uses item ID instead of name), page navigation (reads `pdf_page` from opening), merge strategy (targeted update instead of wholesale replacement), error feedback. Includes migrations 024/025.
  - PR #207: Silent failure fix (PDFRegionSelector 10px CSS threshold vs 3% normalized threshold out of sync) + item-first UX redesign (click item → region select)
  - PR #208: Raw text extraction fallback — when pdfplumber finds no tables in a region, falls back to extracting raw text lines and field matching (micro-extraction)
  - PR #209: Zoom view + multi-value field assignment — zoomed view for fine-tuning after initial selection; supports assigning extracted values to multiple fields

### 2M. Security: IDOR Fix (PR #210 — MERGED)
- All 5 user-facing parse-pdf routes accepted `projectId` without membership check
- `fetchProjectPdfBase64` uses admin client bypassing RLS — any authenticated user could access any project's PDF
- Fix: shared `assertProjectMember()` helper in `src/lib/auth-helpers.ts` + membership checks in all 5 routes
- Correctly preserves service-role bypass for background jobs

### 2N. Zoom Overhaul (PR #212 — MERGED)
- Canvas re-crop approach replaces broken CSS transform zoom — draws selected region onto temp canvas at up to 4x, displays as plain `<img>`
- `getHandleAtPositionZoomed()` fixes handle hit-test in zoom phase (14px threshold caused all corners to overlap for small selections)
- `pdf_page` null guard on modal mount condition
- iPad scroll containment: `overscrollBehavior: "contain"` + body `overflow: hidden` lock
- `imageDims` and `zoomImageUrl` cleared on page change to prevent stale state

### 2O. Zoom Infinite Spinner Fix (PR #214 — MERGED)
- Follow-up to PR #212: after auto-transition to zoom phase, the `<canvas>` DOM element (mounted only in `select` phase) was unmounted, so `imageRef.current` became `null` and `renderZoomCrop` silently returned → infinite "Rendering zoom..." spinner
- Fix: compute the zoom crop **synchronously in `handlePointerUp`** before `setPhase("zoom")`, so DOM is still mounted
- Added `fullPageImageRef` (off-screen `Image`) + `displayDimsRef` (cached dimensions) so handle-drag re-renders in zoom phase don't depend on the unmounted canvas
- `computeZoomCrop` extracted as a pure function (no DOM dependency)

### 2H. Batch Job Path (PR #200)
- `buildPerOpeningItems` added to batch job code path for structural rows
- `leaf_side` propagated through batch processing for data consistency

### 2I. Architecture Documentation (PR #199)
- Mermaid diagrams added to `docs/architecture/` for all pipeline modules
- Coverage: extraction pipeline, data model, hinge logic, taxonomy

### 2J. Supabase Migrations Caught Up (020–025)
- 020: Storage RLS project scoping
- 021: Merge extraction and staging transaction
- 022: Activity log + deep extraction columns (note: duplicate `022_` prefix — needs renumber)
- 023: `write_staging_data` RPC

### 2K. Code Quality Standards
- Added to project instructions (CLAUDE.md / AGENTS.md)
- Enforces null safety, explicit types, consistent error handling

---

## Known Issues / Next Priorities

### Awaiting Merge
- _None_ — all in-flight PRs merged as of 2026-04-15 sweep. Zero open PRs, working tree clean.

### Recently Merged
- **PR #215 (Responsive Layout)**: door detail fluid-width refactor, table horizontal scroll at <640px, shortened batch-action labels, rescan diff grid breakpoint tweak — merged
- **PR #217 (Workflow Phase Tabs)**: Receive/Install/QA tabs with mobile-optimized table — merged
- **PR #218 (Offline Sync Payload Fix)**: sync payload dropped workflow phases + wrong conflict key — merged
- **PR #219 (Sync Confidence UI)**: health heartbeat, pending count, per-item dots — merged
- **PR #220 (Migration 026)**: offline reconciliation columns on `checklist_progress` — merged
- **PR #221 (Offline-First Architecture)**: service worker, queue handler, sync coordinator, PWA manifest — merged
- **PR #222 (Migration 027)**: attachments expansion for delivery photos, damage tracking, per-item attribution — merged
- **PR #223 (Migration 028)**: `delivery_items` table + blocked-openings view — merged
- **PR #224 (Migration 029)**: `qty_total`, `qty_door_count`, `qty_source` audit columns on `hardware_items` — merged (resolves Backlog item I)
- **PR #210 (Security)**: IDOR fix — project membership enforcement on all parse-pdf routes (merged)
- **PR #212 (Zoom)**: PDFRegionSelector zoom overhaul — canvas re-crop, handle hit-test, scroll lock, null guards (merged)
- **PR #214 (Zoom spinner)**: infinite spinner fix — compute crop before phase transition (merged)
- **PR #211**: closed without merge — superseded by #212

### Medium Priority
- **Hinge pipeline simplification**: Merged (PR #202) — extracted shared hinge helpers, consolidated taxonomy cache, removed dead code across `normalizeQuantities`, `groupItemsByLeaf`, `buildPerOpeningItems`
- **Python/TS classification unification**: Python and TypeScript classification logic have diverged — medium risk of inconsistency (deferred)
- **Transform function duplication**: Wizard components and test files contain duplicated transform logic that should be extracted to shared utilities
- **`next build` fails on Turbopack**: Module resolution errors with `pdf-lib` (CJS) and `@supabase/supabase-js` (missing ESM types) — needs `turbopack.resolveAlias` config or dependency updates
- **Migration numbering**: Two files share the `022_` prefix — needs renumber

### Phase 3 Prep
- **Zod boundary validation**: Add Zod schemas for ImportWizard API responses (per Claude Code audit)
- **`next build` as CI gate**: Build is not currently gated in CI — should be added once Turbopack issues are resolved

---

## Field Operations & Offline Readiness (IN PROGRESS — 2026-04-14/15)

New feature area covering on-site workflow (Receive / Install / QA), deliveries, and offline-first capability for field use. Builds toward DPR pilot operational readiness.

### Workflow Phases (PR #217)
- Receive / Install / QA tabs on door detail page
- Mobile-optimized table layout for on-site use

### Offline-First Architecture (PRs #218–#221)
- **PR #221**: service worker, queue handler, sync coordinator, PWA manifest — app now installable and usable offline
- **PR #220 (Migration 026)**: offline reconciliation columns on `checklist_progress` for conflict resolution
- **PR #219**: sync confidence UI — health heartbeat, pending count, per-item sync dots
- **PR #218**: sync payload fix — was dropping workflow phases + using wrong conflict key

### Delivery Tracking (PRs #222–#223)
- **PR #223 (Migration 028)**: `delivery_items` table + blocked-openings view
- **PR #222 (Migration 027)**: attachments expansion — delivery photos, damage tracking, per-item attribution

### Extraction Audit Trail (PR #224 — Migration 029)
- `qty_total`, `qty_door_count`, `qty_source` columns on `hardware_items`
- `qty_source` values: `parsed`, `divided`, `flagged`, `capped`, `manual`, `region_extract`
- Promote paths updated across migrations 007–025 to carry audit fields from staging to production
- Supports DPR dispute resolution and extraction provenance

---

## Phase 3 — Review Page + API Boundary Validation + Zod Schemas

- Review page redesign
- Zod schemas for all API response boundaries (ImportWizard pipeline)
- Product Families rethinking (open question — needs design discussion)
- Per-door hardware display with confidence indicators
- Reconciliation audit trail in review page (beyond wizard)

---

## Phase 4 — Export

Gated on Phase 1 (done) + Phase 3. Can export once the review page correctly presents the data.

---

## Backlog (Not Prioritized)

| Item | Notes |
|---|---|
| E: Point/table threshold misfires | `isPointScan = area < 0.15` misfires with tight zoom selections — route by item count instead of bbox area |
| F: PDF re-parse on every page change | `pdfBuffer.slice(0)` re-parses entire PDF on each `renderPage` — cache `PDFDocumentProxy` in ref |
| G: Zero Sentry on region-extract | Only `console.error` — no `Sentry.captureException` in region-extract routes or client-side |
| ~~I: qty_source audit~~ | **RESOLVED (PR #224, 2026-04-15)** — `qty_source` + `qty_total` + `qty_door_count` now exist on `hardware_items`; promote paths carry them from staging |
| J: No keyboard/aria on drag handles | Low priority for iPad-first use case, needed for desktop accessibility |
| K: Stale worktrees in .claude/ | Sweep `.claude/worktrees/` during next fresh-clone git operation |
| Storage policy naming oddity | Pre-existing, cosmetic |
| 164 skipped Python tests | By design — require golden PDF fixtures not in repo |
| `test_zero_doors` xfail | Spec-doc edge case — extractor finds 1 opening in a 0-door doc |
| Cut-sheet fetching prompt | Exists in `prompts/` but not wired up |
| Inline PDF viewer | Mentioned as future feature |
| Sentry error monitoring | Integrated (PR #180 merged) |
| `next.config.ts` cleanup | Remove deprecated `eslint` key, address `middleware` → `proxy` deprecation |

---

## PDF Corpus Reference

21 test PDFs analyzed (report: pdf_analysis_report.md). Key stats:

| Metric | Value |
|---|---|
| Format types | Grid (5), Schedule (8), Kinship (3), Mixed (1), Reference (3) |
| Aggregate qty PDFs | 9 |
| Per-opening qty PDFs | 8 |
| PDFs with real pdfplumber tables | 2 of 21 |
| Distinct set heading formats | 10 |
| Difficulty range | 1/10 (Barnstable) to 9/10 (kinship-GTN3) |
