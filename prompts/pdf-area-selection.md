# PDF Area Selection for Re-Scanning

> Drop this into a fresh Claude Code session on the door-hardware-tracker repo.

## What You're Building

A feature that lets users select a rectangular region of a PDF page in the import wizard and send JUST that region to the extraction pipeline (pdfplumber or Anthropic API) for targeted re-scanning. This solves the problem where pdfplumber misreads a table or misses items — the user can visually select the area and say "re-scan this."

## Why It Matters

Currently when extraction gets a hardware set wrong, the only options are:
1. Re-run the entire extraction (slow, may break things that were correct)
2. Manually edit every field (tedious)
3. Use Punchy deep-extract (LLM-based, expensive, sometimes hallucinates)

PDF area selection gives a middle ground: targeted pdfplumber re-extraction of a specific region, which is fast, deterministic, and free.

## Architecture

### Frontend Flow
1. User is in StepReview or PunchyReview and sees incorrect data for a hardware set
2. User clicks "Re-scan from PDF" button on the set header (next to "View PDF page")
3. A modal opens showing the PDF page with a draggable selection rectangle
4. User draws a rectangle around the table they want re-scanned
5. User clicks "Extract" — the coordinates + page number are sent to the API
6. API response replaces the items for that hardware set

### Key Components

**PDF Region Selector Component** (`src/components/ImportWizard/PDFRegionSelector.tsx`):
- Renders a PDF page using `pdfjs-dist` (already used by `PDFPagePreview.tsx`)
- Overlays a draggable/resizable rectangle (CSS `position: absolute` with mouse handlers)
- Returns normalized coordinates: `{ page: number, x0: number, y0: number, x1: number, y1: number }` as percentages (0-1) of page dimensions
- The existing `PDFPagePreview.tsx` at `src/components/ImportWizard/PDFPagePreview.tsx` already renders PDF pages — extend or compose with it

**API Endpoint** (`src/app/api/parse-pdf/region-extract/route.ts`):
- Receives: `{ projectId, page, bbox: {x0,y0,x1,y1}, setId }`
- Fetches the PDF from Supabase storage (pattern from `src/app/api/projects/[projectId]/pdf-url/route.ts`)
- Sends to Python endpoint with bbox parameter
- Returns extracted items

**Python Endpoint Update** (`api/extract-tables.py`):
- Add a `bbox` parameter to the extraction handler
- When bbox is provided, use `pdfplumber`'s `page.crop(bbox)` to extract only that region
- pdfplumber bbox format: `(x0, top, x1, bottom)` in PDF points (72 per inch)
- Convert from percentage coordinates to PDF points using page dimensions
- Run the same item extraction logic on the cropped region

### Integration Points

**StepReview.tsx** (`src/components/ImportWizard/StepReview.tsx`):
- Add a "Re-scan region" button next to each set's "View PDF page" link
- Button opens the PDFRegionSelector modal
- On extract completion, update the set's items in local state (same pattern as the existing Punchy revert — `setHardwareSets` is already available as local state)

**PunchyReview.tsx** (`src/components/ImportWizard/PunchyReview.tsx`):
- Similar integration for sets that Punchy flags as problematic

### Existing Code to Study

1. `src/components/ImportWizard/PDFPagePreview.tsx` — already renders PDF pages with pdfjs, handles loading/error states. The region selector should compose with this.
2. `src/app/api/projects/[projectId]/pdf-url/route.ts` — fetches PDF from Supabase storage, generates signed URL. Use the same pattern to get the PDF buffer server-side.
3. `src/components/ImportWizard/StepTriage.tsx` lines 340-395 — deep extract flow. Similar pattern: send request, get items back, merge into hardwareSets state.
4. `api/extract-tables.py` function `extract_hardware_sets_from_page()` (line ~2300) — extracts items from a single page. This is what you'd call on the cropped page.

### Coordinate System

pdfplumber uses PDF coordinate system (origin at bottom-left, Y increases upward). The browser canvas uses screen coordinates (origin at top-left, Y increases downward). You need to convert:

```python
# In Python, convert percentage bbox to PDF points:
pdf_page = pdf.pages[page_num]
width = float(pdf_page.width)
height = float(pdf_page.height)
bbox = (x0_pct * width, y0_pct * height, x1_pct * width, y1_pct * height)
cropped = pdf_page.crop(bbox)
```

Note: pdfplumber's crop uses `(x0, top, x1, bottom)` where top/bottom are measured from the TOP of the page (unlike raw PDF coordinates). So the browser's percentage coordinates map directly.

### UI Design

- Selection rectangle: cyan border (`var(--cyan)`), semi-transparent fill (`var(--cyan-dim)`)
- Drag handles at corners for resizing
- "Extract from selection" button below the PDF preview
- Loading state while extraction runs
- Success: items replace in the set with `qty_source: 'region_extract'`
- Error: toast message

### Testing

- Test with the Radius DC PDF (grid-RR.pdf) — select the DH3 item table and verify items match expected
- Test coordinate conversion: draw a rectangle, verify the Python crop matches the visual selection
- Test edge cases: selection too small, selection outside page bounds, empty selection result

## Constraints

- Read CLAUDE.md for Turbopack TypeScript rules (use `?.`, `??`, never rely on `&&` for narrowing)
- One feature at a time — get the basic selection + extraction working before adding polish
- Don't modify the existing extraction pipeline — add a new endpoint
- Keep the PDF region selector as a reusable component (it will be useful for other features)
