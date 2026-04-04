@AGENTS.md

# Door Hardware Tracker

A Next.js SaaS application that parses door hardware submittal PDFs and turns them into a trackable, QR-code-enabled checklist for construction teams.

**Live:** trackdoorhardware.app
**Repo:** github.com/matt-RHC/door-hardware-tracker

## Tech Stack

- **Framework:** Next.js 16.2 (App Router) + TypeScript, deployed on Vercel Pro
- **Build:** Turbopack (dev + production) — stricter than standard tsc, see rules below
- **Database:** Supabase (Postgres + Auth + RLS + Realtime)
- **AI:** Anthropic API (claude-sonnet-4-20250514) for PDF parsing + review
- **PDF extraction:** Python pdfplumber serverless function (`/api/extract-tables.py`)
- **Hosting:** Vercel Pro plan, Fluid Compute enabled, 300s maxDuration on PDF/sync routes

## Critical Rules

### 1. No Plans Without Merged Code
**HARD RULE.** Do not write new plans, research docs, or architecture documents until the code from the last plan is merged to `main` and tested. If a session only produces documents and no code changes, that is a problem. One bug fix at a time: fix → test → merge → next.

### 2. Milestones Over Speed
Complete and test one feature end-to-end before starting the next. No placeholder/TODO code in production. Correctness over speed, always.

### 3. Accuracy Over Automation
Auto-detect where possible, but if uncertain, **ask the user** rather than guessing. Being interactive is fine. A few extra clicks is acceptable if it prevents bad data. We are NOT pushing AI slop.

## Turbopack TypeScript Rules

Turbopack's type checker in Next.js 16.2 is significantly stricter than `tsc --noEmit`. These patterns caused 6 consecutive failed Vercel deploys before we learned them:

1. **Truthy `&&` guards do NOT narrow nullable types.** `if (x && x.prop)` still fails → use `x?.prop`
2. **`?.` on left of `&&` does NOT carry narrowing to right.** `x?.chunks && x.chunks.length` fails → use `(x?.chunks?.length ?? 0) > 0`
3. **Spread on optional arrays fails inside `if` guards.** `if (x.arr) push(...x.arr)` fails → use `push(...(x.arr ?? []))`
4. **`!== null` guards are NOT sufficient.** Must use `?? undefined` or `!` assertion after compound checks.

**Always use `?.`, `??`, and `?? []` for nullable access. Never rely on `if` guards or `&&` for narrowing.**

## Git Workflow

Git operations run directly in the working directory — no `/tmp/` clone needed.

1. Set git identity before first commit: `git config user.email "m.feagin1@icloud.com" && git config user.name "Matthew Feagin"`
2. Default branch is `main`. There is no `master` branch.
3. Use PRs for all changes — enable **"Automatically delete head branches"** in GitHub repo settings to prevent branch buildup.

## Database Schema (Key Tables)

| Table | Purpose |
|---|---|
| `projects` | Job info, Smartsheet IDs, `last_pdf_hash` for dedup |
| `openings` | Door records: door_number, hw_set, location, fire_rating, hand |
| `hardware_items` | Per-opening items: name, qty, model, finish, manufacturer, sort_order, install_type |
| `checklist_progress` | Multi-step workflow: received → pre_install (bench) / installed (field) → qa_qc |
| `attachments` | Per-opening files: floor plans, door/frame drawings |
| `project_members` | RLS enforcement — all tables require project membership |
| `smartsheet_row_map` | Sync state for Smartsheet integration |

**Key decisions:**
- Per-opening quantities (hinges=3-4, closers=1), NOT project totals
- Door and Frame added as checkable items per opening (pair detection for double doors)
- Project creation uses admin Supabase client to bypass RLS chicken-and-egg problem

## PDF Parsing Architecture

Every door hardware submittal PDF has three layers:

**Layer 1 — Opening List (Master Table):** Clean tabular grid. Columns: Opening | Hdw Set | Hdw Heading | etc. This is the **single source of truth** for all door-to-set assignments. Machine-readable, minimal LLM needed.

**Layer 2 — Hardware Schedule (Set Definitions):** One page per hardware set. Header with set ID and assigned doors. Body with item list (qty, name, model, finish, manufacturer).

**Layer 3 — Reference Tables:** Manufacturer codes, finish codes, option codes. Static lookups.

### 3-Phase Extraction Strategy

1. **Phase 1:** Extract the Opening List via direct table extraction (pdfplumber). Output: complete door roster.
2. **Phase 2:** Extract Hardware Set definitions. Parse one representative set thoroughly, use as template for similar sets. Cross-validate against Phase 1.
3. **Phase 3:** Extract reference tables. Decode abbreviations. Final validation: flag orphaned doors/sets.

### Pipeline Flow
```
classify-pages.py → detect-mapping.py → ColumnMapperWizard (user) → extract-tables.py → chunk/route.ts → LLM review → merge → ImportReviewTable (user review) → save
```

- PDFs ≤ 45 pages: full pipeline, no chunking
- PDFs > 45 pages: client-side splitting into 35-page chunks via pdf-lib
- Resubmissions use the compare wizard for revision tracking
- SHA-256 hash prevents duplicate uploads

## UI / UX Notes

- **Theme:** Borderlands industrial — cel-shaded, glow-cards, corner-brackets, Orbitron font, cyan accent (#5ac8fa)
- **Progress loader:** Status messages must be short and ambient (under ~40 chars). Never dump raw data (set IDs, door numbers) into the visual. Detailed info goes in console or collapsible details.
- **Apply-to-all pattern:** When user edits a hardware item, check if matching items exist across other openings. Offer "Apply to all N" / "Just this one" modal.

## What Works (as of S-031)

- PDF upload → column mapping → extraction → pattern validation → user review → DB insert (end-to-end)
- Revision flow: re-upload PDF → compare → apply changes
- Bench/field classification with apply-to-all
- Edit items with apply-to-all for matching items across openings
- Pattern consensus validation with flagged door review
- Column mapper with cover-page false-positive prevention
- Smartsheet one-way sync (manual + daily cron at 6am UTC)
- Inline editing, tabbed door cards, QR codes, CSV export, auth, advanced filters

## Testing

- **Golden test PDFs** in `test-pdfs/`: small (3pg), medium (44pg), large (82pg)
- Always test extraction changes against all three
- Python endpoint health check: `/api/extract-tables.py` has text-layer detection
- Known limitation: pdfplumber does not work on image-based/scanned PDFs

## Output Transparency (MANDATORY)

Every response, commit message, and session summary **must** end with a clear status block. No ambiguity about what happened.

### Format:
```
DONE:
- [list every change actually made and verified]

PLANNED (not yet done):
- [list anything discussed/designed but NOT yet in code]

NOTICED BUT DID NOT TOUCH:
- [list any issues, bugs, or concerns spotted during this work that were outside scope]
- [if none, say "None"]

SHADOW CHANGES:
- [list ANY change made that was NOT explicitly requested — even minor refactors, lint fixes, import reorders, comment edits]
- [if none, say "None"]
```

### Rules:
- **Never describe planned work in a way that sounds like it was completed.** Use future tense ("will need to") for plans, past tense ("added", "fixed") only for done work.
- **Never silently fix adjacent issues.** If you see a bug near the code you're working on, report it under "Noticed but did not touch" — do NOT fix it without asking first.
- **If you made zero code changes, say so explicitly.** "No files were modified in this session" is a valid and important status.
- **Commit messages must reflect only what the commit contains.** Do not reference planned follow-up work in commit messages.
