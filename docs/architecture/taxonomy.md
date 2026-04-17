# Hardware Classification System

This document describes the hardware taxonomy — the classification system that determines how items are categorized, how quantities scale across door types, and where the known divergences between Python and TypeScript classifiers exist.

## Overview

The classification system answers two questions for every hardware item:
1. **What category is it?** (hinge, lockset, closer, etc.)
2. **How does its quantity scale?** (per leaf, per opening, per pair, per frame)

These answers drive quantity division, leaf attribution, and pair-door display logic throughout the pipeline.

---

## HARDWARE_TAXONOMY (TypeScript Source of Truth)

Defined in `src/lib/hardware-taxonomy.ts:47-678`. Each category has:

```typescript
interface HardwareCategory {
  id: string                           // Unique category ID
  label: string                        // Display name
  name_patterns: string[]              // Regex patterns (case-insensitive)
  universal: boolean                   // Expected on every opening?
  exterior: boolean                    // Expected on exterior?
  interior: boolean                    // Expected on interior?
  fire_rated: boolean                  // Expected on fire-rated?
  pairs_only: boolean                  // Only relevant for pairs?
  install_scope: InstallScope          // How quantities scale
  typical_qty_single: [number, number] // Min/max qty for singles
  typical_qty_pair: [number, number]   // Min/max qty for pairs
}
```

### Category Listing

```mermaid
flowchart TB
    subgraph Hanging["Hanging Hardware"]
        EH["electric_hinge<br/>per_opening"]
        CH["continuous_hinge<br/>per_leaf"]
        PH["pivot_hinge<br/>per_opening"]
        SH["spring_hinge<br/>per_leaf"]
        H["hinges (butt)<br/>per_leaf"]
    end
    
    subgraph Locking["Locking & Latching"]
        LS["lockset<br/>per_opening"]
        ED["exit_device<br/>per_leaf"]
        FB["flush_bolt<br/>per_pair"]
        DP["dust_proof_strike<br/>per_pair"]
        ST["strike<br/>per_opening"]
    end
    
    subgraph Closing["Closing"]
        AO["auto_operator<br/>per_opening"]
        CL["closer<br/>per_leaf"]
        CO["coordinator<br/>per_pair"]
    end
    
    subgraph Electronic["Electronic"]
        EM["elec_modification<br/>per_opening"]
        WH["wire_harness<br/>per_leaf"]
    end
    
    subgraph Sealing["Sealing & Gasketing"]
        GK["gasket<br/>per_frame"]
        SS["smoke_seal<br/>per_frame"]
        GS["gasketing<br/>per_frame"]
        AS["acoustic_seal<br/>per_frame"]
        WS["weatherstrip<br/>per_frame"]
    end
    
    subgraph Other["Other Categories"]
        CY["cylinder_housing<br/>per_opening"]
        CO2["core<br/>per_opening"]
        KP["kick_plate<br/>per_leaf"]
        SP["stop<br/>per_leaf"]
        DS["door_sweep<br/>per_leaf"]
        TH["threshold<br/>per_frame"]
        RD["rain_drip<br/>per_frame"]
        AG["astragal<br/>per_pair"]
        MU["mullion<br/>per_pair"]
        SI["silencer<br/>per_frame"]
        SG["signage<br/>per_opening"]
        VW["viewer<br/>per_opening"]
        BO["by_others<br/>per_opening"]
    end

    style EH fill:#cc6600,color:#fff
    style CH fill:#4a6fa5,color:#fff
    style PH fill:#cc6600,color:#fff
    style SH fill:#4a6fa5,color:#fff
    style H fill:#4a6fa5,color:#fff
```

**Color key:** Orange = `per_opening`, Blue = `per_leaf`

---

## Install Scope Values

The `install_scope` determines how a category's quantity scales with door configuration:

