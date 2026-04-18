/**
 * Hardware Item Taxonomy
 *
 * Defines expected categories of hardware items per opening. Used by:
 * 1. Pdfplumber (extract-tables.py) — validates extracted items are real hardware
 * 2. LLM review pass — knows what to look for and flag as missing
 * 3. Frontend — could power category-based grouping/display
 *
 * Built from analysis of RadiusDC submittal (306169) + DHI industry standards.
 * Categories are intentionally broad — the name_patterns catch variations.
 */

/**
 * Install scope determines how quantities scale with door configuration:
 * - "per_leaf": qty applies to each door leaf (hinges, closers, protection plates)
 * - "per_opening": qty is per opening regardless of single/pair (lockset, threshold)
 * - "per_pair": qty applies only to pair openings (coordinator, flush bolt, astragal)
 * - "per_frame": qty is per frame (seals, weatherstripping, silencers)
 */
export type InstallScope = 'per_leaf' | 'per_opening' | 'per_pair' | 'per_frame'

export interface HardwareCategory {
  /** Unique category ID */
  id: string
  /** Human-readable display name */
  label: string
  /** Regex patterns that match item names in this category (case-insensitive) */
  name_patterns: string[]
  /** Is this item expected on virtually every opening? */
  universal: boolean
  /** Expected on exterior openings? */
  exterior: boolean
  /** Expected on interior openings? */
  interior: boolean
  /** Expected on fire-rated openings? */
  fire_rated: boolean
  /** Expected only on pairs (double doors)? */
  pairs_only: boolean
  /** How quantities scale with door configuration */
  install_scope: InstallScope
  /** Typical per-opening qty range [min, max] for single doors */
  typical_qty_single: [number, number]
  /** Typical per-opening qty range [min, max] for pairs */
  typical_qty_pair: [number, number]
}

