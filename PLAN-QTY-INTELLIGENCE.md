# Plan: Punchy Quantity Intelligence — Ask, Learn, Propagate

## Vision

Punchy should never silently fail or silently guess on quantities. When uncertain:
1. **Ask** a specific question about a specific set or opening
2. **Learn** from the user's answer — store it as a project-level decision
3. **Propagate** the answer across all similar openings in the project
4. **Escalate** if one answer creates new ambiguities (cascade questions)

The golden sample (already built) becomes the FIRST calibration point. Quantity questions
are follow-ups when the sample doesn't resolve everything.

## Architecture Overview

```
Extraction (pdfplumber)
    ↓
Golden Sample Verification (user confirms 1 set)
    ↓
Punchy Quantity Review (Checkpoint 3, now with corrections + questions)
    ↓
Quantity Questions in Punch Drawer (user answers specific Qs)
    ↓
Propagation Engine (apply answers across all similar openings)
    ↓
extraction_decisions table (persist for future re-imports / revisions)
    ↓
Continue to Triage
```

## Change 1: New `extraction_decisions` Database Table

Purpose: Store project-level decisions about how to interpret quantities, formats,
and special cases. Survives across wizard sessions and re-imports.

```sql
CREATE TABLE extraction_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  
  -- What this decision is about
  decision_type text NOT NULL,  -- 'qty_per_opening' | 'qty_interpretation' | 'item_scope' | 'format_rule'
  
  -- Context: which item/set/pattern this applies to
  item_category text,          -- 'hinge' | 'closer' | 'lockset' | etc. (from taxonomy)
  set_id text,                 -- specific set, or NULL for project-wide
  pattern text,                -- regex or glob pattern for matching (e.g., "5BB1*")
  
  -- The decision itself
  question_text text NOT NULL, -- what Punchy asked
  answer text NOT NULL,        -- user's response
  resolved_value jsonb,        -- structured result: {"qty": 3, "scope": "per_leaf", "reason": "standard height"}
  
  -- How many items this was applied to
  applied_count int DEFAULT 0,
  
  -- Audit
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  
  -- RLS
  CONSTRAINT fk_project FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- RLS policy: same as other project tables
ALTER TABLE extraction_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Project members can manage decisions"
  ON extraction_decisions FOR ALL
  USING (project_id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid()));
```

This table stores decisions like:
- "For this project, hinges = 3 per leaf (user confirmed from sample)"
- "Set DH5 has 4 hinges per leaf because it's a tall door (user answered question)"
- "This submittal shows total quantities, not per-opening (user confirmed)"

## Change 2: Punchy Quantity Check → Corrector + Question Generator

Currently `getQuantityCheckPrompt()` tells Punchy to only FLAG, never correct.
Change it to return THREE output types:

```json
{
  "auto_corrections": [
    {
      "set_id": "DH1", "item_name": "Hinges",
      "from_qty": 6, "to_qty": 3,
      "reason": "6 hinges ÷ 2 leaves = 3 per leaf (standard)",
      "confidence": "high"
    }
  ],
  "questions": [
    {
      "id": "qty-DH5-hinge",
      "set_id": "DH5", "item_name": "Hinges",
      "text": "Set DH5 shows 8 hinges for 1 pair door. Is that 4 per leaf (tall/heavy door) or should it be 3?",
      "options": ["4 per leaf (tall/heavy)", "3 per leaf (standard)", "Other"],
      "current_qty": 8,
      "context": "Pair door, 2 leaves. Standard would be 6 total (3 per leaf)."
    }
  ],
  "compliance_issues": [...],
  "notes": "..."
}
```

**Key change to the prompt:** Remove "respect the consultant's specs" guardrail. Replace with:
- "HIGH confidence: auto-correct and explain why"
- "MEDIUM confidence: ask a specific question with options"
- "LOW confidence: flag for review, don't guess"

**Golden sample integration:** Include the verified sample in the quantity check prompt:
"The user verified set DH1: 3 hinges per leaf, 1 closer, 1 lockset. Use this as the baseline
for this submittal's quantity conventions."

### Files to modify:
- `src/lib/punchy-prompts.ts` — `getQuantityCheckPrompt()`: new output format + golden sample input
- `src/lib/parse-pdf-helpers.ts` — `callPunchyQuantityCheck()`: accept goldenSample param
- `src/lib/types/index.ts` — `PunchyQuantityCheck` type: add `auto_corrections[]` and `questions[]` fields

## Change 3: Quantity Questions in the Wizard Flow

Add a new sub-phase in StepTriage between "results" and "questions":

```
extracting → results (health dashboard + sample verify) → qty_review → questions → triaging → done
```

The `qty_review` phase:
1. Runs Punchy Checkpoint 3 with the golden sample as context
2. Shows auto-corrections that were applied (green badges)
3. Shows quantity questions in the Punch drawer (same QuestionCard UI)
4. User answers questions → answers propagate → re-check if needed

### New question generation:
Extend `generateTriageQuestions()` (or add a new `generateQuantityQuestions()`) that:
1. Takes Punchy's `questions[]` output
2. Converts them to `PunchQuestion` objects for the existing drawer
3. Adds a new question type that includes set_id + item_name metadata

