# Cut Sheet Fetching & Product Resolution

> Drop this into a fresh Claude Code session on the door-hardware-tracker repo.

## What You're Building

A system that automatically fetches manufacturer cut sheets (product data PDFs) for each unique hardware item found during extraction. This serves three purposes:
1. **Verification** — confirm extracted product data matches real products
2. **Correction** — when two items differ by one character, the cut sheet reveals which is correct
3. **Training data** — cut sheets provide structured product information for future AI improvements

## Architecture Overview

### Database Schema

New table: `cut_sheets`
```sql
CREATE TABLE cut_sheets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  -- Product identification
  manufacturer TEXT NOT NULL,
  model TEXT NOT NULL,
  normalized_model TEXT NOT NULL,  -- lowercase, whitespace-normalized for dedup
  item_name TEXT,                  -- e.g., "Hinges", "Exit Device"
  -- Cut sheet data
  pdf_url TEXT,                    -- Supabase storage path
  source_url TEXT,                 -- Original URL where found
  source_type TEXT,                -- 'manufacturer' | 'distributor' | 'manual'
  verified BOOLEAN DEFAULT FALSE,  -- User confirmed match
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, normalized_model)
);

-- RLS: project members only
ALTER TABLE cut_sheets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Project members can manage cut sheets"
  ON cut_sheets FOR ALL
  USING (project_id IN (SELECT project_id FROM project_members WHERE user_id = auth.uid()));
```

New table: `product_catalog` (cross-project, grows over time)
```sql
CREATE TABLE product_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manufacturer TEXT NOT NULL,
  model TEXT NOT NULL,
  normalized_model TEXT NOT NULL,
  item_category TEXT,              -- From hardware taxonomy (hinge, exit_device, etc.)
  cut_sheet_url TEXT,              -- Supabase storage path (shared)
  product_name TEXT,               -- Full product name from manufacturer
  specifications JSONB,            -- Parsed specs from cut sheet
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(normalized_model)
);
```

### Wizard Step: "Review Products"

Add a new wizard step between StepReview (item review) and StepConfirm (save):

**`src/components/ImportWizard/StepProducts.tsx`**

This step:
1. Extracts all unique items from `hardwareSets` (dedup by normalized model)
2. For each unique item, shows: manufacturer, model, qty across openings
3. Highlights near-duplicates (Levenshtein distance 1-2) in orange — "Did you mean X?"
4. Shows cut sheet status: found / not found / fetching
5. "Fetch Cut Sheets" button triggers the batch lookup

**UI Layout:**
```
┌─────────────────────────────────────────────────────┐
│ PRODUCT CATALOG (23 unique items)                    │
│ [Fetch All Cut Sheets]                               │
│                                                      │
│ ┌─ HINGES ─────────────────────────────────────────┐│
│ │ 5BB1 HW 4 1/2 x 4 1/2 NRP 652    Hager  ✓ PDF  ││
│ │ 5BB1 HW 4 1/2 x 4 1/2 CON TW8    Hager  ✓ PDF  ││
│ │ 5BB1 HW 4 1/2 x 4 1/2 NRP 652 IV Hager  ⚠ dup? ││
│ └──────────────────────────────────────────────────┘│
│ ┌─ EXIT DEVICES ───────────────────────────────────┐│
│ │ 9875L-F x 996L-M 06 576A-US32D    Von Duprin ⏳  ││
│ └──────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

### Near-Duplicate Detection

**`src/lib/product-dedup.ts`**

```typescript
interface ProductGroup {
  canonical: string          // The most common variant
  variants: string[]         // All model strings that are "close"
  occurrences: number        // How many openings use this product
  confidence: 'exact' | 'likely_dup' | 'uncertain'
}
```

Logic:
1. Normalize all model strings (lowercase, collapse whitespace, strip trailing punctuation)
2. Group by exact normalized match
3. For remaining unmatched items, compute Levenshtein distance between all pairs
4. If distance <= 2 AND same manufacturer AND same item category → flag as likely duplicate
5. Present to user: "These look like the same product. Which is correct?"
6. User picks the canonical version → apply-to-all across openings

### Cut Sheet Lookup API

**`src/app/api/cut-sheets/lookup/route.ts`**

This endpoint uses web search to find cut sheets:

```typescript
// Input: { manufacturer, model, category }
// Strategy:
// 1. Search manufacturer website first (most authoritative)
// 2. Fall back to top distributors: Quonset, Beacon, Locksmith Ledger
// 3. Fall back to general web search