export const HARDWARE_TAXONOMY: HardwareCategory[] = [
  // === HANGING ===
  // ORDERING: specific hinge types MUST come before the generic 'hinges' catch-all.
  // classifyItem() returns the first match, so 'continuous_hinge' must match before 'hinges'.
  {
    id: 'electric_hinge',
    label: 'Electric / Conductor Hinge',
    name_patterns: [
      'hinge.*\\bCON\\b',
      'hinge.*\\bTW\\d',
      'hinge.*electr',
      'hinge.*conduct',
      'electr.*hinge',
      'conductor.*hinge',
      'power\\s*transfer\\s*hinge',
      // Standalone pattern: matches "CON TW8" in model field when name is
      // generic "Hinges". Real PDF data splits: name="Hinges", model="5BB1 HW
      // 4 1/2 x 4 1/2 CON TW8". classifyItem() concatenates name+model, so
      // this pattern catches the model-only identifier without requiring
      // "hinge" adjacent to "CON TW".
      '\\bCON\\s*TW\\d',
    ],
    universal: false,
    exterior: true,
    interior: false,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_opening',  // 1 per opening, replaces one NRP position
    typical_qty_single: [1, 1],
    typical_qty_pair: [1, 1],
  },
  {
    id: 'continuous_hinge',
    label: 'Continuous / Geared Hinge',
    name_patterns: [
      'continuous.*hinge',
      'geared.*hinge',
      'pin.*barrel',
      'full.*length.*hinge',
    ],
    universal: false,
    exterior: true,
    interior: true,
    fire_rated: true,
    pairs_only: false,
    install_scope: 'per_leaf',
    typical_qty_single: [1, 1],
    typical_qty_pair: [2, 2],
  },
  {
    id: 'pivot_hinge',
    label: 'Pivot Hinge',
    name_patterns: [
      'pivot',
      'offset.*pivot',
      'intermediate.*pivot',
      'center.*pivot',
      'floor.*pivot',
    ],
    universal: false,
    exterior: true,
    interior: true,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_opening',
    typical_qty_single: [1, 2],
    typical_qty_pair: [2, 4],
  },
  {
    id: 'spring_hinge',
    label: 'Spring Hinge',
    name_patterns: [
      'spring.*hinge',
      'self.*clos.*hinge',
    ],
    universal: false,
    exterior: true,
    interior: true,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_leaf',
    typical_qty_single: [2, 3],
    typical_qty_pair: [4, 6],
  },
  {
    id: 'hinges',
    label: 'Hinges (Butt)',
    name_patterns: [
      'butt\\s*hinge',
      '\\b5BB',
      '\\bBB1\\b',
      'hinge',
    ],
    universal: true,
    exterior: true,
    interior: true,
    fire_rated: true,
    pairs_only: false,
    install_scope: 'per_leaf',
    typical_qty_single: [3, 5],
    typical_qty_pair: [6, 10],
  },

  // === LOCKING / LATCHING ===
  {
    id: 'lockset',
    label: 'Lockset / Latchset',
    name_patterns: [
      'lockset',
      'latchset',
      'latch\\s*set',
      'lock\\s*set',
      'passage\\s*set',
      'privacy\\s*set',
      'storeroom\\s*lock',
      'classroom\\s*lock',
      'entrance\\s*lock',
      'office\\s*lock',
      'mortise.*lock',
      'cylindrical.*lock',
      'tubular.*lock',
      'deadbolt',
      'dead\\s*bolt',
      'night\\s*latch',
    ],
    universal: false,  // some openings use exit devices instead
    exterior: false,
    interior: true,
    fire_rated: true,
    pairs_only: false,
    install_scope: 'per_leaf',
    typical_qty_single: [1, 1],
    typical_qty_pair: [1, 2],
  },
  {
    id: 'exit_device',
    label: 'Exit Device',
    name_patterns: [
      'exit\\s*device',
      'panic',
      'rim\\s*device',
      'mortise\\s*device',
      'concealed\\s*vertical\\s*rod',
      'cvr',
      'surface\\s*vertical\\s*rod',
      'svr',
      'crossbar',
      'touch\\s*bar',
      'push\\s*bar',
    ],
    universal: false,
    exterior: true,
    interior: false,  // some interior egress doors have them
    fire_rated: true,
    pairs_only: false,
    install_scope: 'per_leaf',
    typical_qty_single: [1, 1],
    typical_qty_pair: [2, 2],
  },
  {
    id: 'flush_bolt',
    label: 'Flush Bolt / Flush Bolt Kit',
    name_patterns: [
      'flush\\s*bolt',
      'constant\\s*latching',
      'fb\\d',
      'surface\\s*bolt',
    ],
    universal: false,
    exterior: true,
    interior: false,
    fire_rated: true,
    pairs_only: true,
    install_scope: 'per_pair',
    typical_qty_single: [0, 0],
    typical_qty_pair: [1, 2],
  },
  {
    id: 'dust_proof_strike',
    label: 'Dust Proof Strike',
    name_patterns: [
      'dust.*proof.*strike',
      '\\bDPS\\b',
    ],
    universal: false,
    exterior: true,
    interior: false,
    fire_rated: false,
    pairs_only: true,
    install_scope: 'per_pair',
    typical_qty_single: [0, 0],
    typical_qty_pair: [1, 1],
  },
  {
    id: 'strike',
    label: 'Strike',
    name_patterns: [
      'strike(?!.*plate)',  // "strike" but not "strike plate" (that's protection)
      'electric\\s*strike',
      'power\\s*strike',
    ],
    universal: false,
    exterior: false,
    interior: false,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_opening',
    typical_qty_single: [0, 1],
    typical_qty_pair: [0, 2],
  },

  // === ELECTRONIC / ACCESS CONTROL ===
  {
    id: 'elec_modification',
    label: 'Electronic Modification',
    name_patterns: [
      'elec.*modif',
      'elec.*exit\\s*mod',
      'elec.*lock\\s*mod',
      'electric.*modif',
      'electrif',
      'power\\s*transfer',
      'ept',
    ],
    universal: false,
    exterior: true,
    interior: false,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_leaf',
    typical_qty_single: [1, 1],
    typical_qty_pair: [1, 2],
  },
  {
    id: 'wire_harness',
    label: 'Wire Harness / Connector',
    name_patterns: [
      'wire\\s*harness',
      'connector',
      'molex',
      'con-\\d',
      'wiring',
      'pigtail',
    ],
    universal: false,
    exterior: false,
    interior: false,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_opening',
    typical_qty_single: [1, 2],
    typical_qty_pair: [2, 4],
  },

  // === CLOSING ===
  {
    id: 'auto_operator',
    label: 'Automatic Operator',
    name_patterns: [
      'auto.*operator',
      'automatic\\s*operator',
      'power\\s*operator',
      'ada\\s*operator',
    ],
    universal: false,
    exterior: true,
    interior: false,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_opening',  // 1 per opening, typically replaces closer
    typical_qty_single: [1, 1],
    typical_qty_pair: [1, 2],
  },
  {
    id: 'closer',
    label: 'Closer',
    name_patterns: [
      'closer',
      'door\\s*check',
      'overhead\\s*concealed',
      'floor\\s*closer',
    ],
    universal: true,
    exterior: true,
    interior: true,
    fire_rated: true,
    pairs_only: false,
    install_scope: 'per_opening',
    typical_qty_single: [1, 1],
    typical_qty_pair: [2, 2],
  },
  {
    id: 'coordinator',
    label: 'Coordinator',
    name_patterns: [
      'coordinator',
    ],
    universal: false,
    exterior: false,
    interior: false,
    fire_rated: false,
    pairs_only: true,
    install_scope: 'per_pair',
    typical_qty_single: [0, 0],
    typical_qty_pair: [1, 1],
  },

  // === CYLINDERS & CORES ===
  {
    id: 'cylinder_housing',
    label: 'Cylinder Housing',
    name_patterns: [
      'cylinder\\s*housing',
      'rim\\s*cylinder',
      'mortise\\s*cylinder',
    ],
    universal: false,
    exterior: true,
    interior: false,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_leaf',
    typical_qty_single: [1, 1],
    typical_qty_pair: [1, 2],
  },
  {
    id: 'core',
    label: 'IC Core (Temporary / Permanent)',
    name_patterns: [
      'ic\\s*core',
      'temporary.*core',
      'permanent.*core',
      'construction.*core',
      'interchangeable.*core',
    ],
    universal: false,
    exterior: true,
    interior: true,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_leaf',
    typical_qty_single: [1, 2],
    typical_qty_pair: [1, 2],
  },

  // === PROTECTION ===
  {
    id: 'kick_plate',
    label: 'Kickplate / Protection Plate',
    name_patterns: [
      'kick\\s*plate',
      'protection\\s*plate',
      'mop\\s*plate',
      'armor\\s*plate',
      'stretch\\s*plate',
    ],
    universal: false,
    exterior: true,
    interior: false,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_leaf',
    typical_qty_single: [1, 1],
    typical_qty_pair: [2, 2],
  },
  {
    id: 'stop',
    label: 'Stop',
    name_patterns: [
      'wall\\s*stop',
      'floor\\s*stop',
      'overhead\\s*stop',
      'door\\s*stop',
      'holder',
      'hold\\s*open',
      'magnetic\\s*hold',
    ],
    universal: false,
    exterior: false,
    interior: true,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_opening',
    typical_qty_single: [1, 1],
    typical_qty_pair: [2, 2],
  },

  // === SWEEPS / BOTTOMS ===
  {
    id: 'door_sweep',
    label: 'Door Sweep / Auto Door Bottom',
    name_patterns: [
      'door\\s*sweep',
      'auto.*door\\s*bottom',
      'automatic.*bottom',
      'drop\\s*seal',
      'door\\s*bottom',
    ],
    universal: false,
    exterior: true,
    interior: false,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_leaf',
    typical_qty_single: [1, 1],
    typical_qty_pair: [2, 2],
  },

  // === THRESHOLD ===
  {
    id: 'threshold',
    label: 'Threshold',
    name_patterns: [
      'threshold',
      'saddle',
    ],
    universal: false,
    exterior: true,
    interior: false,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_frame',
    typical_qty_single: [1, 1],
    typical_qty_pair: [1, 1],
  },

  // === SEALING / GASKETING ===
  {
    id: 'gasket',
    label: 'Gasket',
    name_patterns: [
      'gasket(?!ing)',
      'perimeter\\s*seal',
    ],
    universal: false,
    exterior: true,
    interior: false,
    fire_rated: true,
    pairs_only: false,
    install_scope: 'per_frame',
    typical_qty_single: [1, 1],
    typical_qty_pair: [1, 2],
  },
  {
    id: 'smoke_seal',
    label: 'Smoke Seal',
    name_patterns: [
      'smoke\\s*seal',
      'smoke\\s*gask',
    ],
    universal: false,
    exterior: false,
    interior: false,
    fire_rated: true,
    pairs_only: false,
    install_scope: 'per_frame',
    typical_qty_single: [1, 1],
    typical_qty_pair: [2, 2],
  },
  {
    id: 'gasketing',
    label: 'Gasketing',
    name_patterns: [
      'gasketing',
    ],
    universal: false,
    exterior: true,
    interior: false,
    fire_rated: true,
    pairs_only: false,
    install_scope: 'per_frame',
    typical_qty_single: [1, 1],
    typical_qty_pair: [2, 2],
  },
  {
    id: 'acoustic_seal',
    label: 'Acoustic Seal',
    name_patterns: [
      'acoustic\\s*seal',
      'sound\\s*seal',
      'sound\\s*strip',
    ],
    universal: false,
    exterior: false,
    interior: false,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_frame',
    typical_qty_single: [1, 2],
    typical_qty_pair: [2, 4],
  },
  {
    id: 'weatherstrip',
    label: 'Weatherstrip',
    name_patterns: [
      'weatherstrip',
      'weather\\s*strip',
      'weather.*seal',
    ],
    universal: false,
    exterior: true,
    interior: false,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_frame',
    typical_qty_single: [1, 1],
    typical_qty_pair: [2, 2],
  },

  // === RAIN DRIP / ASTRAGAL ===
  {
    id: 'rain_drip',
    label: 'Rain Drip',
    name_patterns: [
      'rain\\s*drip',
      'drip\\s*cap',
      'drip\\s*edge',
    ],
    universal: false,
    exterior: true,
    interior: false,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_frame',
    typical_qty_single: [1, 1],
    typical_qty_pair: [2, 2],
  },
  {
    id: 'astragal',
    label: 'Astragal',
    name_patterns: [
      'astragal',
      'meeting\\s*stile',
    ],
    universal: false,
    exterior: true,
    interior: false,
    fire_rated: false,
    pairs_only: true,
    install_scope: 'per_pair',
    typical_qty_single: [0, 0],
    typical_qty_pair: [1, 1],
  },
  {
    id: 'mullion',
    label: 'Mullion',
    name_patterns: [
      'mullion',
      'removable\\s*mullion',
    ],
    universal: false,
    exterior: false,
    interior: false,
    fire_rated: false,
    pairs_only: true,
    install_scope: 'per_pair',
    typical_qty_single: [0, 0],
    typical_qty_pair: [1, 1],
  },

  // === SILENCERS ===
  {
    id: 'silencer',
    label: 'Silencer',
    name_patterns: [
      'silencer',
      'bumper',
      'mute',
    ],
    universal: false,
    exterior: false,
    interior: true,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_frame',
    typical_qty_single: [1, 3],
    typical_qty_pair: [1, 3],
  },

  // === SIGNAGE / VIEWERS ===
  {
    id: 'signage',
    label: 'Signage',
    name_patterns: [
      'sign(?!al)',
      'room\\s*number',
      'signage',
      'placard',
    ],
    universal: false,
    exterior: false,
    interior: true,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_opening',
    typical_qty_single: [1, 1],
    typical_qty_pair: [1, 1],
  },
  {
    id: 'viewer',
    label: 'Door Viewer',
    name_patterns: [
      'viewer',
      'peephole',
      'door\\s*viewer',
    ],
    universal: false,
    exterior: true,
    interior: false,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_leaf',
    typical_qty_single: [1, 1],
    typical_qty_pair: [1, 2],
  },

  // === BY OTHERS ===
  {
    id: 'by_others',
    label: 'Hardware by Others',
    name_patterns: [
      'by\\s*others',
      'hardware\\s*by\\s*others',
      'not\\s*in\\s*contract',
      'nic',
      'by\\s*owner',
      'owner\\s*furnished',
    ],
    universal: false,
    exterior: false,
    interior: false,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_opening',
    typical_qty_single: [0, 5],
    typical_qty_pair: [0, 5],
  },
]

