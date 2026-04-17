# Pair-handling surface map — 2026-04-17

Status: **proposal / snapshot** (no code change).
Scope: everywhere pair-ness is computed, carried, or consumed.

## 1. What "pair-ness" is today

There are **four** representations of pair-ness in the system, and they do not
always agree:

| Representation                         | Location                                  | Kind           | Trust level                |
|----------------------------------------|-------------------------------------------|----------------|----------------------------|
| `HardwareSetDef.heading_leaf_count`    | Python extractor (extract-tables.py:105)  | integer        | Authoritative when > 0     |
| `HardwareSetDef.heading_door_count`    | Python extractor (extract-tables.py:104)  | integer        | Authoritative when > 0     |
| `DoorEntry.leaf_count` (TS)            | types/index.ts:31, classify-leaf-items    | 1 \| 2         | Derived, cached after save |
| `VisionHardwareSet.is_pair`            | parse-pdf-helpers.ts:807 (strategy B)     | boolean        | LLM-supplied, second opinion|
| Opening `leaf_count` column            | openings / staging_openings (mig 012)     | integer NOT NULL DEFAULT 1 | THE durable signal         |
| `ReconciledHardwareSet.is_pair`        | reconciliation.ts:429                     | FieldReconciliation | Only used in A-vs-B diff UI |

`detectIsPair(hwSet, doorInfo)` is the **function** that collapses the first
three signals (heading_leaf_count, parseOpeningSize, keyword scan) into a
boolean. It runs in 3 places per save, and is NOT persisted in any durable
form — only its flattened outcome lands in `openings.leaf_count`.

## 2. Current-state table

Columns: Layer | File | Function / Field | Input | Output | Pair-relevant? | Called from

