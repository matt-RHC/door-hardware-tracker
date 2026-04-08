# Codebase Conflicts Review — 2026-04-08

## Context
Full audit of the PDF extraction pipeline, database types, and dependencies for internal conflicts. All findings below are verified against current `origin/main` code. This is a **report with recommendations** — no code changes proposed in this session per CLAUDE.md Rule 2 (one bug fix at a time).

---

## Category 1: PDF Pipeline Logic Conflicts

### 1A. `qty_source = 'llm_override'` Bypasses Normalization Guard (P0)
- **Where:** `src/lib/parse-pdf-helpers.ts:257` sets `'llm_override'`, line 335 skip list omits it
- **Bug:** When Punchy overrides a quantity, it marks `qty_source = 'llm_override'`. Then `normalizeQuantities()` runs and re-divides it because the skip list only checks `'divided' | 'flagged' | 'capped'`. Punchy's correction gets silently reverted.
- **Fix:** Add `|| item.qty_source === 'llm_override'` to line 335.
- **Effort:** 1 line. **Risk if unfixed:** Every Punchy quantity correction is wasted.

### 1B. `flaggedDoors` Always `[]` in Non-Chunked Flow (P1)
- **Where:** `src/app/api/parse-pdf/route.ts:167` hardcodes `flaggedDoors: []`
- **Comparison:** `chunk/route.ts:145` correctly reads `pdfplumberResult?.flagged_doors`
- **Bug:** PDFs ≤45 pages use non-chunked flow; outlier door numbers are never surfaced.
- **Fix:** Have `extractFromPDF()` return `flaggedDoors` from the pdfplumber response. ~10 lines.

### 1C. Three Divergent Quantity Normalization Paths (P1)
Three places compute per-opening quantities with **different fallback chains**:

| Location | `doorCount` fallback when `heading_door_count ≤ 1` |
|---|---|
| `parse-pdf-helpers.ts:331` | `doorsPerSet.get(generic_set_id ?? set_id)` |
| `save/route.ts:65` | `doorsPerSet.get(generic_set_id ?? set_id ?? setId)` (3rd fallback) |
| `apply-revision/route.ts:65` | **Hardcoded `0`** — no doorsPerSet fallback at all |

- **Bug:** `apply-revision` will never re-normalize quantities. `save` has an extra `setId` fallback the others lack. Same PDF can produce different quantities depending on which path processes it.
- **Fix:** Extract a single shared normalization function. Medium refactor.

### 1D. Quantity Check Error Looks Like "No Issues" (P1)
- **Where:** `parse-pdf-helpers.ts:222-225` catch block returns `{ flags: [], compliance_issues: [] }`
- **Bug:** Success (no issues) and failure (API error) return the same shape. Frontend at `route.ts:110-116` checks array length — empty = silent skip. The `notes` field has the error message but nothing reads it as an error signal.
- **Fix:** Add `error_occurred: boolean` to the `PunchyQuantityCheck` type and return type.

### 1E. `knownSetIds` Not Passed in Non-Chunked Flow (P2)
- **Where:** `route.ts:74` calls `callPunchyPostExtraction()` without `knownSetIds`; `chunk/route.ts:189` passes it
- **Note:** The function at `parse-pdf-helpers.ts:114` does include it in the prompt as `known_set_ids`. So the wiring works in chunked flow but not non-chunked.
- **Fix:** Pass `knownSetIds` in the non-chunked call. ~3 lines.

### 1F. Column Mapping Review Skipped for Small PDFs (P2)
- **Where:** `callPunchyColumnReview()` exists only in `chunk/route.ts:32-81`, called at line 156
- **Bug:** Non-chunked route (PDFs ≤45 pages) skips column mapping validation entirely.
- **Fix:** Add review call to non-chunked `extractFromPDF()`. ~20 lines.

### 1G. `by_others` Triage Classification Never Persisted (P2)
- **Where:** `triage/route.ts:23` classifies doors as `'door' | 'by_others' | 'reject'`; Python `extract-tables.py:66` also produces `by_others: bool`
- **Bug:** Neither `save/route.ts` nor `apply-revision/route.ts` read or store this field. Classification is displayed during triage UI but lost on import.
- **Decision needed:** Store it in `openings` table, or remove from triage to save LLM tokens?

### 1H. Triage Failure Silently Auto-Accepts All Candidates (P3)
- **Where:** `triage/route.ts:163-172` catch block maps all candidates to `class: 'door'`
- **Behavior:** On Claude API failure, every candidate becomes a door with `confidence: 'low'`. Frontend receives `triage_error: true` but no prominent UI warning.
- **Recommendation:** Surface a warning banner when `triage_error` is true. Design decision.

