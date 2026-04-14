# Data Model

This document describes the Supabase/Postgres schema, showing table relationships, key columns, and which pipeline stages populate them.

## ER Diagram: Production Tables

These are the core tables that store reviewed, promoted data.

```mermaid
erDiagram
    projects {
        uuid id PK
        text name "NOT NULL"
        text job_number
        text general_contractor
        text architect
        text address
        date submittal_date
        uuid created_by FK
        timestamptz created_at
    }
    
    openings {
        uuid id PK
        uuid project_id FK "NOT NULL"
        text door_number "NOT NULL, UNIQUE(project_id, door_number)"
        text hw_set "Hardware set reference"
        text hw_heading "Set heading from PDF"
        text location
        text door_type
        text frame_type
        text fire_rating
        text hand "Door hand (L/R)"
        text notes
        integer pdf_page "0-based page index"
        integer leaf_count "1=single, 2=pair (default 1)"
        boolean is_active "Soft-delete flag (default true)"
        timestamptz created_at
    }
    
    hardware_items {
        uuid id PK
        uuid opening_id FK "NOT NULL, CASCADE"
        text name "NOT NULL"
        integer qty "Default 1"
        text manufacturer
        text model
        text finish
        text options
        integer sort_order "Default 0"
        text leaf_side "NULL or: active, inactive, shared, both"
        timestamptz created_at
    }
    
    checklist_progress {
        uuid id PK
        uuid opening_id FK "NOT NULL, CASCADE"
        uuid item_id FK "NOT NULL, CASCADE"
        integer leaf_index "1=Leaf1, 2=Leaf2 (default 1)"
        boolean checked "Default false"
        uuid checked_by FK
        timestamptz checked_at
        text notes
        timestamptz created_at
    }
    
    attachments {
        uuid id PK
        uuid opening_id FK "NOT NULL, CASCADE"
        text file_url "NOT NULL"
        text file_name
        text file_type
        uuid uploaded_by FK
        timestamptz uploaded_at
    }
    
    project_members {
        uuid id PK
        uuid project_id FK "NOT NULL, CASCADE"
        uuid user_id FK "CASCADE"
        text role "admin or member"
        text invited_email
        timestamptz joined_at
    }

    projects ||--o{ openings : "has doors"
    projects ||--o{ project_members : "has members"
    openings ||--o{ hardware_items : "has items"
    openings ||--o{ checklist_progress : "tracks progress"
    openings ||--o{ attachments : "has files"
    hardware_items ||--o{ checklist_progress : "per-item checks"
```

### Column Notes

**`openings.pdf_page`** — The 0-based page index where the hardware set heading was found during extraction. Populated by `findPageForSet()` in `src/lib/punch-cards.ts`. Used by the region rescan feature to show the correct PDF page.

**`openings.leaf_count`** — 1 for single doors, 2 for pair doors. Detected by `detectIsPair()` using three signals: heading-derived leaf count, opening size >= 48", and keyword scan. Populated at save time by `buildPerOpeningItems()`.

**`openings.is_active`** — Soft-delete flag introduced in migration 021. `merge_extraction()` sets `is_active=false` for doors that are no longer in the latest extraction (instead of hard-deleting them).

**`hardware_items.leaf_side`** — Per-item leaf attribution. Populated by `buildPerOpeningItems()` at save time via `computeLeafSide()`. Used by `groupItemsByLeaf()` at render time. See [Hinge Logic](./hinge-logic.md) for details on how electric hinges affect this value.

| leaf_side | Meaning | Example Items |
|-----------|---------|---------------|
| `'active'` | Active leaf only | Lockset, exit device, electric hinge |
| `'inactive'` | Inactive leaf only | Flush bolt |
| `'shared'` | Per-opening (not per-leaf) | Coordinator, threshold, astragal |
| `'both'` | Both leaves, separate rows | Standard hinges, closer |
| `NULL` | Unset — render-time fallback | Legacy data, batch job imports |

**`hardware_items.install_type`** — User-set field (not extracted from PDF). Not part of the normalization pipeline.

---

## ER Diagram: Staging & Extraction Tables