| Layer   | File                                                                 | Function / Field                              | Input                                | Output                           | Pair? | Called from |
|---------|----------------------------------------------------------------------|-----------------------------------------------|--------------------------------------|----------------------------------|-------|-------------|
| Python  | api/extract-tables.py:100-106                                        | `HardwareSetDef.heading_door_count / heading_leaf_count` | PDF heading block parse            | ints on each set                 | ✅ primary | `_extract_hardware_sets`, `count_heading_doors` |
| Python  | api/extract-tables.py:2106-2123                                      | `count_heading_doors(page_text)`              | page text                            | `(openings, leaves)`             | ✅ | sub-heading detector, main heading detector |
| Python  | api/extract-tables.py:2876-2889                                      | `_count_specworks_doors(section_text)`        | SpecWorks-format section             | `(openings, leaves)` via PR/PRA/PRI keyword | ✅ | specworks heading pass |
| Python  | api/extract-tables.py:2182-2213                                      | `parse_heading_door_metadata(after_door)`     | trailing text after `#door_num`      | `(location, hand)`               | 🟡 not pair itself, but the LINE it parses also carries the "Pair"/"Single" token | `_extract_heading_doors_on_page`, rescan-time `detect_region_field` |
| Python  | api/extract-tables.py:2251-2268                                      | `extract_doors_from_set_headings(pdf)`        | pdf                                  | `list[DoorEntry]`                | ✅ indirectly (heading_doors only) | chunk extractor (legacy wrapper around `build_heading_page_map`) |
| Python  | api/extract-tables.py:2442-2563                                      | `join_opening_list_with_heading_pages`        | OL doors + heading doors             | stats dict, mutates OL doors    | ⚠️ does NOT propagate leaf_count — only location / hand / fire_rating / hw_set | main extractor, chunk extractor |
| Python  | api/extract-tables.py:2566-2577                                      | `merge_heading_doors_into_openings`           | same inputs                          | `(added, enriched)` tuple       | ⚠️ legacy wrapper, used only by older unit tests | `tests/test_extract_tables.py` |
| Python  | api/extract-tables.py:4250-4274                                      | `_leaf_count_from_openings(...)`              | set_id, openings, door_count         | leaf_count OR door_count fallback | ✅ | `normalize_quantities` |
| Python  | api/extract-tables.py:3553-3554, 3586-3598                           | merge of duplicate set_id entries             | accumulating HardwareSetDef          | mutates heading_door_count / heading_leaf_count | ✅ | `_extract_hardware_sets` finalisation |
| TS      | src/lib/parse-pdf-helpers.ts:2459                                    | `_PAIR_MIN_WIDTH_IN = 48`                     | —                                    | literal                          | ✅ | `detectIsPair` secondary rule |
| TS      | src/lib/parse-pdf-helpers.ts:2469-2560                               | `parseOpeningSize(text)`                      | "3070" / "6'0\" x 7'0\"" / etc       | `{widthIn, heightIn} \| null`    | ✅ (width ≥ 48" → pair) | `detectIsPair` |
| TS      | src/lib/parse-pdf-helpers.ts:2582-2619                               | `detectIsPair(hwSet, doorInfo)`               | HardwareSet + {door_type, location} | boolean                          | ✅ **THE detector** | save/route.ts, jobs/[id]/run/route.ts (called twice each) |
| TS      | src/lib/parse-pdf-helpers.ts:2631-2644                               | `buildDoorToSetMap(hardwareSets)`             | HardwareSet[]                        | `Map<doorKey, HardwareSet>`     | 🟡 used to resolve the set that feeds detectIsPair | save, apply-revision, jobs/[id]/run, StepConfirm |
| TS      | src/lib/parse-pdf-helpers.ts:2654-2665                               | `buildSetLookupMap(hardwareSets)`             | HardwareSet[]                        | `Map<set_id\|generic_set_id, HardwareSet>` | 🟡 same | save, apply-revision, jobs/[id]/run, StepConfirm |
| TS      | src/lib/parse-pdf-helpers.ts:2680-2691                               | `wouldProduceZeroItems(door, setMap, doorToSetMap)` | door + maps                        | boolean                          | ❌ not pair-specific, but MUST stay in lockstep with buildPerOpeningItems' resolution (which uses detectIsPair inside) | save/route.ts, StepConfirm |
| TS      | src/lib/parse-pdf-helpers.ts:2703-2859                               | `buildPerOpeningItems(openings, doorInfoMap, setMap, doorToSetMap, fkColumn, extraFields?)` | resolved openings + lookup maps | array of `hardware_items` rows (Door/Frame + set items + per-leaf hinge split) | ✅ **calls `detectIsPair` — second call on save path** | save/route.ts, apply-revision/route.ts, jobs/[id]/run/route.ts |
| TS      | src/lib/parse-pdf-helpers.ts:193-217                                 | `computeLeafSide(itemName, leafCount, model?)`| item name, leafCount, model         | `'active'\|'inactive'\|'shared'\|'both'\|null` | ✅ | `buildPerOpeningItems` (save), `groupItemsByLeaf` (preview) indirectly via scope |
| TS      | src/lib/parse-pdf-helpers.ts:114-158                                 | `classifyItemScope(name, model?)`             | item name + model                    | `'per_leaf'\|'per_opening'\|'per_pair'\|'per_frame'\|null` | 🟡 indirect | `computeLeafSide`, `normalizeQuantities`, `groupItemsByLeaf` |
| TS      | src/lib/hardware-taxonomy.ts:scanElectricHinges                      | `scanElectricHinges(items, isPair)`           | item list + isPair                   | `{ totalElectricQty, ... }`     | ✅ | `normalizeQuantities`, `buildPerOpeningItems`, `groupItemsByLeaf` |
| TS      | src/lib/parse-pdf-helpers.ts:1661-2038                               | `normalizeQuantities(hardwareSets, doors)`    | mutates both                         | —                                | ✅ uses `heading_leaf_count`, `heading_door_count`, AND `door.leaf_count` (line 1672) | chunk/route.ts, parse-pdf/route.ts, apply-revision/route.ts (NOT save/route.ts) |
| TS      | src/lib/parse-pdf-helpers.ts:412-505                                 | `selectRepresentativeSample`                  | doors, sets, maxSample              | doors[]                          | ✅ prioritises `leaf_count > 1` | Darrin CP2 / CP3 |
| TS      | src/lib/parse-pdf-helpers.ts:780-823                                 | `VisionHardwareSet.is_pair`                   | LLM vision output                    | boolean                          | ✅ strategy-B signal | `callVisionExtraction`, `reconcileExtractionResults` |
| TS      | src/lib/reconciliation.ts:429-436, 495-499, 523                      | `reconcileField('is_pair', …)`                | A's heading_leaf_count + B's is_pair | FieldReconciliation              | ✅ | `reconcileExtractionResults` |
| TS      | src/lib/classify-leaf-items.ts:121-212                               | `groupItemsByLeaf(items, leafCount)`          | items + leafCount                    | `{shared, leaf1, leaf2}`         | ✅ **third** pair-routing call-site (wizard preview) | `SetPanel.tsx`, door detail page, tests |
| TS      | src/components/ImportWizard/review/SetPanel.tsx:52                   | render                                        | hardware_items rows                  | UI                               | ✅ uses opening's `leaf_count` to call groupItemsByLeaf | wizard review panel |
| TS      | src/components/ImportWizard/StepConfirm.tsx:103                      | pre-flight                                    | doors, maps                          | UI warning list                  | ❌ not pair directly, but uses `wouldProduceZeroItems` which relies on detectIsPair's resolution | wizard confirm step |
| Save    | src/app/api/parse-pdf/save/route.ts:161                              | `const isPair = detectIsPair(hwSet, doorInfo)` (call 1 of 2) | set + doorInfo          | boolean → `leaf_count` on StagingOpening | ✅ | maps directly to staging_openings.leaf_count |
| Save    | src/app/api/parse-pdf/save/route.ts:193-200 → parse-pdf-helpers.ts:2734 | `buildPerOpeningItems` (call 2 of 2)      | same inputs                          | hardware_items rows              | ✅ computes isPair AGAIN internally — if call 1 and call 2 disagree, the opening and its items diverge | |
| Background job | src/app/api/jobs/[id]/run/route.ts:1140                        | `detectIsPair` (call 1 of 2)                  | set + doorInfo                       | adds to `triage.pair_doors_detected` JSON | ✅ | stored on extraction_jobs, informational |
| Background job | src/app/api/jobs/[id]/run/route.ts:1241, 1277                  | `detectIsPair` + `buildPerOpeningItems`       | same                                 | staging_openings.leaf_count + items | ✅ duplicates save/route.ts exactly | |
| Revision | src/app/api/parse-pdf/apply-revision/route.ts:210, 277              | `buildPerOpeningItems`                        | openings + maps                     | new hardware_items               | ✅ recomputes isPair internally | |
| Revision | src/app/api/parse-pdf/apply-revision/route.ts:240-251               | `openingRows` INSERT for new doors            | DoorEntry                            | `openings` row                   | ⚠️ **BUG: `leaf_count` is NOT written for new doors added via revision** — they default to 1 even when `detectIsPair` would return true. `buildPerOpeningItems` then generates "Door (Active Leaf)"/"Door (Inactive Leaf)" rows because it recomputes isPair, but the opening itself says leaf_count=1. | |
| DB      | supabase/migrations/012_pair_leaf_support.sql                        | `openings.leaf_count INTEGER NOT NULL DEFAULT 1` | —                                | column                           | ✅ **THE durable signal** | all read paths |
| DB      | supabase/migrations/012_pair_leaf_support.sql                        | `staging_openings.leaf_count INTEGER NOT NULL DEFAULT 1` | —                             | column                           | ✅ propagated via merge_extraction RPCs | |
| DB      | supabase/migrations/013_hardware_leaf_side.sql                       | `hardware_items.leaf_side text NULL`          | —                                    | `'active'\|'inactive'\|'shared'\|'both'\|NULL` | ✅ carries per-item attribution | buildPerOpeningItems writer; groupItemsByLeaf reader |
| DB      | supabase/migrations/021,025,034,037                                  | `merge_extraction(...)` RPC UPDATE/INSERT     | staging rows                         | writes `leaf_count` to openings  | ✅ | promoteExtraction |
| DB      | supabase/migrations/021,023                                          | `write_staging_data(...)` RPC                 | JSON                                 | reads `opening->>'leaf_count'`  | ✅ | writeStagingData |
| DB      | —                                                                    | `heading_leaf_count / heading_door_count`     | —                                    | **NOT PERSISTED**                | ⚠️ these die at the wire-protocol boundary; reconstructed each extraction run |

### Duplicated / near-duplicated logic — flagged

1. **`detectIsPair` called twice on the save path** — once for
   `stagingOpenings.leaf_count` (save/route.ts:161) and again inside
   `buildPerOpeningItems` (parse-pdf-helpers.ts:2734). Same function, same
   inputs; nothing stops them from diverging if a caller mutates `hwSet`
   between calls. This is the single highest-risk duplication.

2. **`detectIsPair` + `buildPerOpeningItems` duplicated in jobs/[id]/run/route.ts**
   lines 1241 and 1277 — verbatim copy of save/route.ts lines 161 and 193,
   with its own `setMap` / `doorToSetMap` construction (1197-1205). Four
   independent lookup-map instantiations exist for the same data shape
   (save/route, jobs/[id]/run twice, apply-revision).

3. **Pair detection in Python lives in three code paths** —
   `count_heading_doors` (page-level), `_count_specworks_doors` (specworks
   section-level), and the merge step in `_extract_hardware_sets` that
   aggregates when the same set_id appears on multiple pages. Each has its
   own rule for counting leaves; they only converge on the final
   `heading_leaf_count`.

4. **Leaf-grouping logic duplicated between save and preview** —
   `buildPerOpeningItems` (save) and `groupItemsByLeaf` (preview) both know:
   - that electric hinges route to the active leaf on pairs,
   - that standard hinges split asymmetrically when electric hinges are present,
   - that `per_pair`/`per_frame` items go to `shared`.
   The save path stamps `leaf_side`; the preview falls back to re-computing
   it. The JSDoc on both explicitly tells the reader "these two must match."
   That comment is the marker of a pending divergence.

5. **`_leaf_count_from_openings` (Python) and `leavesPerSet`
   (parse-pdf-helpers.ts:1672)** — both reconstruct the heading_leaf_count
   from the opening list when the heading parse failed. Different languages,
   same rule, no shared test.

6. **`is_pair` on `VisionHardwareSet` (strategy B)** is plumbed through
   reconciliation.ts but the reconciled result is never read by
   detectIsPair or buildPerOpeningItems. It only surfaces in the A-vs-B
   diff UI. A field that only informs a diagnostic UI but costs a JSON
   round-trip + reconciliation logic.

7. **`parse_heading_door_metadata` (Python)** and `parseOpeningSize` (TS)
   both parse size-like tokens from heading lines, but for different
   downstream purposes (location/hand vs pair detection). They share no
   regex and no test fixture, so a PDF that breaks one can pass the other.

## 3. Read paths — where pair-ness is consumed after save

| Reader                                   | Source of truth it trusts        | Notes |
|------------------------------------------|----------------------------------|-------|
| `SetPanel.tsx` (wizard review)           | `leaf_count` on opening          | calls `groupItemsByLeaf(items, leaf_count)` |
| `door/[doorId]/page.tsx` (detail)        | `leaf_count` on opening          | uses `classifyItemScope` for per-item taxonomy |
| `groupItemsByLeaf`                       | (a) persisted `leaf_side`, (b) fallback to scope | wizard preview rows have NULL leaf_side → fallback path |
| `normalizeQuantities` (chunk, apply-rev) | `heading_leaf_count`, `heading_door_count`, THEN `door.leaf_count` fallback | runs **before** save, so it never sees the DB value |
| `callDarrinPostExtraction` (CP2)         | `heading_leaf_count / heading_door_count` on set (parse-pdf-helpers.ts:528-529) | only sees the Python values |
| `callDarrinQuantityCheck` (CP3)          | `heading_leaf_count / heading_door_count` on set, `leaf_count` on door (parse-pdf-helpers.ts:681, 688) | both signals |
| `selectRepresentativeSample`             | `door.leaf_count`                | used for Darrin sampling |
| Activity log / triage payload            | `detectIsPair` (runtime)         | job orchestrator stores a JSON list of pair doors |
| Wizard UI (Leaf 1 / Leaf 2 tabs)         | `leaf_count` on opening          | sole render-time signal post-save |

**Key observation:** no reader uses `heading_leaf_count` after promote. It's
a build-time signal that dies at the extraction run boundary. Only
`openings.leaf_count` survives, and that value is derived from
`detectIsPair` which itself uses `heading_leaf_count` + parseOpeningSize +
keyword scan. The persistence layer has thrown away the provenance.

## 4. The 2026-04-17 regression in this map

Radius DC DH4A.0 has `heading_leaf_count=12, heading_door_count=6`
(6 pair doors). The Python side got this right. The TS side:
- `detectIsPair` → true (primary rule fires) ✅
- `stagingOpenings.leaf_count` → 2 ✅
- `buildPerOpeningItems` → emits "Door (Active Leaf)" + "Door (Inactive Leaf)" ✅

The regression window opened when a change to `detectIsPair` briefly
returned `false` for DH4A (because the heading string was
`"Heading #DH4A.1"` — no "pair" keyword, the door_type was a single
letter "A", and the secondary size-parse fallback was not yet present).
`leaf_count` stamped as 1 for DH4A doors; `buildPerOpeningItems` routed
them as singles; every downstream consumer (`groupItemsByLeaf`, SetPanel,
detail page) rendered singles. The fix added the primary
`heading_leaf_count > heading_door_count` rule and the secondary
`parseOpeningSize` rule, but did not change the number of layers.

The structural problem: there are six independent things that could go
wrong in future (Python heading parser, the three tiers of `detectIsPair`,
the two separate call sites of `detectIsPair` on the save path, the
buildPerOpeningItems recomputation, the apply-revision missing-write bug,
and the preview re-derivation in `groupItemsByLeaf`). A single PDF shape
change can break any of them silently.
