/**
 * Product Family Grouping & Near-Duplicate Detection
 *
 * Groups extracted hardware items by product family (manufacturer + base series)
 * and detects potential typos between families. Used by StepProducts in the
 * ImportWizard to give users a product-family-level review before saving.
 *
 * All functions are pure and synchronous — no API calls, no React dependency.
 */

import type { HardwareSet, ExtractedHardwareItem } from '@/lib/types'
import { classifyItem, HARDWARE_TAXONOMY } from '@/lib/hardware-taxonomy'

// ── Types ──────────────────────────────────────────────────────────

/** A single variation of a product within a family. */
export interface ProductVariant {
  model: string
  normalizedModel: string
  name: string
  finish: string
  occurrences: number
  setIds: string[]
}

/** A product family grouped by (manufacturer, baseSeries). */
export interface ProductFamily {
  baseSeries: string
  manufacturer: string
  categoryId: string
  categoryLabel: string
  items: ProductVariant[]
  totalOccurrences: number
}

/** A pair of families that might be typos of each other. */
export interface TypoCandidate {
  familyA: ProductFamily
  familyB: ProductFamily
  distance: number
}

/** Full analysis result from analyzeProducts(). */
export interface ProductAnalysis {
  families: ProductFamily[]
  byCategory: Map<string, ProductFamily[]>
  typoCandidates: TypoCandidate[]
  totalUnique: number
}

// ── Pure utility functions ─────────────────────────────────────────

/** Normalize a model string: lowercase, collapse whitespace, strip trailing punctuation. */
export function normalizeModel(model: string): string {
  return (model ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/, '')
    .trim()
}

/** Classic Levenshtein distance. O(n*m) time, O(n) space. */
export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m

  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  const curr = new Array<number>(n + 1)

  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      )
    }
    prev = [...curr]
  }
  return prev[n]
}