### Answer propagation:
When user answers "Set DH5 hinges = 4 per leaf (tall door)":
1. Find all other sets that have the same anomaly (qty doesn't divide to 3)
2. Ask: "Should we apply 4-per-leaf to these N other sets too?" (cascade question)
3. If yes, update all matching sets in state
4. Store decision in `extraction_decisions` table via new API endpoint

### Files to modify:
- `src/components/ImportWizard/StepTriage.tsx` — new `qty_review` phase
- `src/lib/punch-messages.ts` — extend PunchQuestion type, add quantity question generation
- `src/components/ImportWizard/ImportWizard.tsx` — wire qty questions into existing question state

## Change 4: Propagation Engine

New utility function: `propagateQuantityDecision()`

```typescript
function propagateQuantityDecision(
  decision: { item_category: string; resolved_qty: number; scope: string },
  hardwareSets: HardwareSet[],
  doors: DoorEntry[],
): { updatedSets: HardwareSet[]; appliedCount: number; newQuestions: PunchQuestion[] }
```

Logic:
1. Find all items matching `item_category` across all sets
2. For each match, check if the decision resolves the ambiguity
3. If it does (e.g., same qty pattern), apply it
4. If it creates a NEW ambiguity (e.g., different door count), generate a follow-up question
5. Return updated sets + count of changes + any new questions

Example cascade:
- User confirms "3 hinges per leaf" for set DH1 (2 doors, 6 total → 3 each)
- Propagation finds set DH3 has 9 hinges for 3 doors → 3 per leaf ✓ (auto-applied)
- Propagation finds set DH5 has 8 hinges for 1 pair → 4 per leaf ≠ 3 → NEW QUESTION

### Files to create:
- `src/lib/quantity-propagation.ts` — propagation engine
- `src/app/api/projects/[projectId]/decisions/route.ts` — CRUD for extraction_decisions

## Change 5: Category-Aware TS Normalization

Currently `normalizeQuantities()` in parse-pdf-helpers.ts divides blindly by leaf/door count.
Import the hardware taxonomy to make it category-aware:

```typescript
import { HARDWARE_TAXONOMY } from '@/lib/hardware-taxonomy'

// For each item, determine the correct divisor based on install_scope:
// per_leaf → divide by leaf count
// per_opening → divide by opening count  
// per_pair → don't divide (always 1 per pair)
// per_frame → don't divide
```

### Files to modify:
- `src/lib/parse-pdf-helpers.ts` — `normalizeQuantities()`: add category detection + scope-aware division

## Change 6: Persist and Retrieve Decisions

New API endpoint: `POST /api/projects/[projectId]/decisions`

On first import:
- Store all golden sample values as decisions
- Store all user-answered quantity questions as decisions
- Store all auto-corrections (with "auto" flag) as decisions

On re-import (revision):
- Load existing decisions from table
- Pre-populate Punchy's context: "Previous import decisions for this project: ..."
- Auto-apply matching decisions without re-asking
- Only ask NEW questions (for new sets/items not seen before)

### Files to create:
- `src/app/api/projects/[projectId]/decisions/route.ts` — GET/POST for decisions

## Implementation Order

Phase 1 (this session or next):
1. Change 5: Category-aware TS normalization (quick win, fixes blind division)
2. Change 2: Modify Punchy prompt to return corrections + questions

Phase 2:
3. Change 3: Quantity review sub-phase in wizard + wire questions
4. Change 4: Propagation engine

Phase 3:
5. Change 1: Database table + RLS
6. Change 6: Persist and retrieve decisions

## Files Summary

| File | Action | What Changes |
|------|--------|-------------|
| `src/lib/parse-pdf-helpers.ts` | Modify | Category-aware normalizeQuantities() + goldenSample in qty check |
| `src/lib/punchy-prompts.ts` | Modify | Quantity check prompt: corrections + questions output |
| `src/lib/types/index.ts` | Modify | PunchyQuantityCheck type: add auto_corrections + questions |
| `src/lib/punch-messages.ts` | Modify | Extend PunchQuestion + add quantity question generation |
| `src/lib/quantity-propagation.ts` | **Create** | Propagation engine |
| `src/components/ImportWizard/StepTriage.tsx` | Modify | qty_review phase + golden sample to qty check |
| `src/components/ImportWizard/ImportWizard.tsx` | Modify | Wire qty questions into question state |
| `src/app/api/projects/[projectId]/decisions/route.ts` | **Create** | CRUD for extraction decisions |
| Supabase migration | **Create** | extraction_decisions table + RLS |

## Why This Works

The key insight: **Every submittal is a new puzzle, but most pieces are standard.**

- 90% of quantities follow domain rules (3 hinges, 1 closer, 1 lockset)
- 10% are project-specific (tall doors, heavy doors, special hardware)
- The golden sample resolves the 90% case in one click
- Quantity questions handle the 10% with specific, targeted asks
- Propagation means 1 answer can fix 40 openings
- Persistence means re-imports don't re-ask the same questions
- The LLM gets smarter per-project, not per-session
