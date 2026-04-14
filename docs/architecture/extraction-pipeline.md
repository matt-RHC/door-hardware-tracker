# Extraction Pipeline Architecture

This document maps every PDF processing path in the system, showing where quantity normalization, per-opening item building, and leaf-side attribution run — and where they don't.

## High-Level Overview

All extraction paths ultimately funnel data into two destinations: the **browser** (for wizard preview) or the **database** (via staging + promotion). The critical distinction is which normalization stages run in each path.

```mermaid
flowchart TB
    PDF[PDF Upload] --> Interactive
    PDF --> Background
    
    subgraph Interactive["Interactive Wizard Paths"]
        SmallFile["Small File<br/>parse-pdf/route.ts"]
        LargeFile["Large File (Chunked)<br/>chunk/route.ts"]
        DeepExtract["Deep Extract (Agentic)<br/>deep-extract/route.ts"]
        VisionExtract["Vision Extract<br/>vision-extract/route.ts"]
        RegionRescan["Region Rescan<br/>region-extract/route.ts"]
    end
    
    subgraph Background["Background Job Path"]
        BatchJob["Batch Job<br/>jobs/[id]/run/route.ts"]
    end
    
    Interactive --> Browser["Browser Preview<br/>(wizard state)"]
    Browser --> Save["save/route.ts<br/>buildPerOpeningItems()"]
    Save --> DB[(Supabase DB)]
    
    BatchJob --> |"writeStagingData RPC"| DB
    
    ApplyRevision["Apply Revision<br/>apply-revision/route.ts"] --> DB

    style Save fill:#2d6a2d,color:#fff
    style BatchJob fill:#cc6600,color:#fff
```

## Entry Points Summary

| # | Route | Purpose | Writes to DB? |
|---|-------|---------|:---:|
| 1 | `parse-pdf/route.ts` | Legacy/small file extraction | No |
| 2 | `parse-pdf/chunk/route.ts` | Chunked extraction (large files) | No |
| 3 | `parse-pdf/save/route.ts` | Wizard confirm — staging + promote | Yes |
| 4 | `parse-pdf/apply-revision/route.ts` | Revision re-extraction | Yes |
| 5 | `jobs/[id]/run/route.ts` | Background batch orchestrator | Yes |
| 6 | `parse-pdf/deep-extract/route.ts` | Agentic extraction (Claude vision for empty sets) | No |
| 7 | `parse-pdf/region-extract/route.ts` | User-drawn bbox region rescan | No |
| 8 | `parse-pdf/vision-extract/route.ts` | Full vision extraction (Claude Sonnet) | No |

Routes that don't write to DB return data to the browser wizard, which eventually saves via `save/route.ts`.

---

## Coverage Matrix

This matrix shows which normalization stages run in each extraction path. Green = runs. Red = missing. Gray = not applicable.

| Path | Python `normalize_quantities()` | TS `normalizeQuantities()` | `buildPerOpeningItems()` | `leaf_side` stamped |
|------|:---:|:---:|:---:|:---:|
| Small file (parse-pdf/route.ts) | YES | YES | -- | -- |
| Large file (chunk/route.ts) | YES | YES | -- | -- |
| Save (save/route.ts) | -- | -- | **YES** | **YES** |
| Apply revision (apply-revision/route.ts) | -- | YES | **YES** | **YES** |
| Batch job (jobs/[id]/run/route.ts) | YES | YES | **NO** | **NO** |
| Deep extract (deep-extract/route.ts) | -- | -- | -- | -- |
| Region rescan (region-extract/route.ts) | YES | -- | -- | -- |
| Vision extract (vision-extract/route.ts) | -- | -- | -- | -- |

**Key insight:** Interactive paths (1, 2) extract to the browser, then `save/route.ts` (3) handles `buildPerOpeningItems` + `leaf_side`. The batch job (5) bypasses `save/route.ts` entirely, writing directly via `writeStagingData` RPC.

---

## Path 1: Small File (Interactive Wizard)

The simplest extraction path. The entire PDF is processed in a single request.

```mermaid
flowchart LR
    A["Browser Upload"] --> B["parse-pdf/route.ts"]
    B --> C["callPdfplumber()"]
    C --> D["Python extract-tables.py<br/>normalize_quantities()"]
    D --> E["Punchy CP2<br/>(LLM column review)"]
    E --> F["TS normalizeQuantities()<br/>parse-pdf-helpers.ts:171"]
    F --> G["Punchy CP3<br/>(LLM qty check)"]
    G --> H["Return to Browser"]
    H --> I["User Reviews in Wizard"]
    I --> J["save/route.ts"]
    J --> K["buildPerOpeningItems()<br/>leaf_side stamped"]
    K --> L[(Database)]
    
    style D fill:#2d6a2d,color:#fff
    style F fill:#2d6a2d,color:#fff
    style K fill:#2d6a2d,color:#fff
```

