# Hinge Quantity Pipeline

This document details the hinge-specific logic in the extraction pipeline. The core complexity is the **"electric hinge displaces standard hinge"** rule for pair doors, which is implemented across multiple pipeline stages.

## The Rule

On pair doors, each leaf gets its own set of hinges. When an electric (electrified/conductor) hinge is present, it physically replaces one standard hinge position on the **active leaf** only. The inactive leaf keeps its full standard hinge count.

**Example:** A pair door with 4 standard hinges and 1 electric hinge per opening:
- **Active leaf:** 3 standard + 1 electric = 4 total hinge positions
- **Inactive leaf:** 4 standard + 0 electric = 4 total hinge positions

This rule affects three pipeline stages: quantity division, per-opening item building, and render-time leaf grouping.

---

## Pipeline Overview

```mermaid
flowchart TB
    A["PDF: 'Hinge 5BB1 4.5x4.5  qty: 8'<br/>'Hinge CON TW8  qty: 1'"]
    
    A --> B["Stage 1: Python Annotation<br/>extract-tables.py:3885"]
    B --> B1["Classify: 'hinge' → leaf division<br/>'electric_hinge' → opening division"]
    B1 --> B2["Annotate: qty_source='needs_division'<br/>qty_total=8, qty_door_count=2"]
    
    B2 --> C["Stage 2: TS normalizeQuantities()<br/>parse-pdf-helpers.ts:1635"]
    C --> C1["Standard hinge: 8 / 2 leaves = 4<br/>Electric hinge: 1 / 1 door = 1"]
    C1 --> C2{"Asymmetric split<br/>detection"}
    C2 -->|"(std + elec) / leaves<br/>= integer?"| C3["Use ceil() for<br/>standard hinge qty"]
    
    C3 --> D["Stage 3: buildPerOpeningItems()<br/>parse-pdf-helpers.ts:2633"]
    D --> D1["Scan for electric hinges"]
    D1 --> D2["Split standard hinge<br/>into per-leaf rows"]
    D2 --> D3["Active: qty=3, leaf_side='active'<br/>Inactive: qty=4, leaf_side='inactive'<br/>Electric: qty=1, leaf_side='active'"]
    
    D3 --> E["Stage 4: groupItemsByLeaf()<br/>classify-leaf-items.ts:131"]
    E --> E1{"leaf_side<br/>present?"}
    E1 -->|"Yes (saved data)"| E2["Route by persisted value<br/>— no hinge logic needed"]
    E1 -->|"No (wizard preview)"| E3["Taxonomy fallback:<br/>active: qty - electricQty<br/>inactive: qty"]

    style B fill:#4a6fa5,color:#fff
    style C fill:#2d6a2d,color:#fff
    style D fill:#2d6a2d,color:#fff
    style E fill:#666,color:#fff
```

---

## Stage-by-Stage Detail

### Stage 1: Python Annotation

Python classifies items and recommends a division strategy but does **not** mutate quantities or handle the electric-displaces-standard rule.

```mermaid
flowchart LR
    A["Item: 'Hinge 5BB1 4.5x4.5'"] --> B["_classify_hardware_item()"]
    B --> C{"Category?"}
    C -->|"'hinge'"| D["DIVISION_PREFERENCE['hinge'] = 'leaf'"]
    C -->|"'electric_hinge'"| E["DIVISION_PREFERENCE['electric_hinge'] = 'opening'"]
    
    D --> F["Recommend divisor = leaf_count"]
    E --> G["Recommend divisor = door_count"]
    
    F --> H["Set metadata only:<br/>qty_source='needs_division'<br/>qty_total=8<br/>qty_door_count=leaf_count"]
    G --> H

    style H fill:#4a6fa5,color:#fff
```

**File:** `api/extract-tables.py:3885-4208`

Python has **no knowledge** of the electric-displaces-standard relationship. It simply recommends different divisors for standard vs electric hinges.

### Stage 2: TS Quantity Division

TypeScript's `normalizeQuantities()` performs the actual division and detects asymmetric hinge splits.

