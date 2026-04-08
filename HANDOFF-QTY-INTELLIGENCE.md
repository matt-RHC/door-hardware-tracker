# Handoff: Quantity Intelligence Implementation

**Date:** 2026-04-08
**From:** Session that shipped Extraction Health Dashboard + Deep Extract + Sample Calibration
**To:** Next Claude Code session implementing Punchy Quantity Intelligence

---

## What Was Done This Session (3 commits on `claude/fix-pdf-wizard-flow-LSDXr`, merged to main)

### Commit 1: Extraction Health Dashboard + Punch Mobile Fix
- Moved PunchAssistant drawer outside scrollable container (fixed mobile clipping)
- Added Extraction Health Dashboard — new "results" phase in StepTriage between extraction and triage
- Shows: doors/sets/items counts, per-set item breakdown (empty sets in red), coverage metrics, missing sets warnings
- User must acknowledge results before triage runs

### Commit 2: Filtered PDF to Triage + Deep Extract Fallback
- **Triage gets PDF context:** StepTriage builds filtered PDF (door schedule + HW set pages only) via `splitPDFByPages()` and sends `filteredPdfBase64` to triage API — Claude Sonnet now sees actual pages
- **Deep Extract:** New `/api/parse-pdf/deep-extract` endpoint using Claude Haiku with extraction-focused prompt (not review-focused). "Extract Items with AI" button in dashboard for empty sets.
- New files: `src/app/api/parse-pdf/deep-extract/route.ts`, new functions in `src/lib/parse-pdf-helpers.ts` and `src/lib/punchy-prompts.ts`

### Commit 3: Sample Opening Calibration
- Auto-selects the populated set with the most items as calibration sample
- "Verify Sample" card in the Extraction Health Dashboard — shows door info + item list
- User clicks "Looks Good" (1-click happy path) to confirm
- Confirmed golden sample is included as few-shot reference in Deep Extract prompt
- `callDeepExtraction()` accepts optional `goldenSample` parameter

---

## What Needs to Be Built: Quantity Intelligence (Plan at `/root/.claude/plans/qty-intelligence.md`)

The plan file has full details. Here's the essence:

### The Problem
Punchy (the AI review layer) HAS domain knowledge about correct quantities (3 hinges per standard leaf, 1 coordinator per pair, etc.) but is explicitly told NOT to correct — only flag. And those flags are never surfaced to the user. Meanwhile, the TS-side `normalizeQuantities()` divides quantities blindly without knowing item categories (hinges should divide by leaves, closers by openings).

### The Solution: Ask → Learn → Propagate → Remember

**Phase 1 (start here):**
1. **Category-aware TS normalization** — Import hardware taxonomy into `normalizeQuantities()` so hinges divide by leaf count, closers by opening count, coordinators never divide
2. **Punchy prompt upgrade** — Change quantity check from "flag only" to returning: `auto_corrections[]` (high confidence), `questions[]` (medium confidence), `compliance_issues[]`

**Phase 2:**
3. **Quantity review sub-phase** in wizard — new phase between "results" and "questions" where Punchy's corrections are shown and quantity questions appear in the Punch drawer
4. **Propagation engine** — one answer propagates across all matching openings; can generate cascade questions

**Phase 3:**
5. **`extraction_decisions` database table** — persists quantity decisions per project
6. **Decision persistence API** — store/retrieve decisions so re-imports don't re-ask

---

## Key Files You Need to Know

### Quantity Pipeline (Python)
- `api/extract-tables.py` — Lines 3202-3384: `normalize_quantities()` with category-aware `DIVISION_PREFERENCE` map (line 127), `EXPECTED_QTY_RANGES` (line 101), `_classify_hardware_item()` (line 173)
- Python side is GOOD — it knows hinges=per_leaf, closers=per_opening. The problem is the TS side.

### Quantity Pipeline (TypeScript)
- `src/lib/parse-pdf-helpers.ts:480-523` — `normalizeQuantities()` — **THE PROBLEM FILE.** Divides blindly by leaf then door count without knowing item categories. Needs taxonomy import.
- `src/lib/parse-pdf-helpers.ts:216-285` — `callPunchyQuantityCheck()` — sends data to Punchy Checkpoint 3. Needs to accept `goldenSample` param.
- `src/lib/parse-pdf-helpers.ts:294-390` — `callDeepExtraction()` — already accepts goldenSample (we added this).

### Prompts
- `src/lib/punchy-prompts.ts:164-207` — `getQuantityCheckPrompt()` — currently says "DO NOT flag quantities that are correct per the submittal." This needs to change to allow corrections + questions.
- `src/lib/punchy-prompts.ts:209-248` — `getDeepExtractionPrompt()` — extraction-focused, already works well.

### Hardware Taxonomy
- `src/lib/hardware-taxonomy.ts` — Defines `InstallScope` (per_leaf, per_opening, per_pair, per_frame), all hardware categories with `typical_qty_single`/`typical_qty_pair` ranges, and `name_patterns` regexes. **This is the source of truth for category-aware normalization.**