```mermaid
flowchart TB
    subgraph per_leaf["per_leaf"]
        PL1["Qty applies to EACH door leaf"]
        PL2["Single door: qty × 1"]
        PL3["Pair door: qty × 2<br/>(one set per leaf)"]
        PL4["Examples: hinges, closer,<br/>exit device, kick plate"]
    end
    
    subgraph per_opening["per_opening"]
        PO1["Qty is per OPENING<br/>regardless of single/pair"]
        PO2["Single door: qty × 1"]
        PO3["Pair door: qty × 1<br/>(distribute per leaf in UI)"]
        PO4["Examples: lockset, electric hinge,<br/>auto operator, cylinder"]
    end
    
    subgraph per_pair["per_pair"]
        PP1["Only on PAIR openings"]
        PP2["Single door: qty = 0"]
        PP3["Pair door: qty × 1"]
        PP4["Examples: coordinator,<br/>flush bolt, astragal, mullion"]
    end
    
    subgraph per_frame["per_frame"]
        PF1["Qty is per FRAME"]
        PF2["Single door: qty × 1"]
        PF3["Pair door: qty × 1<br/>(same qty, shared)"]
        PF4["Examples: threshold, gasket,<br/>weatherstrip, silencer"]
    end
```

### Impact on Pipeline

| Install Scope | Python Division Strategy | `normalizeQuantities()` Divisor | `buildPerOpeningItems()` | `groupItemsByLeaf()` |
|---------------|------------------------|---------------------------------|--------------------------|---------------------|
| `per_leaf` | `"leaf"` → divide by leaf_count | Uses leaf_count | Per-leaf row with `computeLeafSide()` | Both leaves |
| `per_opening` | `"opening"` → divide by door_count | Uses door_count | Single row, `leaf_side='active'` | Active leaf only |
| `per_pair` | `"opening_only"` → no division | No division | Single row, `leaf_side='shared'` | Shared section |
| `per_frame` | `"opening_only"` → no division | No division | Single row, `leaf_side='shared'` | Shared section |

---

## Python Classification: _CATEGORY_PATTERNS

Defined in `api/extract-tables.py:218-252`. Python maintains its own independent regex list with different category names.

### Python's Categories and Division Preferences

```mermaid
flowchart LR
    subgraph Patterns["_CATEGORY_PATTERNS (Python)"]
        direction TB
        P1["continuous_hinge"]
        P2["electric_hinge"]
        P3["hinge (generic)"]
        P4["pivot"]
        P5["lockset"]
        P6["exit_device"]
        P7["flush_bolt"]
        P8["auto_operator"]
        P9["closer"]
        P10["coordinator"]
        P11["+ 11 more..."]
    end
    
    subgraph Division["DIVISION_PREFERENCE"]
        D1["'leaf' division<br/>(divide by leaf_count)"]
        D2["'opening' division<br/>(divide by door_count)"]
        D3["'opening_only'<br/>(no division)"]
    end
    
    P1 & P3 & P4 --> D1
    P2 & P5 & P9 --> D2
    P6 & P7 & P8 & P10 --> D3
```

**File:** `api/extract-tables.py:192-260`

### DIVISION_PREFERENCE mapping

| Division Strategy | Python Categories |
|-------------------|-------------------|
| `"leaf"` | hinge, wire_harness, continuous_hinge, pivot, exit_device, stop, kick_plate, sweep |
| `"opening"` | electric_hinge, auto_operator, closer, lockset, holder, cylinder, strike, pull, silencer |
| `"opening_only"` | threshold, astragal, seal, coordinator, flush_bolt |

---

## The Four Regex Classifiers

The system has four independent regex classification systems. All must agree for consistent behavior.

### Classifier 1: Python `_CATEGORY_PATTERNS`

**File:** `api/extract-tables.py:218-252`
**Used by:** `_classify_hardware_item()` (line 255)
**Purpose:** Determines division strategy (leaf vs opening vs opening_only)
**Called from:** `normalize_quantities()` — Python annotation phase

```
Pattern examples:
  continuous_hinge: r"(?i)\bcontinuous\s*hinge"
  electric_hinge:   r"(?i)\belectric.*hinge|hinge.*electric|conductor.*hinge|hinge.*\bCON\b|hinge.*\bTW\d|power\s*transfer"
  hinge (generic):  r"(?i)\bhinge|pivot|spring\s*hinge"
```

### Classifier 2: TypeScript `HARDWARE_TAXONOMY`