**Coverage: COMPLETE.** Python annotates division hints. TS performs the actual division. `buildPerOpeningItems` creates per-leaf rows and stamps `leaf_side`. Electric hinge displacement logic fully covered.

**File references:**
- `src/app/api/parse-pdf/route.ts` — entry point
- `api/extract-tables.py:3885` — `normalize_quantities()` (Python annotation)
- `src/lib/parse-pdf-helpers.ts:171` — `normalizeQuantities()` call
- `src/app/api/parse-pdf/save/route.ts:164` — `buildPerOpeningItems()` call

---

## Path 2: Large File Chunked (Interactive Wizard)

For large PDFs, the file is split into chunks and each chunk is processed separately. The client merges results.

```mermaid
flowchart LR
    A["Browser Upload"] --> B["Split PDF into Chunks"]
    B --> C1["chunk/route.ts<br/>Chunk 1"]
    B --> C2["chunk/route.ts<br/>Chunk 2"]
    B --> CN["chunk/route.ts<br/>Chunk N"]
    
    C1 --> D1["callPdfplumber → Py normalize_quantities<br/>→ Punchy CP2 → TS normalizeQuantities<br/>→ Punchy CP3"]
    C2 --> D2["Same pipeline per chunk"]
    CN --> DN["Same pipeline per chunk"]
    
    D1 --> E["Client Merges<br/>All Chunks"]
    D2 --> E
    DN --> E
    
    E --> F["User Reviews"]
    F --> G["save/route.ts"]
    G --> H["buildPerOpeningItems()"]
    H --> I[(Database)]

    style D1 fill:#2d6a2d,color:#fff
    style H fill:#2d6a2d,color:#fff
```

**Coverage: COMPLETE.** Each chunk runs the full Python + TS normalization. Merged results flow through `save/route.ts` for `buildPerOpeningItems`.

**File references:**
- `src/app/api/parse-pdf/chunk/route.ts:181` — `normalizeQuantities()` call per chunk

---

## Path 3: Save (Database Writer)

This is NOT an extraction path — it's the database writer that all interactive wizard paths funnel through. It's where `buildPerOpeningItems` runs.

```mermaid
flowchart TB
    A["Wizard 'Confirm' Click"] --> B["save/route.ts"]
    B --> C["Create extraction_run<br/>(status='extracting')"]
    C --> D["buildPerOpeningItems()"]
    
    D --> D1["For each opening:"]
    D1 --> D2["Create Door rows<br/>(Active/Inactive Leaf for pairs)"]
    D1 --> D3["Create Frame row"]
    D1 --> D4["Process hardware items"]
    
    D4 --> E{"Is pair door<br/>with electric hinges?"}
    E -->|Yes| F["Split standard hinges:<br/>Active: qty - electricQty<br/>Inactive: qty"]
    E -->|No| G["computeLeafSide()<br/>via taxonomy"]
    
    F --> H["writeStagingData RPC"]
    G --> H
    H --> I["merge_extraction()<br/>or promote_extraction()"]
    I --> J[(Production Tables)]

    style D fill:#2d6a2d,color:#fff
    style F fill:#2d6a2d,color:#fff
```

**Important:** `normalizeQuantities()` intentionally does NOT run here. Items arrive already-divided from the extraction routes. Running it again would double-divide.

**File references:**
- `src/app/api/parse-pdf/save/route.ts:164` — `buildPerOpeningItems()` call
- `src/lib/parse-pdf-helpers.ts:2633` — `buildPerOpeningItems()` definition
- `src/lib/parse-pdf-helpers.ts:197` — `computeLeafSide()` definition

---

## Path 4: Apply Revision

Re-processes doors when the user changes door-to-hardware-set assignments, adds new doors, or removes doors.

```mermaid
flowchart LR
    A["Revision Wizard"] --> B["apply-revision/route.ts"]
    B --> C["normalizeQuantities()<br/>line 93"]
    C --> D["Process removed doors"]
    C --> E["Process changed doors"]
    C --> F["Process new doors"]
    
    E --> G["buildPerOpeningItems()<br/>line 210"]
    F --> H["buildPerOpeningItems()<br/>line 277"]
    
    G --> I["Direct DB writes"]
    H --> I
    D --> I
    I --> J[(Production Tables)]

    style C fill:#2d6a2d,color:#fff
    style G fill:#2d6a2d,color:#fff
    style H fill:#2d6a2d,color:#fff
```

**Coverage: COMPLETE.** `normalizeQuantities` runs before `buildPerOpeningItems`. `leaf_side` is stamped. Electric hinge logic fully covered.