// Use Anthropic's web search tool or a search API
// Look for PDF links on product pages
// Download PDF, upload to Supabase storage
// Return: { found: boolean, pdf_url?: string, source_url?: string }
```

**Search Strategy:**
1. `site:{manufacturer-domain} {model}` — manufacturer site first
2. `"{model}" cut sheet filetype:pdf` — direct PDF search
3. `"{model}" {manufacturer} specification` — spec page search
4. Top distributor sites: `site:quonset.com`, `site:beacon.com`, `site:anixter.com`

**Key Manufacturers & Their Sites:**
- Hager: hagerco.com
- Von Duprin: allegion.com/us/en/brands/von-duprin
- Schlage: allegion.com/us/en/brands/schlage
- LCN: allegion.com/us/en/brands/lcn
- Rixson: allegion.com/us/en/brands/rixson
- Pemko: allegion.com/us/en/brands/pemko
- Sargent: allegion.com/us/en/brands/sargent
- Corbin Russwin: allegion.com/us/en/brands/corbin-russwin
- Adams Rite: adamsrite.com
- Dorma: dormakaba.com
- ASSA ABLOY: assaabloy.com
- Securitron: securitron.com

### Storage

Cut sheets stored in Supabase Storage:
- Bucket: `cut-sheets`
- Path: `{project_id}/{normalized_model}.pdf`
- Shared catalog: `catalog/{normalized_model}.pdf`

### Integration with Existing Pipeline

**After extraction, before save:**
1. StepProducts shows unique items and near-duplicates
2. User resolves duplicates (or accepts defaults)
3. Cut sheets fetched in background (non-blocking)
4. Corrections applied to hardwareSets
5. Proceed to StepConfirm → save

**Correction propagation:**
When user selects a canonical model string for near-duplicates, use the existing `apply-to-all` pattern:
- Find all items across all openings matching the variant
- Update model string to canonical
- Record the correction in extraction_decisions table

## Implementation Order

### Phase 1: Near-Duplicate Detection (no API calls)
1. Create `src/lib/product-dedup.ts` with normalization + Levenshtein
2. Create `StepProducts.tsx` showing unique items grouped by category
3. Highlight near-duplicates, let user pick canonical version
4. Wire into ImportWizard between StepReview and StepConfirm

### Phase 2: Cut Sheet Lookup
1. Create Supabase migration for `cut_sheets` and `product_catalog` tables
2. Create lookup API endpoint
3. Add "Fetch Cut Sheets" button to StepProducts
4. Download and store PDFs in Supabase storage
5. Show PDF preview for found cut sheets

### Phase 3: Product Catalog (cross-project)
1. After successful extraction + save, copy cut sheet references to product_catalog
2. On future extractions, check product_catalog first (instant lookup)
3. Build admin page to browse/manage the catalog

## Constraints

- Read CLAUDE.md for Turbopack TypeScript rules
- Read AGENTS.md for the "check before you build" rule
- The cut sheet lookup involves web requests — handle timeouts, rate limiting, and failures gracefully
- Don't block the wizard on cut sheet fetching — let it run in background
- Near-duplicate detection should be instant (client-side)
- Cut sheet PDFs can be large — use streaming uploads to Supabase storage
- Respect manufacturer website terms of service — don't scrape, use public product pages