**File:** `src/lib/hardware-taxonomy.ts:47-678`
**Used by:** `classifyItem()` — primary TS classifier
**Purpose:** Maps item names to categories with full metadata (install_scope, typical quantities, etc.)
**Called from:** `buildPerOpeningItems()`, `groupItemsByLeaf()`, `normalizeQuantities()`, UI components

```
Pattern examples (electric_hinge):
  "hinge.*\\bCON\\b"
  "hinge.*\\bTW\\d"
  "hinge.*electr"
  "electr.*hinge"
  "conductor.*hinge"
  "power\\s*transfer\\s*hinge"
```

### Classifier 3: TS `_taxonomyRegexCache` (parse-pdf-helpers.ts)

**File:** `src/lib/parse-pdf-helpers.ts:107-112`
**Used by:** `classifyItemScope()` (line 119)
**Purpose:** Quick scope lookup (per_leaf, per_opening, etc.) during quantity normalization
**Called from:** `normalizeQuantities()` PATH 5 (TS fallback)

This is a **compiled cache** of `HARDWARE_TAXONOMY` regex patterns. Same source data as Classifier 2 — no divergence risk.

### Classifier 4: TS `_taxonomyRegexCache` (quantity-propagation.ts)

**File:** `src/lib/quantity-propagation.ts:18-33`
**Used by:** `classifyItemCategory()` (line 24)
**Purpose:** Category lookup for quantity propagation across sets
**Called from:** `propagateQuantityDecision()` (line 68)

This is a **separate compiled copy** of the same `HARDWARE_TAXONOMY` regex patterns. Same source data — but a duplicated cache. Could be consolidated into a shared export from `hardware-taxonomy.ts`.

### Classifier Comparison

```mermaid
flowchart TB
    HT["HARDWARE_TAXONOMY<br/>(hardware-taxonomy.ts)<br/>Single Source of Truth"]
    
    HT --> C2["Classifier 2: classifyItem()<br/>Full category + metadata"]
    HT --> C3["Classifier 3: classifyItemScope()<br/>parse-pdf-helpers.ts<br/>Compiled cache — scope only"]
    HT --> C4["Classifier 4: classifyItemCategory()<br/>quantity-propagation.ts<br/>Separate compiled cache"]
    
    PY["Python _CATEGORY_PATTERNS<br/>(extract-tables.py)<br/>INDEPENDENT Source"]
    PY --> C1["Classifier 1: _classify_hardware_item()<br/>Category → division preference"]
    
    style HT fill:#2d6a2d,color:#fff
    style PY fill:#cc6600,color:#fff
    style C1 fill:#cc6600,color:#fff
```

---

## Known Divergences Between Python and TypeScript

### Category ID Mismatches

| Item Type | Python Category | TypeScript Category | Impact |
|-----------|----------------|---------------------|--------|
| Standard hinge | `"hinge"` | `"hinges"` | IDs don't match in string comparisons |
| Pivot hinge | `"pivot"` | `"pivot_hinge"` | IDs don't match |
| Spring hinge | Falls through to `"hinge"` | `"spring_hinge"` (separate) | Different categorization |

These ID mismatches don't cause bugs today because Python and TypeScript never compare category IDs across the boundary — they each classify independently and act on their own results. But it prevents future consolidation.

### Regex Pattern Differences

| Pattern | Python | TypeScript |
|---------|--------|------------|
| Generic hinge | `r"(?i)\bhinge\|pivot\|spring\s*hinge"` — catches pivots AND springs | Separate patterns for `pivot_hinge`, `spring_hinge`, `hinges` |
| Check order | `continuous_hinge` **before** `electric_hinge` | `electric_hinge` **before** `continuous_hinge` |
| Pivot | Captured by generic `"hinge"` pattern | Separate `"pivot_hinge"` category |

### Check Order Risk

Python checks `continuous_hinge` before `electric_hinge`. TypeScript checks `electric_hinge` first. If an item name matches both patterns (e.g., "Continuous Electric Hinge" — unlikely but possible), they would classify differently:
- Python: `continuous_hinge` → `leaf` division → divide by leaf_count
- TypeScript: `electric_hinge` → `per_opening` scope → divide by door_count

