# Roadmap — Door Hardware Tracker

> **Guiding principle:** Hardware counts coming out of PDFs must be accurate before we build features on top of them. Export is gated on extraction accuracy.

Last updated: 2026-04-13

---

## Phase 0 — Infrastructure & Stability (DONE)

Everything merged today (PRs #155–#166). Included:

- Quantity normalization overhaul — single TS division pass, Python annotates only
- CI noise reduction — xfail, ESLint rules, tsc check in CI
- Background extraction job infrastructure (Phase 1 + Phase 2 wizard)
- Storage RLS project scoping, internal auth hardening
- Merge-based promote replacing destructive delete/reinsert
- Hinge duplication regression fix (electric hinge consolidation)
- Triage retry with exponential backoff + clean error messages
- Confirmation dialogs, chunk failure visibility

---

## Phase 1 — Extraction Accuracy (CURRENT PRIORITY)

Nothing else matters until hardware counts are reliably correct. Three known issues, ordered by impact:

### 1A. BUG-12: MCA Field Concatenation

**Status:** 4 xfail tests waiting in `test_mca_extraction.py`
**Problem:** pdfplumber reads all hardware item details (name, manufacturer, model, finish) into a single `name` field for MCA-format PDFs. The extractor doesn't split them back out.
**Impact:** Any MCA-format submittal produces unusable hardware data — items appear as one giant concatenated string.
**Tests exist:** Yes — 4 tests define exactly what "fixed" looks like.
**Scope:** Python extraction layer (`api/extract_tables.py` or column-mapping logic).

### 1B. applyCorrections Fuzzy Matching

**Status:** Known gap, no tests yet
**Problem:** `findItemFuzzy()` in `parse-pdf-helpers.ts` only does exact + case-insensitive matching. If Punchy says "Continuous Hinge" but the PDF extracted "CONTINUOUS HINGE, 83"" the correction silently drops.
**Impact:** Punchy's CP2 corrections fail to apply on items with trailing specs, abbreviations, or format differences. This makes Punchy's review less effective — it finds issues but can't fix them.
**Next step:** Add normalized/substring matching to `findItemFuzzy()`. Add test cases.

### 1C. CP2 Door Sample Cap

**Status:** Known gap, partially addressed
**Problem:** `callPunchyPostExtraction()` sends `doors_sample: allOpenings.slice(0, 10)` — Punchy's detailed review only sees the first 10 doors. It also sends `all_doors` as a compact summary (door number + set ID only), so Punchy can see the full project but can't deeply review doors 11+.
**Impact:** On large projects (50+ doors), patterns that only appear later in the schedule are invisible to CP2.
**Next step:** Evaluate whether the compact `all_doors` list is sufficient, or if the detailed sample needs to be larger/smarter (e.g., one door per unique hardware set instead of first-10).

### 1D. BUG-10: AKN Non-Standard Format

**Status:** Excluded from cross-PDF tests, no fix attempted
**Problem:** AKN (ESC/Comsense) PDFs use a non-standard format that the extractor can't parse reliably.
**Impact:** One known vendor format produces bad data. Unknown how many real submittals use this format.
**Next step:** Assess frequency in real submittals before investing in a fix.

---

## Phase 2 — Wizard UX Polish

After extraction is solid. The wizard flow (Phase 1/2 background jobs) just shipped — these are refinements:

- ImportWizard.tsx ArrayBuffer caching race condition (flagged, medium severity)
- Wizard question flow refinements based on real usage
- Chunk failure UX — retry individual failed chunks
- Progress indicators / status messaging improvements

---

## Phase 3 — Review Page & Data Presentation

- Review page redesign
- Product Families rethinking (open question — needs design discussion)
- Per-door hardware display accuracy (depends on Phase 1 being solid)

---

## Phase 4 — Export

Gated on Phase 1 + Phase 3. Can't export until extraction is accurate and the review page correctly presents the data.

---

## Backlog (Not Prioritized)

| Item | Notes |
|---|---|
| Smartsheet env vars in Vercel | Leftover from old integration — cleanup |
| Storage policy naming oddity | Pre-existing, cosmetic |
| 164 skipped Python tests | By design — require golden PDF fixtures not in repo |
| `test_zero_doors` xfail | Spec-doc edge case — extractor finds 1 opening in a 0-door doc |
| BUG-12 tests in `test_extract_tables.py` | Additional BUG-12 coverage beyond MCA-specific tests |
| Cut-sheet fetching prompt | Exists in `prompts/` but not wired up |
| Inline PDF viewer | Was mentioned as Batch 5C in earlier discussions |

---

## Bug Index

For reference — all tracked bugs and their current status:

| Bug | Description | Status |
|---|---|---|
| BUG-1 | Full PDF extraction finds doors | Passing (regression tests) |
| BUG-2 | No duplicate hardware items after dedup | Passing |
| BUG-3 | Quantity capping per category | Passing |
| BUG-4 | Mojibake cleaning | Passing |
| BUG-5 | Door number validation rejects HW set codes | Passing |
| BUG-7 | Quantity normalization (float division, pair doors) | Passing (39 tests) |
| BUG-8 | Page classification for 306169 format | Passing (4 tests) |
| BUG-9 | Float division fix (modulo-based) | Passing |
| BUG-10 | AKN non-standard format | Excluded — not fixed |
| BUG-11 | Test infrastructure expansion | Passing (cross-PDF + classify regression) |
| BUG-12 | MCA field concatenation | **4 xfail — needs fix** |
| BUG-24 | BHMA finish code rejection | Passing |