/**
 * Manufacturer-to-category fallback map.
 * When an item name doesn't match any taxonomy pattern but we know the
 * manufacturer, use this to infer the category. Only includes manufacturers
 * predominantly associated with ONE category.
 */
export const MANUFACTURER_CATEGORY_MAP: Record<string, string> = {
  'von duprin': 'exit_device',
  'precision': 'exit_device',
  'sargent 80': 'exit_device',
  'sargent 90': 'exit_device',
  'lcn': 'closer',
  'norton': 'closer',
  'dormakaba': 'closer',
  'schlage nd': 'lockset',
  'schlage l': 'mortise_lock',
  'sargent 10': 'lockset',
  'sargent 28': 'lockset',
  'corbin russwin': 'lockset',
  'yale au': 'lockset',
  'hager': 'hinge',
  'mckinney': 'hinge',
  'ives 5bb': 'hinge',
  'markar': 'continuous_hinge',
  'hes': 'electric_strike',
  'rixson': 'pivot',
  'glynn-johnson': 'overhead_stop',
  'rockwood': 'pull',
  'trimco': 'kick_plate',
  'pemko': 'threshold',
  'securitron': 'electromagnetic_lock',
  'zero': 'weatherstripping',
}

// ── Shared compiled regex cache ──────────────────────────────────────────────
// Single source of truth for pre-compiled taxonomy regexes. Imported by
// parse-pdf-helpers.ts (classifyItemScope) and quantity-propagation.ts
// (classifyItemCategory) instead of each building its own cache.