---

## Category 2: Database ↔ TypeScript Type Mismatches

`src/lib/types/database.ts` is significantly out of sync with `supabase/migrations/`. No later migrations (003-007) ALTER these tables, so the schema in migration 002 is still the source of truth.

### 2A. `issues` Table (7 mismatches)
| Schema (002:74-92) | TypeScript (database.ts:271-313) | Status |
|---|---|---|
| `hardware_item_name` | `hardware_item` | **Wrong name** |
| `reported_by` | — (missing) | **Missing** |
| — | `created_by` | **Doesn't exist in DB** |
| `opening_id` | — | **Missing** |
| `hardware_item_id` | — | **Missing** |
| `date_reported` | — | **Missing** |
| `date_resolved` | — | **Missing** |
| `notes` | — | **Missing** |

### 2B. `smartsheet_row_map` (5 mismatches)
| Schema (002:37-51) | TypeScript (database.ts:359-387) | Status |
|---|---|---|
| `project_id` (NOT NULL FK) | — | **Missing critical FK** |
| `local_table` | — | **Missing** |
| `last_synced_at` | `last_synced` | **Wrong name** |
| `last_smartsheet_modified` | — | **Missing** |
| `last_local_modified` | — | **Missing** |

### 2C. `smartsheet_webhooks` (3 mismatches)
| Schema (002:59-69) | TypeScript (database.ts:388-416) | Status |
|---|---|---|
| `callback_url` | — | **Missing** |
| `shared_secret` | — | **Missing (security field!)** |
| `status` (TEXT enum) | `active` (boolean) | **Wrong name + wrong type** |

### 2D. `smartsheet_portfolio` (4 mismatches)
| Schema (002:122-127) | TypeScript (database.ts:417-436) | Status |
|---|---|---|
| `smartsheet_sheet_id` | — | **Missing** |
| `smartsheet_webhook_id` | — | **Missing** |
| — | `project_id` | **Doesn't exist in DB** |
| — | `smartsheet_row_id` | **Doesn't exist in DB** |

### 2E. `reference_codes` Table — Entirely Missing from Types
- Schema defined in migration 006 with 8 columns. Zero presence in `database.ts`.

### Recommended Fix
Run `supabase gen types typescript` against the live database to regenerate `database.ts`. Then diff and verify. Manual edits risk more drift.

---

## Category 3: Dependencies & Configuration (Low Priority)

| Issue | Detail | Fix |
|---|---|---|
| Missing `pypdf` in `requirements.txt` | Implicit dep of pdfplumber; pip resolves it but explicit is safer | Add to requirements.txt |
| Missing `pytest` in `requirements.txt` | Only installed in CI; local `npm run test:py` fails | Add as dev dep or document |
| Smartsheet IDs hardcoded | `WORKSPACE_ID = 5453896878450564` in `sync-engine.ts` | Move to env vars |
| `SMARTSHEET_API_KEY` missing from `.env.example` | Integration requires it but undocumented | Add to .env.example |
| `@anthropic-ai/sdk ^0.82.0` caret range | Pre-1.0 package; minor bumps can break | Consider pinning |
| Model split (Sonnet vs Haiku) | Triage uses Sonnet, Punchy uses Haiku | Intentional per CLAUDE.md — not a bug |

---

## Priority Summary

| Priority | Issues | Theme |
|---|---|---|
| **P0** | 1A | Punchy corrections silently reverted by normalization |
| **P1** | 1B, 1C, 1D, 2A-2E | Missing data in non-chunked flow; divergent normalization; type drift |
| **P2** | 1E, 1F, 1G | Feature gaps between chunked/non-chunked flows |
| **P3** | 1H, 3A-3F | UI polish, DX, config hygiene |

---

## Next Steps

This is a report only — no code changes in this session. Per CLAUDE.md Rule 2, each fix should be its own PR:

1. **PR 1 (P0):** Fix `llm_override` skip list — 1-line change, immediate pipeline correctness win
2. **PR 2 (P1):** Regenerate `database.ts` from live schema — fixes all Category 2 issues
3. **PR 3 (P1):** Unify quantity normalization into shared function — fixes 1C
4. **PR 4 (P1):** Wire `flaggedDoors` in non-chunked flow — fixes 1B
5. **PR 5 (P1):** Add `error_occurred` to quantity check — fixes 1D
6. **Subsequent PRs:** P2/P3 items as capacity allows

Each PR should be tested against the 3 golden PDFs (small/medium/large) before merge.
