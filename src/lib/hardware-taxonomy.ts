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
    id: 'hinges',
    label: 'Hinges',
    name_patterns: [
      'hinge',
      'butt\\s*hinge',
      'continuous\\s*hinge',
      'pivot',
      'spring\\s*hinge',
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
    install_scope: 'per_opening',
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
      'dust\\s*proof\\s*strike',
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
    install_scope: 'per_opening',
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
    install_scope: 'per_leaf',
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
    install_scope: 'per_opening',
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
    install_scope: 'per_opening',
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
    ],
    universal: false,
    exterior: false,
    interior: true,
    fire_rated: false,
    pairs_only: false,
    install_scope: 'per_leaf',
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

/**
 * Classify an item name into a category. Returns the category ID or 'unknown'.
 * Optionally accepts a manufacturer for fallback classification when the
 * item name is a model number only (e.g., "Von Duprin 99").
 */
export function classifyItem(itemName: string, manufacturer?: string): string {
  const lower = itemName.toLowerCase().trim()
  for (const cat of HARDWARE_TAXONOMY) {
    for (const pattern of cat.name_patterns) {
      if (new RegExp(pattern, 'i').test(lower)) {
        return cat.id
      }
    }
  }

  // Fallback: check manufacturer prefix against known mappings
  if (manufacturer) {
    const mfrLower = manufacturer.toLowerCase().trim()
    for (const [prefix, category] of Object.entries(MANUFACTURER_CATEGORY_MAP)) {
      if (mfrLower.startsWith(prefix)) {
        return category
      }
    }
  }

  // Also check if the item name itself starts with a known manufacturer
  for (const [prefix, category] of Object.entries(MANUFACTURER_CATEGORY_MAP)) {
    if (lower.startsWith(prefix)) {
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