export const TAXONOMY_REGEX_CACHE: Array<{
  id: string
  install_scope: InstallScope
  patterns: RegExp[]
}> = HARDWARE_TAXONOMY.map(cat => ({
  id: cat.id,
  install_scope: cat.install_scope,
  patterns: cat.name_patterns.map(p => new RegExp(p, 'i')),
}))

// ── Shared hinge helpers ─────────────────────────────────────────────────────

/**
 * Pre-scan a set of items for electric hinge quantity on pair doors.
 *
 * Replaces 3 identical pre-scans in normalizeQuantities(),
 * buildPerOpeningItems(), and groupItemsByLeaf().
 */
export function scanElectricHinges(
  items: Array<{ name: string; model?: string | null; qty?: number | null; leaf_side?: string | null }>,
  isPair: boolean,
): { totalElectricQty: number; hasElectricHinge: boolean } {
  if (!isPair) return { totalElectricQty: 0, hasElectricHinge: false }
  let total = 0
  for (const item of items) {
    if (!item.leaf_side && classifyItem(item.name, undefined, item.model ?? undefined) === 'electric_hinge') {
      total += (item.qty || 0)
    }
  }
  return { totalElectricQty: total, hasElectricHinge: total > 0 }
}

/**
 * Detect whether a non-integer standard hinge division is explained by an
 * asymmetric electric hinge split on a pair door.
 *
 * Deduplicates identical checks in PATH 1 and PATH 5 of normalizeQuantities().
 */
