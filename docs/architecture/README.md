# Architecture Documentation

This directory contains architecture documentation for the Door Hardware Tracker — a Next.js + Supabase application that extracts hardware schedules from PDF submittals and manages door-by-door hardware data for construction projects.

## System Overview

The application has three major subsystems:

1. **PDF Extraction Pipeline** — Converts PDF hardware schedules into structured data using pdfplumber (Python) and LLM-assisted extraction (Anthropic Claude). Multiple entry points handle different extraction contexts (interactive wizard, background batch jobs, vision-based extraction, region rescans).

2. **Data Model & Staging Layer** — A two-tier persistence model (staging + production) in Supabase/Postgres. Extracted data lands in staging tables for review, then promotes to production via SQL RPCs. Pair-door hardware is attributed to active/inactive leaves.

3. **Hardware Classification & Normalization** — A taxonomy-driven system that classifies hardware items, determines per-opening quantities from aggregate PDF totals, and handles special cases like electric hinge displacement on pair doors.

## Architecture Documents

| Document | Description |
|----------|-------------|
| [Extraction Pipeline](./extraction-pipeline.md) | All PDF processing paths, where normalization and per-opening logic runs, and known coverage gaps |
| [Hinge Logic](./hinge-logic.md) | The hinge quantity pipeline — electric-displaces-standard rule, per-leaf splitting, and the 4 classification systems |
| [Data Model](./data-model.md) | Supabase ER diagrams — production tables, staging layer, extraction jobs, and key SQL RPCs |
| [Taxonomy](./taxonomy.md) | Hardware classification system — categories, install scopes, regex classifiers, and Python/TS divergences |

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/hardware-taxonomy.ts` | Single source of truth for hardware categories and install scopes |
| `src/lib/parse-pdf-helpers.ts` | Core extraction logic: `normalizeQuantities()`, `buildPerOpeningItems()`, `computeLeafSide()` |
| `src/lib/classify-leaf-items.ts` | Render-time leaf grouping: `groupItemsByLeaf()` |
| `api/extract-tables.py` | Python pdfplumber extraction and quantity annotation |
| `src/app/api/parse-pdf/save/route.ts` | Database writer — staging + auto-promote |
| `src/app/api/jobs/[id]/run/route.ts` | Background batch job orchestrator |
| `supabase/migrations/013_hardware_leaf_side.sql` | `leaf_side` column + `promote_extraction()` RPC |
| `supabase/migrations/021_merge_extraction_and_staging_tx.sql` | `merge_extraction()` + `write_staging_data()` RPCs |

## Conventions

- Mermaid diagrams use GitHub-native rendering (` ```mermaid ` code blocks)
- File references use `file_path:line_number` format for easy navigation
- Diagrams are split into multiple smaller diagrams rather than one monolithic flowchart
- Color coding: green = fully covered path, orange = acceptable by design, red = known gap