// ── Size indicator pattern (mirrors Python _SIZE_PATTERN) ──────────
const SIZE_PATTERN = /^\d[\d\s\-/]*\s*[x×X]\s*\d|^\d+['"″"]/

// ── Manufacturer-specific base series patterns ─────────────────────
const BASE_SERIES_PATTERNS: Array<{ mfr: string; re: RegExp }> = [
  { mfr: 'schlage', re: /^(L\d{4})/i },
  { mfr: 'von duprin', re: /^(\d{2})(?:EO|NL|L|TP|DT|-|$|\s)/i },
  { mfr: 'lcn', re: /^(\d{4}[A-Z]*)/i },
  { mfr: 'sargent', re: /^(\d{2,4})/i },
  { mfr: 'corbin russwin', re: /^([MC]L\d{4})/i },
  { mfr: 'adams rite', re: /^(\d{4})/i },
  { mfr: 'securitron', re: /^([A-Z]\d{2,3})/i },
  { mfr: 'dorma', re: /^(\d{4})/i },
  { mfr: 'dormakaba', re: /^(\d{4})/i },
  { mfr: 'norton', re: /^(\d{4})/i },
]

/**
 * Extract the base product family from a model string.
 * Mirrors Python extract_base_series() for cross-validation.
 */
export function extractBaseSeries(model: string, manufacturer: string): string {
  const trimmed = (model ?? '').trim()
  if (!trimmed) return ''

  const mfrLower = (manufacturer ?? '').toLowerCase()

  // Try manufacturer-specific patterns
  for (const { mfr, re } of BASE_SERIES_PATTERNS) {
    if (mfrLower.includes(mfr)) {
      const m = re.exec(trimmed)
      if (m?.[1]) return m[1].toUpperCase()
    }
  }

  // Generic fallback: first alphanumeric token that isn't a size
  const tokens = trimmed.split(/\s+/)
  for (const tok of tokens) {
    if (SIZE_PATTERN.test(tok)) continue
    if (/[A-Za-z0-9]/.test(tok)) {
      const cleaned = tok.replace(/[-,;:]+$/, '')
      if (cleaned) return cleaned.toUpperCase()
    }
  }

  return ''
}

/** Look up the category label from the taxonomy. */
function getCategoryLabel(categoryId: string): string {
  const cat = HARDWARE_TAXONOMY.find(c => c.id === categoryId)
  return cat?.label ?? 'Other'
}

// ── Main analysis function ─────────────────────────────────────────

/**
 * Analyze hardware sets to build product family groupings and detect typos.
 *
 * 1. Flatten all items from all sets
 * 2. Extract/validate base series for each item
 * 3. Group by (manufacturer, baseSeries) → ProductFamily
 * 4. Cross-family typo detection via Levenshtein on base series strings
 */
export function analyzeProducts(hardwareSets: HardwareSet[]): ProductAnalysis {
  // Map key: "manufacturer|baseSeries" → variants map
  const familyMap = new Map<string, {
    baseSeries: string
    manufacturer: string
    categoryId: string
    variants: Map<string, ProductVariant>  // normalizedModel → variant
  }>()

  for (const set of hardwareSets ?? []) {
    for (const item of set.items ?? []) {
      const model = item.model ?? ''
      if (!model.trim()) continue

      const manufacturer = item.manufacturer ?? ''
      // Use Python-extracted base_series if available, otherwise compute client-side
      const baseSeries = (item.base_series ?? '').trim()
        || extractBaseSeries(model, manufacturer)
      if (!baseSeries) continue

      // Cross-validate if Python provided one
      if ((item.base_series ?? '').trim()) {
        const clientSeries = extractBaseSeries(model, manufacturer)
        if (clientSeries && clientSeries !== item.base_series?.trim().toUpperCase()) {
          console.warn(
            `[product-dedup] base_series mismatch for "${model}": ` +
            `python="${item.base_series}" vs client="${clientSeries}"`
          )
        }
      }

      const categoryId = classifyItem(item.name ?? '', manufacturer, item.model)
      const normalized = normalizeModel(model)
      const key = `${(manufacturer ?? '').toLowerCase()}|${(baseSeries ?? '').toLowerCase()}`

      let family = familyMap.get(key)
      if (!family) {
        family = {
          baseSeries,
          manufacturer,
          categoryId,
          variants: new Map(),
        }
        familyMap.set(key, family)
      }

      const existing = family.variants.get(normalized)
      if (existing) {
        existing.occurrences += 1
        if (!existing.setIds.includes(set.set_id)) {
          existing.setIds.push(set.set_id)
        }
      } else {
        family.variants.set(normalized, {
          model,
          normalizedModel: normalized,
          name: item.name ?? '',
          finish: item.finish ?? '',
          occurrences: 1,
          setIds: [set.set_id],
        })
      }
    }
  }

  // Build ProductFamily array
  const families: ProductFamily[] = []
  for (const f of familyMap.values()) {
    const items = Array.from(f.variants.values())
    families.push({
      baseSeries: f.baseSeries,
      manufacturer: f.manufacturer,
      categoryId: f.categoryId,
      categoryLabel: getCategoryLabel(f.categoryId),
      items,
      totalOccurrences: items.reduce((sum, v) => sum + v.occurrences, 0),
    })
  }

  // Sort: most occurrences first within each category
  families.sort((a, b) => b.totalOccurrences - a.totalOccurrences)

  // Group by category
  const byCategory = new Map<string, ProductFamily[]>()
  for (const fam of families) {
    const catKey = fam.categoryId
    const existing = byCategory.get(catKey)
    if (existing) {
      existing.push(fam)
    } else {
      byCategory.set(catKey, [fam])
    }
  }

  // Cross-family typo detection: compare base series within same (manufacturer, category)
  const typoCandidates: TypoCandidate[] = []
  const categoryEntries = Array.from(byCategory.entries())
  for (const [, catFamilies] of categoryEntries) {
    for (let i = 0; i < catFamilies.length; i++) {
      for (let j = i + 1; j < catFamilies.length; j++) {
        const a = catFamilies[i]
        const b = catFamilies[j]
        // Only compare within same manufacturer
        if ((a.manufacturer ?? '').toLowerCase() !== (b.manufacturer ?? '').toLowerCase()) continue
        const dist = levenshtein(
          (a.baseSeries ?? '').toLowerCase(),
          (b.baseSeries ?? '').toLowerCase(),
        )
        if (dist === 1) {
          typoCandidates.push({ familyA: a, familyB: b, distance: dist })
        }
      }
    }
  }

  const totalUnique = families.reduce((sum, f) => sum + f.items.length, 0)

  return { families, byCategory, typoCandidates, totalUnique }
}

// ── Correction function ────────────────────────────────────────────

/**
 * Apply a model string correction across all hardware sets.
 * Replaces all items whose normalized model matches any variant with the canonical.
 * Returns a new array (immutable).
 */
export function applyCorrection(
  hardwareSets: HardwareSet[],
  variantModels: string[],
  canonicalModel: string,
): HardwareSet[] {
  const variantSet = new Set(variantModels.map(v => normalizeModel(v)))

  return (hardwareSets ?? []).map(set => {
    const items = (set.items ?? []).map(item => {
      if (variantSet.has(normalizeModel(item.model ?? ''))) {
        return { ...item, model: canonicalModel }
      }
      return item
    })
    const changed = items.some((item, i) => item !== (set.items ?? [])[i])
    return changed ? { ...set, items } : set
  })
}