export function isAsymmetricHingeSplit(
  standardQty: number,
  electricQty: number,
  divisor: number,
): boolean {
  return electricQty > 0 && Number.isInteger((standardQty + electricQty) / divisor)
}

/**
 * For pair openings, consolidate per-leaf standard-hinge duplicates that
 * Python's extractor emits as separate rows on electrified pair doors.
 *
 * Context (110-01B / DH1 reproducer): the schedule PDF lists per-leaf
 * hinge counts separately — 3 standard on Leaf 1 (reduced because the
 * active leaf carries one electric hinge replacing a standard position)
 * and 4 standard on Leaf 2. Python emits BOTH counts as distinct rows
 * in `hwSet.items` with identical name + model but different qty. The
 * downstream hinge-split branch in `buildPerOpeningItems` expects a
 * single standard-hinge entry per set; two entries cause it to emit 4
 * rows on the opening instead of 2 — producing the qty-3 / qty-4 ghost
 * on both leaves that Matthew observed on 110-01B.
 *
 * Heuristic (conservative — per Matthew's 2026-04-18 decision "B":
 * observability first, data-mutation second):
 *
 *   - Fires ONLY on pair sets with a known electric-hinge qty > 0.
 *   - Groups standard-hinge items (category 'hinges') by name + model.
 *   - Consolidates only groups with EXACTLY two rows where
 *     `|qtyA − qtyB| === electricHingeQty`. Keeps the higher-qty row
 *     (the inactive leaf's full count); the hinge-split branch then
 *     computes `active = raw − electric` correctly.
 *   - Any other duplicate shape (three or more rows, mismatched delta,
 *     or no electric present) is left untouched. The
 *     `pair_leaf_hinge_duplication` invariant surfaces these for human
 *     review rather than mutating the data silently.
 *
 * Returns the possibly-shorter items array plus the drop count so the
 * caller can breadcrumb.
 */