These tables hold pre-review extraction data and background job state.

```mermaid
erDiagram
    extraction_runs {
        uuid id PK
        uuid project_id FK "NOT NULL"
        uuid job_id FK "nullable — links to extraction_jobs"
        text status "pending|extracting|reviewing|promoted|rejected|failed"
        text pdf_storage_path
        text pdf_hash "SHA-256"
        integer pdf_page_count
        text pdf_source_type "comsense|s4h|word_excel|allegion|..."
        text extraction_method "pdfplumber|pymupdf|claude_vision|hybrid"
        text confidence "high|medium|low"
        numeric confidence_score "0.000-1.000"
        integer doors_extracted
        integer doors_flagged
        integer hw_sets_extracted
        timestamptz started_at
        timestamptz completed_at
        integer duration_ms
        text error_message
        text[] extraction_notes
        uuid created_by FK
        timestamptz promoted_at
        uuid promoted_by FK
    }
    
    staging_openings {
        uuid id PK
        uuid extraction_run_id FK "NOT NULL, CASCADE"
        uuid project_id FK "NOT NULL"
        text door_number "NOT NULL"
        text hw_set
        text hw_heading
        text location
        text door_type
        text frame_type
        text fire_rating
        text hand
        text notes
        integer pdf_page
        integer leaf_count "Default 1"
        boolean is_flagged "Default false"
        text flag_reason
        jsonb field_confidence "Per-field scores"
        timestamptz created_at
    }
    
    staging_hardware_items {
        uuid id PK
        uuid staging_opening_id FK "NOT NULL, CASCADE"
        uuid extraction_run_id FK "NOT NULL, CASCADE"
        text name "NOT NULL"
        integer qty "Default 1"
        integer qty_total "Raw PDF value"
        integer qty_door_count "Divisor used"
        text qty_source "parsed|divided|flagged|capped"
        text manufacturer
        text model
        text finish
        text options
        integer sort_order
        text leaf_side "NULL or: active, inactive, shared, both"
        timestamptz created_at
    }
    
    extraction_jobs {
        uuid id PK
        uuid project_id FK "NOT NULL, CASCADE"
        uuid created_by FK "NOT NULL"
        text status "queued|classifying|detecting_columns|extracting|..."
        smallint progress "0-100"
        text status_message
        text pdf_storage_path "NOT NULL"
        text pdf_hash
        integer pdf_page_count
        uuid extraction_run_id FK "nullable"
        jsonb classify_result
        jsonb detect_result
        jsonb extraction_summary
        jsonb constraint_flags "Array of violations"
        timestamptz started_at
        timestamptz completed_at
        integer duration_ms
        text error_message
        text error_phase
        smallint retry_count "Default 0"
    }
    
    job_user_constraints {
        uuid id PK
        uuid job_id FK "NOT NULL, CASCADE"
        text question_key "NOT NULL, UNIQUE(job_id, question_key)"
        jsonb answer_value "NOT NULL"
        timestamptz answered_at
    }
    
    extraction_corrections {
        uuid id PK
        uuid extraction_run_id FK "NOT NULL, CASCADE"
        uuid project_id FK "NOT NULL"
        text door_number
        text field_name "NOT NULL"
        text original_value
        text corrected_value
        text correction_type "wrong_value|missing_value|extra_value|..."
        uuid corrected_by FK
        timestamptz corrected_at
    }

    projects ||--o{ extraction_runs : "has runs"
    projects ||--o{ extraction_jobs : "has jobs"
    extraction_runs ||--o{ staging_openings : "staged doors"
    extraction_runs ||--o{ staging_hardware_items : "staged items"
    extraction_runs ||--o{ extraction_corrections : "user corrections"
    extraction_jobs ||--o{ job_user_constraints : "user answers"
    extraction_jobs |o--o| extraction_runs : "produces run"
    staging_openings ||--o{ staging_hardware_items : "has items"
```

### Staging-to-Production Flow