**File references:**
- `src/app/api/parse-pdf/apply-revision/route.ts:93` — `normalizeQuantities()` call
- `src/app/api/parse-pdf/apply-revision/route.ts:210` — `buildPerOpeningItems()` for changed doors
- `src/app/api/parse-pdf/apply-revision/route.ts:277` — `buildPerOpeningItems()` for new doors

---

## Path 5: Background Batch Job (KNOWN GAP)

The batch job orchestrator processes large PDFs in the background. It has the most complex pipeline but **bypasses `buildPerOpeningItems`**.

```mermaid
flowchart TB
    A["POST /jobs/[id]/run"] --> B["Phase 1: Classify Pages<br/>(Python classify-pages.py)"]
    B --> C["Phase 2: Detect Columns<br/>(Python detect-mapping.py)"]
    C --> D["Phase 3: Split PDF into Chunks"]
    D --> E["Phase 4: Process Chunks"]
    
    E --> E1["processChunk() per chunk"]
    E1 --> E2["callPdfplumber()<br/>Python normalize_quantities"]
    E2 --> E3["Punchy CP2"]
    E3 --> E4["TS normalizeQuantities()<br/>line 1059"]
    E4 --> E5["Punchy CP3"]
    
    E5 --> F{"Phase 4b:<br/>Empty sets?"}
    F -->|Yes| G["Vision Extract<br/>(Strategy B)"]
    F -->|No| H["Skip"]
    G --> I["Phase 4c: Reconcile<br/>Strategy A + B"]
    H --> J["Phase 5: Triage"]
    I --> J
    
    J --> K["Phase 6: writeStagingData RPC"]
    K --> L["merge_extraction()"]
    L --> M[(Production Tables)]

    style E4 fill:#2d6a2d,color:#fff
    style K fill:#cc6600,color:#fff
```

### What's Missing

The batch job writes items via `writeStagingData()` RPC (lines 898-914 of `jobs/[id]/run/route.ts`), which maps hardware set items directly — **without calling `buildPerOpeningItems()`**.

This means batch-processed projects are missing:

| Feature | Wizard Path | Batch Job Path |
|---------|:-----------:|:--------------:|
| Door/Frame structural rows | YES | **NO** |
| `leaf_side` stamped | YES | **NO** |
| Per-leaf hinge split (electric displaces standard) | YES | **NO** |
| `normalizeQuantities()` quantity division | YES | YES |

**Impact:** Production data from batch jobs has lower fidelity than wizard-imported data. The UI's `classify-leaf-items.ts` has fallback logic for NULL `leaf_side`, so rendering won't break — but quantities on pair doors with electric hinges will be wrong.

**File references:**
- `src/app/api/jobs/[id]/run/route.ts:1059` — `normalizeQuantities()` in `processChunk()`
- `src/app/api/jobs/[id]/run/route.ts:898-914` — staging payload construction (no `buildPerOpeningItems`)

---

## Path 6: Deep Extraction (Agentic)

Used for hardware sets that initial extraction returned empty. Claude Haiku vision reads the PDF region and extracts items directly.

```mermaid
flowchart LR
    A["Empty Set Detected"] --> B["deep-extract/route.ts"]
    B --> C["Claude Haiku Vision<br/>with golden sample"]
    C --> D["Items tagged<br/>qty_source='deep_extract'"]
    D --> E["Merged into<br/>Wizard State"]
    E --> F["save/route.ts<br/>buildPerOpeningItems()"]
    F --> G[(Database)]

    style D fill:#666,color:#fff
    style F fill:#2d6a2d,color:#fff
```

**Coverage: ACCEPTABLE.** Items get `qty_source='deep_extract'` which is in the `NEVER_RENORMALIZE` set — `normalizeQuantities()` skips them even if it runs later. The LLM returns per-opening quantities directly. Items flow through `buildPerOpeningItems()` at save time, so `leaf_side` IS stamped.

**File references:**
- `src/app/api/parse-pdf/deep-extract/route.ts` — entry point
- `src/lib/parse-pdf-helpers.ts:156` — `NEVER_RENORMALIZE` set includes `'deep_extract'`

---

## Path 7: Region Rescan

User draws a bounding box on a rendered PDF page to re-extract a specific area.

```mermaid
flowchart LR
    A["User Draws Bbox<br/>on PDF Page"] --> B["region-extract/route.ts"]
    B --> C["Python extract-tables.py<br/>pdfplumber.crop(bbox)"]
    C --> D["Python normalize_quantities()<br/>annotates items"]
    D --> E["Route OVERWRITES<br/>qty_source → 'region_extract'"]
    E --> F["Return to Browser"]
    F --> G["Replaces set items<br/>in wizard state"]
    G --> H["save/route.ts<br/>buildPerOpeningItems()"]
    H --> I[(Database)]

    style E fill:#cc6600,color:#fff
    style H fill:#2d6a2d,color:#fff
```