export function consolidatePairLeafHingeRows<
  T extends { name: string; model?: string | null; qty?: number | null },
>(
  items: ReadonlyArray<T>,
  isPair: boolean,
  totalElectricHingeQty: number,
): { items: T[]; consolidated: number } {
  if (!isPair || totalElectricHingeQty <= 0 || items.length < 2) {
    return { items: [...items], consolidated: 0 }
  }

  type Group = { indices: number[]; qtys: number[] }
  const groups = new Map<string, Group>()
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (classifyItem(item.name, undefined, item.model ?? undefined) !== 'hinges') continue
    const key = `${(item.name ?? '').trim().toLowerCase()}::${(item.model ?? '').trim().toLowerCase()}`
    const bucket = groups.get(key) ?? { indices: [], qtys: [] }
    bucket.indices.push(i)
    bucket.qtys.push(item.qty ?? 0)
    groups.set(key, bucket)
  }

  const dropIndices = new Set<number>()
  for (const group of groups.values()) {
    if (group.indices.length !== 2) continue
    const [qA, qB] = group.qtys
    if (Math.abs(qA - qB) !== totalElectricHingeQty) continue
    // Keep the higher-qty row (inactive-leaf count); drop the lower. The
    // hinge-split branch will compute `active = raw − electric` from the
    // kept row, yielding exactly one active + one inactive row.
    const dropIdx = qA < qB ? group.indices[0] : group.indices[1]
    dropIndices.add(dropIdx)
  }

  if (dropIndices.size === 0) return { items: [...items], consolidated: 0 }

  const kept: T[] = []
  for (let i = 0; i < items.length; i++) {
    if (!dropIndices.has(i)) kept.push(items[i])
  }
  return { items: kept, consolidated: dropIndices.size }
}

/**
 * Classify an item name into a category. Returns the category ID or 'unknown'.
 * Optionally accepts a manufacturer for fallback classification when the
 * item name is a model number only (e.g., "Von Duprin 99").
 *
 * The `model` parameter handles real PDF data where extraction splits the
 * data across fields: name="Hinges", model="5BB1 HW 4 1/2 x 4 1/2 CON TW8".
 * When provided, patterns are tested against `name + " " + model` so that
 * identifiers like "CON TW8" in the model field are matched.
 */
export function classifyItem(itemName: string, manufacturer?: string, model?: string): string {
  // Concatenate name + model for pattern matching. Real PDF data often has
  // the category-distinguishing identifier (e.g., "CON TW8") in the model
  // field while name is a generic "Hinges".
  const combined = model
    ? `${(itemName ?? '')} ${model}`.toLowerCase().trim()
    : (itemName ?? '').toLowerCase().trim()
  for (const cat of HARDWARE_TAXONOMY) {
    for (const pattern of cat.name_patterns) {
      if (new RegExp(pattern, 'i').test(combined)) {
        return cat.id
      }
    }
  }

  // Fallback: check manufacturer prefix against known mappings
  if (manufacturer) {
    const mfrLower = (manufacturer ?? '').toLowerCase().trim()
    for (const [prefix, category] of Object.entries(MANUFACTURER_CATEGORY_MAP)) {
      if (mfrLower.startsWith(prefix)) {
        return category
      }
    }
  }

  // Also check if the item name itself starts with a known manufacturer
  for (const [prefix, category] of Object.entries(MANUFACTURER_CATEGORY_MAP)) {
    if (combined.startsWith(prefix)) {
      return category
    }
  }

  return 'unknown'
}

