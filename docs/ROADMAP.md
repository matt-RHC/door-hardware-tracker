# Roadmap — Door Hardware Tracker

> **Guiding principle:** Hardware counts coming out of PDFs must be accurate before we build features on top of them. Export is gated on extraction accuracy.

Last updated: 2026-04-13 (evening)

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

## Phase 2 — Wizard UX Polish (NEXT)

The wizard flow shipped in Phase 0 (PRs #161–#162). These are refinements based on real usage:

- ImportWizard.tsx ArrayBuffer caching race condition (flagged, medium severity)
- Wizard question flow refinements
- Chunk failure UX — retry individual failed chunks
- Progress indicators / status messaging improvements
- Deep extraction progress UX polish (page-by-page progress)

---

## Phase 3 — Review Page & Data Presentation

- Review page redesign
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
| Smartsheet env vars in Vercel | Leftover from old integration — cleanup |
| Storage policy naming oddity | Pre-existing, cosmetic |
| 164 skipped Python tests | By design — require golden PDF fixtures not in repo |
| `test_zero_doors` xfail | Spec-doc edge case — extractor finds 1 opening in a 0-door doc |
| Cut-sheet fetching prompt | Exists in `prompts/` but not wired up |
| Inline PDF viewer | Mentioned as future feature |
| Sentry error monitoring | PR #180 open |

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