### Question System
- `src/lib/punch-messages.ts` — `PunchQuestion` type + `generateTriageQuestions()`. Extend this for quantity questions.
- `src/components/ImportWizard/PunchAssistant.tsx` — `QuestionCard` component renders questions in drawer. Already handles options + skip + answered states.
- `src/components/ImportWizard/ImportWizard.tsx:106-168` — Question state management, auto-suppress after 3 dismissals, answer flow.

### Types
- `src/lib/types/index.ts:134-153` — `PunchyQuantityCheck` type. Needs `auto_corrections[]` and `questions[]` added.
- `src/lib/types/index.ts:25-44` — `HardwareSet`, `ExtractedHardwareItem` — the data model.

### Wizard Flow
- `src/components/ImportWizard/StepTriage.tsx` — The main file. Current phases: `extracting → results → questions → triaging → done`. Need to add `qty_review` between `results` and `questions`.
- The golden sample state (`goldenSample`) is already here — use it to feed Punchy Checkpoint 3.

---

## Audit Findings (from this session's deep investigation)

### Python quantity normalization is solid:
- `DIVISION_PREFERENCE` map: hinges→leaf, closers→opening, coordinators→opening_only
- `EXPECTED_QTY_RANGES`: hinges (2,5), closer (1,2), lockset (1,1), etc.
- `_classify_hardware_item()`: regex-based category detection
- Heading door count detection: "For 1 Pair Doors" → 2 leaves
- Handles SpecWorks dual-qty format

### TypeScript normalization has NO category awareness:
- `normalizeQuantities()` divides ALL items by leaf count first, then door count
- Doesn't know hinges should prefer leaf division while closers prefer opening division
- This is the #1 fix needed

### Punchy Checkpoint 3 is muzzled:
- Has the knowledge (DFH_DOMAIN_KNOWLEDGE constant has hinge rules, pair rules, fire rating rules)
- But prompt says "DO NOT flag quantities that are correct per the submittal"
- Flags are generated but NEVER surfaced to user and NEVER applied
- StepTriage extracts `doors` and `sets` from the API response but ignores `punchyQuantityCheck`

### No persistence:
- Question answers are ephemeral (cleared when leaving Triage step)
- No database table for decisions
- Re-imports start from scratch

---

## Specific Implementation Guidance for Phase 1

### Change 1: Category-Aware normalizeQuantities()

In `src/lib/parse-pdf-helpers.ts`, the current function at line 480:

```typescript
export function normalizeQuantities(hardwareSets, doors) {
  // Currently: for each item, try divide by leafCount, then doorCount
  // WRONG: doesn't know item categories
}
```

What it needs:
1. Import `HARDWARE_TAXONOMY` from `src/lib/hardware-taxonomy.ts`
2. For each item, determine its category using `name_patterns` regexes
3. Look up `install_scope` for that category
4. Division strategy by scope:
   - `per_leaf` → divide by leafCount first, doorCount fallback
   - `per_opening` → divide by doorCount only
   - `per_pair` → never divide (1 per pair opening)
   - `per_frame` → never divide (1 per frame)
5. The Python layer already does this via `DIVISION_PREFERENCE` — mirror that logic

### Change 2: Punchy Prompt Upgrade

In `src/lib/punchy-prompts.ts`, modify `getQuantityCheckPrompt()`:

1. Remove: "DO NOT flag quantities that are correct per the submittal"
2. Add: Three-tier output format (auto_corrections, questions, compliance_issues)
3. Add: "HIGH confidence: auto-correct. MEDIUM: ask specific question with options. LOW: flag for review."
4. Accept golden sample in the user message: "User verified set X has these quantities..."

In `src/lib/types/index.ts`, extend `PunchyQuantityCheck`:
```typescript
export interface PunchyQuantityCheck {
  auto_corrections?: Array<{
    set_id: string; item_name: string;
    from_qty: number; to_qty: number;
    reason: string; confidence: 'high';
  }>;
  questions?: Array<{
    id: string; set_id: string; item_name: string;
    text: string; options: string[];
    current_qty: number; context: string;
  }>;
  flags?: Array<...>;  // existing
  compliance_issues?: Array<...>;  // existing
  notes?: string;
}
```

---

## Testing Guidance

- The 15 golden PDFs are in `test-pdfs/training/`
- Test fixtures symlinked in `tests/fixtures/`
- Baselines in `tests/baselines/`
- Run Python tests: `python -m pytest tests/test_baselines.py -v`
- Any pipeline change must be tested against ALL 13 golden PDFs per CLAUDE.md
- Log results to Smartsheet Metrics Log (2206493777547140)

---

## What NOT to Do

- Don't rebuild the question UI — PunchQuestion + QuestionCard already work perfectly
- Don't change the Python `normalize_quantities()` — it's already category-aware
- Don't create a new wizard step — add qty_review as a sub-phase inside StepTriage
- Don't auto-correct LOW confidence items — always ask
- Don't skip reading CLAUDE.md and AGENTS.md — they have critical Turbopack rules and session protocols