/**
 * Get expected categories for an opening based on its characteristics.
 * Returns category IDs that should be present.
 */
export function getExpectedCategories(opts: {
  isExterior: boolean
  isFireRated: boolean
  isPair: boolean
}): string[] {
  return HARDWARE_TAXONOMY
    .filter(cat => {
      // Universal items are always expected
      if (cat.universal) return true
      // Pairs-only items only on pairs
      if (cat.pairs_only && !opts.isPair) return false
      // Check context flags
      if (opts.isExterior && cat.exterior) return true
      if (!opts.isExterior && cat.interior) return true
      if (opts.isFireRated && cat.fire_rated) return true
      return false
    })
    .map(cat => cat.id)
}

/**
 * Validate a qty against the typical range for a category.
 * Returns null if OK, or a warning string if suspicious.
 */
export function validateQty(
  categoryId: string,
  qty: number,
  isPair: boolean
): string | null {
  const cat = HARDWARE_TAXONOMY.find(c => c.id === categoryId)
  if (!cat) return null

  const [min, max] = isPair ? cat.typical_qty_pair : cat.typical_qty_single
  if (min === 0 && max === 0) return null // no expectation

  if (qty < min) {
    return `${cat.label}: qty ${qty} is below typical minimum of ${min}`
  }
  if (qty > max * 2) {
    // Allow some headroom but flag extreme values (likely total qty, not per-opening)
    return `${cat.label}: qty ${qty} seems high (typical max: ${max}). Might be total qty instead of per-opening?`
  }

  return null
}

/**
 * Pair-door leaf placement by category.
 *
 * Encodes where each hardware category physically installs on a pair door —
 * independent of the taxonomy's `install_scope` (which answers "how does the
 * qty scale?"). Install scope tells us how to divide; this map tells us where
 * the thing ENDS UP.
 *
 * Why this exists (2026-04-18): Radius DC grid-RR Door 110-01B rendered
 * qty=1 items (Cylinder Housing, Temp IC Core, Permanent Core, Wire Harness)
 * on BOTH leaves of a pair. Those items are per_leaf / per_opening by scope,
 * so computeLeafSide() deferred (returned null) and the render fallback
 * routed them to both leaves — visually duplicating the qty.
 *
 * The fix: once we know the category, we also know where it installs. A
 * single cylinder housing for a lockset belongs on the active leaf (where
 * the lockset is). A flush bolt belongs on the inactive leaf. We stop
 * treating "scope" as the answer to a different question.
 *
 * Values:
 *   - 'active'   → installs on the active leaf only (lockset/exit-device
 *                  sided items, wiring that enters through the active leaf,
 *                  auto-operator mounted above the active leaf)
 *   - 'inactive' → installs on the inactive leaf only (flush bolts,
 *                  dust-proof strikes recessed into the inactive leaf)
 *   - 'shared'   → one unit spans the whole opening (thresholds, astragals,
 *                  coordinators, gaskets)
 *   - 'split'    → genuinely per-leaf; emit one row per leaf so each can
 *                  be tracked / completed independently (hinges, closers,
 *                  kick plates)
 *
 * Unknown categories fall back in getPairLeafPlacement() below.
 */