```mermaid
flowchart TB
    A["Items arrive with Python annotations"]
    A --> B["Electric hinge pre-scan<br/>line 1705"]
    B --> C["Count setElectricHingeQty<br/>for the hardware set"]
    
    C --> D{"Item's qty_source?"}
    
    D -->|"'needs_division'<br/>(PATH 1)"| E["Standard hinge:<br/>raw=8, divisor=leafCount=2"]
    D -->|"'parsed' or unset<br/>(PATH 5)"| F["TS taxonomy fallback:<br/>classifyItemScope() → 'per_leaf'"]
    
    E --> G{"8 / 2 = 4<br/>Integer?"}
    G -->|Yes| H["qty = 4 per leaf"]
    G -->|No| I{"Asymmetric split?<br/>(std + elec) / leaves = int?"}
    I -->|Yes| J["qty = ceil(std / leaves)<br/>= larger leaf count"]
    I -->|No| K["Flag for review"]
    
    F --> L["Same asymmetric<br/>split check"]

    style H fill:#2d6a2d,color:#fff
    style J fill:#cc6600,color:#fff
```

**The asymmetric split detection** handles cases like: 7 standard + 2 electric = 9 total. 9 / 2 leaves = 4.5 (not integer), but `(7 + 2) / 2 = 4.5` — wait, that's not integer either. The real scenario: 7 standard hinges across 2 leaves where one leaf has an electric hinge. `7 / 2 = 3.5` (not integer), but `(7 + 1) / 2 = 4` (integer!). So: active leaf = ceil(7/2) = 4 standard, inactive leaf = 4 standard. The electric hinge (qty=1) displaces one position on active.

**This logic is duplicated** between PATH 1 (lines 1758-1772) and PATH 5 (lines 1900-1916) — identical asymmetric split check in both code paths.

**File:** `src/lib/parse-pdf-helpers.ts:1635-2016`

### Stage 3: Per-Opening Item Builder (Save Path)

`buildPerOpeningItems()` creates the actual database rows, splitting standard hinges into separate active/inactive rows when electric hinges are present.

```mermaid
flowchart TB
    A["buildPerOpeningItems() called<br/>for each opening"]
    A --> B{"detectIsPair()?"}
    
    B -->|No| C["Single Door<br/>All items: leaf_side='active'"]
    B -->|Yes| D["Pair Door"]
    
    D --> E["Scan electric hinges<br/>totalElectricHingeQty<br/>lines 2708-2715"]
    
    E --> F["For each item in set:"]
    F --> G{"classifyItem(name)?"}
    
    G -->|"electric_hinge"| H["Single row:<br/>qty = item.qty<br/>leaf_side = 'active'<br/>lines 2722-2734"]
    
    G -->|"hinges (standard)"| I{"totalElectricHingeQty > 0?"}
    I -->|Yes| J["TWO rows:<br/>Active: qty = raw - electricQty<br/>leaf_side = 'active'<br/>Inactive: qty = raw<br/>leaf_side = 'inactive'<br/>lines 2737-2768"]
    I -->|No| K["Single row:<br/>leaf_side via computeLeafSide()"]
    
    G -->|"other category"| L["Single row:<br/>leaf_side via computeLeafSide()"]

    style H fill:#2d6a2d,color:#fff
    style J fill:#2d6a2d,color:#fff
```

**File:** `src/lib/parse-pdf-helpers.ts:2633-2786`

### Stage 4: Render-Time Leaf Grouping

`groupItemsByLeaf()` groups items into Shared / Leaf 1 (Active) / Leaf 2 (Inactive) for display. It serves **two distinct contexts** and must handle both.