**Coverage: ACCEPTABLE with caveat.** Python's division annotations (`needs_division`, `parsed`) are discarded when region-extract overwrites `qty_source` to `'region_extract'` (line 121). Since `'region_extract'` is in `NEVER_RENORMALIZE`, items will never be divided even if their quantities are aggregates. Mitigated by the fact that region rescans target small specific areas.

**File references:**
- `src/app/api/parse-pdf/region-extract/route.ts:121` — `qty_source` overwrite
- `src/lib/parse-pdf-helpers.ts:157` — `NEVER_RENORMALIZE` includes `'region_extract'`

---

## Path 8: Vision Extraction

Full-page Claude Sonnet extraction, used as "Strategy B" in batch job reconciliation or from the wizard triage step.

```mermaid
flowchart LR
    A["Triage Step<br/>or Batch Job Phase 4b"] --> B["vision-extract/route.ts"]
    B --> C["Classify Pages<br/>(filter schedule pages)"]
    C --> D["Claude Sonnet<br/>page-by-page extraction"]
    D --> E["Returns HardwareSets"]
    E --> F{"Context?"}
    F -->|Wizard| G["Merged into<br/>wizard state"]
    F -->|Batch Job| H["Reconcile with<br/>Strategy A results"]
    G --> I["save/route.ts"]
    H --> J["writeStagingData"]

    style I fill:#2d6a2d,color:#fff
    style J fill:#cc6600,color:#fff
```

**Coverage: ACCEPTABLE.** In the wizard path, items flow through `save/route.ts` and `buildPerOpeningItems`. In the batch job path, they merge with Strategy A results in reconciliation but still bypass `buildPerOpeningItems` (same batch job gap).

---

## Python-to-TypeScript Normalization Relationship

The quantity normalization is deliberately split across two languages:

```mermaid
flowchart TB
    subgraph Python["Python: extract-tables.py"]
        PA["Parse PDF tables<br/>(pdfplumber)"]
        PB["Classify items<br/>(_classify_hardware_item)"]
        PC["Determine divisor<br/>(leaf_count or door_count)"]
        PD["Annotate metadata:<br/>qty_source, qty_total,<br/>qty_door_count"]
    end

    subgraph TS["TypeScript: parse-pdf-helpers.ts"]
        TA["Read Python annotations"]
        TB["PATH 1: Python-annotated<br/>(needs_division)"]
        TC["PATH 2: Single-door high qty<br/>(needs_cap)"]
        TD["PATH 3: RHR/LHR pair<br/>(rhr_lhr_pair)"]
        TE["PATH 4: Needs review<br/>(needs_review)"]
        TF["PATH 5: TS fallback<br/>(parsed or unset)"]
        TG["Perform actual division<br/>(item.qty = raw / divisor)"]
    end

    PA --> PB --> PC --> PD
    PD -->|"JSON response"| TA
    TA --> TB & TC & TD & TE & TF
    TB & TC & TD & TE & TF --> TG

    style PD fill:#4a6fa5,color:#fff
    style TG fill:#2d6a2d,color:#fff
```

**Why the split?**
- **Python** has the best heading/block context (door counts, leaf counts from the PDF structure)
- **TypeScript** has the hardware taxonomy (per_leaf, per_opening, per_pair, per_frame scopes)
- Python annotates *how* to divide; TypeScript performs the division
- Neither alone has complete information

**File references:**
- `api/extract-tables.py:3885-4208` — Python `normalize_quantities()`
- `src/lib/parse-pdf-helpers.ts:1635-2016` — TS `normalizeQuantities()`

---

## NEVER_RENORMALIZE Guard

Items with certain `qty_source` values are protected from double-division. The `NEVER_RENORMALIZE` set (`parse-pdf-helpers.ts:155-158`) includes:

| qty_source | Set by | Meaning |
|------------|--------|---------|
| `'divided'` | `normalizeQuantities()` | Already divided — don't re-divide |
| `'capped'` | `normalizeQuantities()` | Already capped at category max |
| `'user_override'` | UI | User manually set the quantity |
| `'deep_extract'` | `deep-extract/route.ts` | LLM returned per-opening qty directly |
| `'region_extract'` | `region-extract/route.ts` | User-scanned region, assume per-opening |
| `'rhr_lhr_pair'` | `normalizeQuantities()` | RHR/LHR pair → qty=1 |

This guard is essential for preventing quantity corruption when items pass through multiple pipeline stages.