export const PAIR_LEAF_PLACEMENT: Record<string, 'active' | 'inactive' | 'shared' | 'split'> = {
  // --- Active leaf only ---
  // The active leaf carries the operating hardware on a pair door.
  lockset: 'active',
  exit_device: 'active',
  cylinder_housing: 'active',
  core: 'active',
  elec_modification: 'active',
  wire_harness: 'active',
  electric_hinge: 'active',   // DHI standard; also special-cased at save time
  auto_operator: 'active',

  // --- Inactive leaf only ---
  // Bolts and their catches live on the inactive leaf.
  flush_bolt: 'inactive',
  dust_proof_strike: 'inactive',

  // --- Shared (one per opening / frame) ---
  strike: 'shared',
  coordinator: 'shared',
  astragal: 'shared',
  mullion: 'shared',
  threshold: 'shared',
  gasket: 'shared',
  smoke_seal: 'shared',
  gasketing: 'shared',
  acoustic_seal: 'shared',
  weatherstrip: 'shared',
  rain_drip: 'shared',
  silencer: 'shared',
  by_others: 'shared',

  // --- Split across both leaves ---
  // Genuinely per-leaf items; save path emits one row per leaf.
  hinges: 'split',
  continuous_hinge: 'split',
  pivot_hinge: 'split',
  spring_hinge: 'split',
  closer: 'split',
  kick_plate: 'split',
  stop: 'split',
  door_sweep: 'split',
  viewer: 'split',
  signage: 'split',
  // Note: `silencer` is frame-mounted hardware (per_frame scope) and lives
  // in the shared block above — not here — so a typical 3-per-opening
  // silencer qty isn't duplicated to 6 on pair doors.
}

/**
 * Resolve where a hardware category installs on a pair door, with a
 * conservative fallback for unknown categories.
 *
 * Fallback rules (when `category` is 'unknown' or not in the map):
 *   - qty <= 1 → 'shared'  (treat a single item as opening-level; prevents
 *                the pre-fix duplication where qty=1 items rendered on both
 *                leaves, visually doubling the count)
 *   - qty >  1 → 'split'   (preserve prior behavior — likely per-leaf item)
 *
 * Single-door callers should not need this — a single door has no pair
 * placement decision to make. Guarded by callers via `isPair` checks.
 */
export function getPairLeafPlacement(
  category: string | null | undefined,
  qty: number | null | undefined,
): 'active' | 'inactive' | 'shared' | 'split' {
  const mapped = category ? PAIR_LEAF_PLACEMENT[category] : undefined
  if (mapped) return mapped
  // Fallback: qty=1 → shared, qty>1 → split.
  // The qty=1 → shared rule is the 2026-04-18 duplication fix: an unknown
  // single-qty item on a pair door is treated as opening-level rather than
  // mirrored onto both leaves.
  return (qty ?? 0) > 1 ? 'split' : 'shared'
}

/**
 * Export taxonomy as a compact string for use in LLM prompts.
 * Keeps it concise to minimize token usage.
 */
export function getTaxonomyPromptText(): string {
  const lines = HARDWARE_TAXONOMY.map(cat => {
    const contexts: string[] = []
    if (cat.universal) contexts.push('ALL')
    if (cat.exterior) contexts.push('EXT')
    if (cat.interior) contexts.push('INT')
    if (cat.fire_rated) contexts.push('FIRE')
    if (cat.pairs_only) contexts.push('PAIRS-ONLY')

    const scope = cat.install_scope.replace('_', '-')
    return `- ${cat.label} [${contexts.join(',')}] ${scope} | typical qty: ${cat.typical_qty_single[0]}-${cat.typical_qty_single[1]} (single), ${cat.typical_qty_pair[0]}-${cat.typical_qty_pair[1]} (pair)`
  })

  return [
    'HARDWARE ITEM CATEGORIES (expected per opening):',
    'Install scopes: per-leaf (each door panel), per-opening (1 per doorway), per-pair (pairs only), per-frame (1 per frame)',
    'Hinge rule: 1 per 30" of height + 1 (3 for ≤7\'6", 4 for 7\'6"-10\'0", 5 for 10\'0"+). Electrified/spring hinges REPLACE a standard hinge, not additive. Continuous = 1 per leaf.',
    'Pair doors: active leaf gets lockset/exit device, inactive gets flush bolts. Both leaves get hinges, closers, protection plates, sweeps.',
    ...lines,
  ].join('\n')
}

/**
 * Export taxonomy as JSON for the Python pdfplumber endpoint.
 */
export function getTaxonomyForPython(): Array<{
  id: string
  label: string
  patterns: string[]
}> {
  return HARDWARE_TAXONOMY.map(cat => ({
    id: cat.id,
    label: cat.label,
    patterns: cat.name_patterns,
  }))
}