```mermaid
flowchart TB
    A["groupItemsByLeaf(items, leafCount)"]
    A --> B{"leafCount <= 1?"}
    B -->|Yes| C["All items → shared<br/>(single door, no leaf split)"]
    B -->|No| D["Pair door processing"]
    
    D --> E["Scan electric hinges<br/>where leaf_side is null"]
    
    E --> F["For each item:"]
    F --> G{"item.leaf_side<br/>is set?"}
    
    G -->|"'active'"| H["→ Leaf 1 only"]
    G -->|"'inactive'"| I["→ Leaf 2 only"]
    G -->|"'shared'"| J["→ Shared"]
    G -->|"'both'"| K["→ Both leaves"]
    
    G -->|"null/undefined<br/>(wizard preview<br/>or legacy data)"| L["Taxonomy fallback"]
    
    L --> M{"classifyItem?"}
    M -->|"electric_hinge"| N["→ Leaf 1 only"]
    M -->|"standard hinge<br/>+ electrics present"| O["Leaf 1: qty - electricQty<br/>Leaf 2: qty (unchanged)"]
    M -->|"per_pair / per_frame"| P["→ Shared"]
    M -->|"other"| Q["→ Both leaves"]

    style H fill:#2d6a2d,color:#fff
    style I fill:#2d6a2d,color:#fff
    style N fill:#666,color:#fff
    style O fill:#666,color:#fff
```

**The two contexts:**
- **Saved data** (items have `leaf_side`): The persisted-value path handles everything. No hinge math needed — `buildPerOpeningItems` already split the rows.
- **Wizard preview** (items have NO `leaf_side`): The taxonomy fallback path re-implements the electric-displaces-standard rule for on-the-fly display. Items are NOT yet split into per-leaf rows, so the adjustment happens here.

**File:** `src/lib/classify-leaf-items.ts:131-226`

---

## Coverage Per Extraction Path

| Path | Division Adjustment (normalizeQuantities) | Per-Leaf Split (buildPerOpeningItems) | Render Fallback (groupItemsByLeaf) |
|------|:---:|:---:|:---:|
| Wizard (small/large) | YES | YES (at save) | Preview only |
| Batch job | YES | **NO** | Fallback needed |
| Apply revision | YES | YES | Not needed |
| Deep extract | N/A (LLM-determined) | YES (at save) | Preview only |
| Region rescan | N/A (terminal qty_source) | YES (at save) | Preview only |

The batch job gap means items promoted from batch jobs have no `leaf_side` and no per-leaf hinge split. The display falls back to `groupItemsByLeaf` taxonomy logic, which works for unsplit data but produces wrong results if data was later re-imported with `buildPerOpeningItems` creating split rows.

---

## The Four Classification Systems

Hinge identification depends on regex classification. There are **four independent classifiers** that must agree on what constitutes a "hinge" vs "electric_hinge":

```mermaid
flowchart TB
    subgraph Python["Python (extract-tables.py)"]
        P1["_CATEGORY_PATTERNS<br/>lines 218-252"]
        P2["DIVISION_PREFERENCE<br/>lines 192-215"]
        P1 --> P2
    end
    
    subgraph TS1["TS: hardware-taxonomy.ts"]
        T1["HARDWARE_TAXONOMY<br/>lines 47-678"]
        T2["classifyItem()"]
        T1 --> T2
    end
    
    subgraph TS2["TS: parse-pdf-helpers.ts"]
        T3["_taxonomyRegexCache<br/>line 107"]
        T4["classifyItemScope()"]
        T3 --> T4
    end
    
    subgraph TS3["TS: quantity-propagation.ts"]
        T5["_taxonomyRegexCache<br/>line 18"]
        T6["classifyItemCategory()"]
        T5 --> T6
    end

    style P1 fill:#4a6fa5,color:#fff
    style T1 fill:#2d6a2d,color:#fff
    style T3 fill:#2d6a2d,color:#fff
    style T5 fill:#cc6600,color:#fff
```

### Known Divergences

| Issue | Python | TypeScript |
|-------|--------|------------|
| Category ID for standard hinges | `"hinge"` (singular) | `"hinges"` (plural) |
| Spring hinge category | Falls through to `"hinge"` | Separate `"spring_hinge"` category |
| Check order: continuous vs electric | `continuous_hinge` checked **before** `electric_hinge` | `electric_hinge` checked **first** |
| Pivot hinge category ID | `"pivot"` | `"pivot_hinge"` |
| Regex pattern scope | Broader (e.g., `"hinge"` catches pivots) | More specific (separate patterns) |

These divergences rarely cause bugs because:
1. Python only recommends a divisor — it doesn't make leaf-attribution decisions
2. TS re-classifies every item independently
3. The critical "is this an electric hinge?" check agrees in both systems