```mermaid
flowchart LR
    subgraph Staging["Staging Layer"]
        SO["staging_openings"]
        SH["staging_hardware_items"]
    end
    
    subgraph Promotion["SQL RPCs"]
        ME["merge_extraction()<br/>migration 021"]
        PE["promote_extraction()<br/>migration 013 (legacy)"]
    end
    
    subgraph Production["Production Layer"]
        O["openings"]
        H["hardware_items"]
    end
    
    SO --> ME
    SH --> ME
    ME --> O
    ME --> H
    
    SO --> PE
    SH --> PE
    PE --> O
    PE --> H

    style ME fill:#2d6a2d,color:#fff
    style PE fill:#cc6600,color:#fff
```

**`merge_extraction()`** (migration 021) — The recommended promotion path. Intelligently matches staging doors to existing production doors by `door_number`:
- **Unchanged doors:** Preserves checklist_progress and attachments
- **Changed hardware:** Replaces hardware_items (cascades checklist)
- **New doors:** Inserts as new openings
- **Removed doors:** Soft-deletes (`is_active = false`)

**`promote_extraction()`** (migration 013) — Legacy promotion. Hard-deletes ALL existing production openings for the project and replaces with staging data. Preserves `leaf_side` through promotion.

---

## Which Pipeline Stage Populates Which Columns

### hardware_items columns

| Column | Populated by | Notes |
|--------|-------------|-------|
| `name` | Python extract-tables.py or Claude vision | Raw item name from PDF |
| `qty` | `normalizeQuantities()` (TS) | Divided quantity per opening/leaf |
| `manufacturer` | Python or Claude | Extracted from PDF |
| `model` | Python or Claude | Extracted from PDF |
| `finish` | Python or Claude | Extracted from PDF |
| `options` | Python or Claude | Extracted from PDF |
| `sort_order` | Extraction order | Preserved from PDF table order |
| `leaf_side` | `buildPerOpeningItems()` via `computeLeafSide()` | **Only in wizard/revision paths — NULL in batch job path** |
| `install_type` | User (manual) | Not extracted from PDF |

### staging_hardware_items extra columns

| Column | Populated by | Notes |
|--------|-------------|-------|
| `qty_total` | Python `normalize_quantities()` | Raw PDF value before division |
| `qty_door_count` | Python `normalize_quantities()` | The divisor (leaf_count or door_count) |
| `qty_source` | Python → TS pipeline | Tracks how qty was calculated |

### openings columns

| Column | Populated by | Notes |
|--------|-------------|-------|
| `door_number` | Python heading parser | Extracted from set headings |
| `hw_set` | Python heading parser | Hardware set reference (e.g., "DH1") |
| `hw_heading` | Python heading parser | Full heading text |
| `pdf_page` | `findPageForSet()` in `punch-cards.ts` | Page where set heading was found |
| `leaf_count` | `detectIsPair()` at save time | 1 or 2 |
| `door_type`, `frame_type` | Python or user | From PDF or manual entry |
| `is_active` | `merge_extraction()` | Soft-delete flag |

---

## Key SQL RPCs

### `write_staging_data(p_extraction_run_id, p_project_id, p_payload)`

Transactional bulk write of extraction results to staging tables. Used by both the wizard save path and the batch job path.

**Input:** JSONB array of openings with nested items
**Defined in:** `supabase/migrations/021_merge_extraction_and_staging_tx.sql` (also `023_create_write_staging_data_rpc.sql`)

### `merge_extraction(p_extraction_run_id, p_user_id)`

Intelligent promotion: staging to production with history preservation.

**Preconditions:** extraction_run status = 'reviewing' or 'completed_with_issues', user must be project admin
**Returns:** `{success, added, updated, unchanged, deactivated, items_promoted}`
**Defined in:** `supabase/migrations/021_merge_extraction_and_staging_tx.sql`

### `promote_extraction(p_extraction_run_id, p_user_id)`

Legacy atomic promotion (hard-delete and replace).

**Returns:** `{success, openings_promoted, items_promoted}`
**Defined in:** `supabase/migrations/013_hardware_leaf_side.sql`

### `cleanup_old_staging(p_retention_days DEFAULT 30)`

Retention policy cleanup. Removes staging data older than N days for promoted/rejected/failed runs.

**Defined in:** `supabase/migrations/007_extraction_staging.sql`