### Division Strategy Differences

| Category | Python Division | TS Install Scope | Agreement? |
|----------|-----------------|-----------------|:---:|
| Standard hinges | `"leaf"` → leaf_count | `per_leaf` | YES |
| Electric hinges | `"opening"` → door_count | `per_opening` | YES |
| Continuous hinges | `"leaf"` → leaf_count | `per_leaf` | YES |
| Closers | `"opening"` → door_count | `per_leaf` | **NO** |
| Exit devices | `"leaf"` → leaf_count | `per_leaf` | YES |
| Stop/holder | `"opening"` (holder) | `per_leaf` (stop) | **MAYBE** |

**Closer divergence:** Python classifies closers as `"opening"` division (divide by door_count), but TypeScript classifies them as `per_leaf` (divide by leaf_count). For single doors, this doesn't matter (door_count = leaf_count = 1). For pair doors, it would mean Python recommends dividing by 1 (door_count for a pair = 1 if the set covers one opening) while TypeScript recommends dividing by 2 (leaf_count = 2). In practice, this is resolved by `normalizeQuantities()` which trusts Python's divisor in PATH 1 but uses TS scope in PATH 5.

---

## `getTaxonomyForPython()` Export

TypeScript already exports the taxonomy for Python consumption:

**File:** `src/lib/hardware-taxonomy.ts:828-838`

This function generates a JSON representation of `HARDWARE_TAXONOMY` for the Python `extract-tables.py` endpoint. However, Python does NOT currently use this export — it maintains its own independent `_CATEGORY_PATTERNS`.

**Recommended consolidation:** Have Python load the taxonomy JSON at startup and derive `DIVISION_PREFERENCE` from `install_scope`, eliminating the independent Python classifier entirely. See the [Hinge Logic simplification recommendations](./hinge-logic.md#the-four-classification-systems).

---

## How Classification Flows Through the Pipeline

```mermaid
sequenceDiagram
    participant PDF as PDF File
    participant Py as Python<br/>extract-tables.py
    participant TS_Norm as TS normalizeQuantities()<br/>parse-pdf-helpers.ts
    participant TS_Build as TS buildPerOpeningItems()<br/>parse-pdf-helpers.ts
    participant TS_Group as TS groupItemsByLeaf()<br/>classify-leaf-items.ts
    participant DB as Supabase DB
    participant UI as Browser UI

    PDF->>Py: Raw tables + headings
    Note over Py: _classify_hardware_item()<br/>→ category → DIVISION_PREFERENCE<br/>→ set qty_source, qty_door_count
    Py->>TS_Norm: Annotated items (qty NOT mutated)
    
    Note over TS_Norm: classifyItemScope()<br/>→ install_scope<br/>→ actual division
    TS_Norm->>TS_Build: Items with divided qty
    
    Note over TS_Build: classifyItem()<br/>→ category → computeLeafSide()<br/>→ leaf_side stamped
    TS_Build->>DB: Per-opening rows with leaf_side
    
    DB->>TS_Group: Items from DB
    Note over TS_Group: If leaf_side set: use directly<br/>If null: classifyItem() fallback<br/>→ group into Shared/Leaf1/Leaf2
    TS_Group->>UI: Grouped display data
```

---

## Taxonomy Maintenance Checklist

When adding a new hardware category or modifying patterns:

1. **Update `HARDWARE_TAXONOMY`** in `src/lib/hardware-taxonomy.ts` — this is the TypeScript source of truth
2. **Update `_CATEGORY_PATTERNS`** in `api/extract-tables.py` — Python's independent list (until consolidation)
3. **Update `DIVISION_PREFERENCE`** in `api/extract-tables.py` — Python's division strategy mapping
4. **Verify regex ordering** — specific patterns must precede generic catch-alls in both systems
5. **Check `install_scope` consistency** — the new category's scope must align with the Python division preference
6. **Test with `normalizeQuantities()`** — ensure PATH 1 (Python-annotated) and PATH 5 (TS fallback) produce the same result for the new category