But edge cases (e.g., a name matching both `continuous_hinge` and `electric_hinge` patterns) could classify differently due to check ordering.

---

## Asymmetric Split Detection

When the PDF shows an odd total that doesn't divide evenly by leaf count, the pipeline checks whether electric hinges explain the asymmetry.

```mermaid
flowchart LR
    A["Standard Hinge<br/>raw qty = 7"] --> B{"7 / 2 leaves<br/>= 3.5"}
    B -->|"Not integer"| C{"Check: is there<br/>an electric hinge<br/>in this set?"}
    C -->|Yes, electricQty=1| D{"(7 + 1) / 2<br/>= 4.0 integer?"}
    D -->|Yes| E["Asymmetric split confirmed!<br/>Per-leaf qty = ceil(7/2) = 4<br/>(the 'larger' leaf count)"]
    D -->|No| F["Flag for review"]
    C -->|No| F

    style E fill:#2d6a2d,color:#fff
    style F fill:#cc6600,color:#fff
```

**Why ceil?** The inactive leaf gets the full standard count (4), and the active leaf gets the remainder after electric displacement (4 - 1 = 3 standard + 1 electric = 4 total). Using `ceil()` during division gives us the inactive leaf's count, which is the "undisplaced" value.

**File references:**
- `src/lib/parse-pdf-helpers.ts:1758-1772` — PATH 1 asymmetric check
- `src/lib/parse-pdf-helpers.ts:1900-1916` — PATH 5 asymmetric check (duplicate)

---

## `computeLeafSide()` Logic

Determines `leaf_side` for items that aren't special-cased by `buildPerOpeningItems`. Electric hinges are handled here but **overridden** by `buildPerOpeningItems` — a belt-and-suspenders guard.

```mermaid
flowchart TB
    A["computeLeafSide(itemName, isPair, classifyFn)"]
    A --> B{"isPair?"}
    B -->|No| C["Return 'active'<br/>(single door)"]
    B -->|Yes| D["category = classifyFn(name)"]
    D --> E{"install_scope?"}
    E -->|per_pair| F["Return 'shared'"]
    E -->|per_frame| G["Return 'shared'"]
    E -->|per_opening| H["Return 'active'<br/>(lockset, etc.)"]
    E -->|per_leaf| I["Return 'both'"]
    E -->|electric_hinge| J["Return 'active'<br/>(line 216-218)"]
    E -->|unknown| K["Return null<br/>(fallback to render-time)"]
    
    style J fill:#cc6600,color:#fff
```

**Note:** The `electric_hinge → 'active'` return at line 216-218 is immediately overridden by `buildPerOpeningItems` which has its own electric hinge handling. This is intentional redundancy.

**File:** `src/lib/parse-pdf-helpers.ts:197-222`

---

## Save Path vs Preview Path

The electric-displaces-standard rule is implemented in **two places** that must produce equivalent results:

```mermaid
flowchart TB
    subgraph Save["Save Path (buildPerOpeningItems)"]
        S1["Creates separate DB rows"]
        S2["Active row: qty = raw - electricQty"]
        S3["Inactive row: qty = raw"]
        S4["Electric row: qty = electricQty"]
        S1 --> S2 & S3 & S4
    end
    
    subgraph Preview["Preview Path (groupItemsByLeaf)"]
        P1["Adjusts single item on-the-fly"]
        P2["Active display: qty - electricHingeQty"]
        P3["Inactive display: qty (unchanged)"]
        P4["Electric: active only"]
        P1 --> P2 & P3 & P4
    end
    
    subgraph Result["User Sees Same Result"]
        R1["Active Leaf:<br/>3 standard + 1 electric = 4"]
        R2["Inactive Leaf:<br/>4 standard = 4"]
    end
    
    Save --> Result
    Preview --> Result

    style Save fill:#2d6a2d,color:#fff
    style Preview fill:#666,color:#fff
```

**These are NOT consolidatable today** because the save path creates physical row splits while the preview path operates on unsaved items. They encode the same business rule independently — a potential source of future divergence.
