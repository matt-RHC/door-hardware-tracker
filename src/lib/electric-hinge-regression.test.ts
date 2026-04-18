/**
 * Electric Hinge Classification — Regression Tests
 *
 * These tests lock down the fix for a critical, long-recurring bug where
 * electric hinges were misclassified as standard hinges.  The bug manifested
 * as incorrect hinge counts on pair doors (active leaf got too many standard
 * hinges, electric hinge appeared on both leaves instead of active only).
 *
 * Root cause chain (fixed across 3 PRs):
 *   1. PR #196 — `leaf_side` was missing from Supabase API SELECT queries
 *   2. PR #203 — `classifyItem()` only checked `item.name`, but the electric
 *      hinge identifier "CON TW8" lives in `item.model` field
 *   3. PR #197 — Null safety issues in array access throughout the wizard
 *
 * Correct behavior for a pair door with electric hinges:
 *   Active leaf:   3 standard hinges + 1 electric hinge
 *   Inactive leaf: 4 standard hinges + 0 electric hinges
 *
 * DO NOT REMOVE OR WEAKEN THESE TESTS without understanding the full bug
 * history above.  If a test fails, the bug is back.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyItem,
  scanElectricHinges,
  isAsymmetricHingeSplit,
  HARDWARE_TAXONOMY,
} from './hardware-taxonomy'
import {
  groupItemsByLeaf,
  type LeafGroupableItem,
} from './classify-leaf-items'
import { computeLeafSide, classifyItemScope } from './parse-pdf-helpers'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(
  name: string,
  opts: Partial<LeafGroupableItem> = {},
): LeafGroupableItem {
  return { name, qty: 1, ...opts }
}

// ===========================================================================
// 1. classifyItem — name + model concatenation (regression: PR #203)
// ===========================================================================

describe('classifyItem — model field detection (regression: PR #203 — was only checking name)', () => {
  it('identifies electric hinge from model field "CON TW8" when name is generic "Hinges"', () => {
    // THE bug: name="Hinges" classified as standard hinge because classifyItem
    // never looked at model="5BB1 HW 4 1/2 x 4 1/2 CON TW8".
    expect(
      classifyItem('Hinges', undefined, '5BB1 HW 4 1/2 x 4 1/2 CON TW8'),
    ).toBe('electric_hinge')
  })

  it('identifies electric hinge from compact model "CON TW8" variant', () => {
    expect(
      classifyItem('Hinges', undefined, '5BB1 HW 4.5x4.5 CON TW8'),
    ).toBe('electric_hinge')
  })

  it('identifies electric hinge from model with different TW number', () => {
    expect(
      classifyItem('Hinges', undefined, 'BB1279 4.5x4.5 CON TW4'),
    ).toBe('electric_hinge')
  })

  it('identifies electric hinge from model with CON TW2', () => {
    expect(
      classifyItem('Hinges', undefined, 'Some Model CON TW2'),
    ).toBe('electric_hinge')
  })

  it('classifies standard hinge when model has no electric identifier', () => {
    expect(
      classifyItem('Hinges', undefined, '5BB1 HW 4 1/2 x 4 1/2 NRP'),
    ).toBe('hinges')
  })

  it('classifies standard hinge when model is a plain model number', () => {
    expect(
      classifyItem('Hinges', undefined, '5BB1 4.5x4.5'),
    ).toBe('hinges')
  })

  it('classifies standard hinge when model is undefined', () => {
    expect(classifyItem('Hinges')).toBe('hinges')
    expect(classifyItem('Hinges', undefined, undefined)).toBe('hinges')
  })
})

// ===========================================================================
// 2. classifyItem — name-only detection still works (must not regress)
// ===========================================================================

describe('classifyItem — name-only electric hinge detection (must not regress)', () => {
  it('detects "Electric Hinge" in name', () => {
    expect(classifyItem('Electric Hinge')).toBe('electric_hinge')
    expect(classifyItem('Electric Hinge', undefined, '')).toBe('electric_hinge')
  })

  it('detects "Conductor Hinge" in name', () => {
    expect(classifyItem('Conductor Hinge')).toBe('electric_hinge')
  })

  it('detects "Power Transfer Hinge" in name', () => {
    expect(classifyItem('Power Transfer Hinge')).toBe('electric_hinge')
  })

  it('detects hinge with CON in name', () => {
    expect(classifyItem('Hinges 5BB1 4.5x4.5 CON TW8')).toBe('electric_hinge')
  })
})

// ===========================================================================
// 3. Standalone CON TW regex pattern (regression: PR #203)
// ===========================================================================

describe('classifyItem — standalone \\bCON\\s*TW\\d regex pattern', () => {
  // This pattern was added in PR #203 to catch "CON TW8" in the model field
  // when the combined "name model" text doesn't have "hinge" adjacent to "CON TW".
  // The combined text is "hinges 5bb1 hw 4 1/2 x 4 1/2 con tw8" — the word
  // "hinges" is far from "CON TW8", so patterns like "hinge.*CON" would match,
  // but the standalone pattern provides a safety net.

  it('matches CON TW8 in model when name is simple "Hinges"', () => {
    // Combined: "hinges 5bb1 hw 4 1/2 x 4 1/2 con tw8"
    expect(
      classifyItem('Hinges', undefined, '5BB1 HW 4 1/2 x 4 1/2 CON TW8'),
    ).toBe('electric_hinge')
  })

  it('matches CON TW with no space (CONTW8)', () => {
    // The regex is CON\s*TW\d — zero-width space allowed
    expect(
      classifyItem('Hinges', undefined, '5BB1 CONTW8'),
    ).toBe('electric_hinge')
  })

  it('matches CON alone in model when name includes "Hinge" (hinge.*\\bCON\\b pattern)', () => {
    // The pattern "hinge.*\\bCON\\b" matches "hinges 5bb1 con" in combined text.
    // This is intentional: CON in a hinge context indicates a conductor hinge.
    expect(
      classifyItem('Hinges', undefined, '5BB1 CON'),
    ).toBe('electric_hinge')
  })

  it('matches TW digit alone in model when name includes "Hinge" (hinge.*\\bTW\\d pattern)', () => {
    // The pattern "hinge.*\\bTW\\d" matches "hinges 5bb1 tw8" in combined text.
    // TW followed by a digit in a hinge context indicates a transfer wire hinge.
    expect(
      classifyItem('Hinges', undefined, '5BB1 TW8'),
    ).toBe('electric_hinge')
  })

  it('does not match CON or TW when name is NOT a hinge', () => {
    // Without "hinge" in the combined text, "CON" alone shouldn't trigger
    // the hinge-specific patterns. The standalone \bCON\s*TW\d also fails
    // because TW digit is absent or CON is absent.
    expect(
      classifyItem('Closer', undefined, '5BB1 CON'),
    ).not.toBe('electric_hinge')
    expect(
      classifyItem('Lockset', undefined, '5BB1 TW8'),
    ).not.toBe('electric_hinge')
  })
})

// ===========================================================================
// 4. classifyItem — null/undefined safety (regression: PR #197)
// ===========================================================================

describe('classifyItem — null/undefined safety (regression: PR #197)', () => {
  it('does not crash when model is null', () => {
    expect(() => classifyItem('Hinges', undefined, null as unknown as string)).not.toThrow()
    expect(classifyItem('Hinges', undefined, null as unknown as string)).toBe('hinges')
  })

  it('does not crash when model is undefined', () => {
    expect(() => classifyItem('Hinges', undefined, undefined)).not.toThrow()
    expect(classifyItem('Hinges', undefined, undefined)).toBe('hinges')
  })

  it('does not crash when name is null', () => {
    expect(() => classifyItem(null as unknown as string)).not.toThrow()
  })

  it('does not crash when name is undefined', () => {
    expect(() => classifyItem(undefined as unknown as string)).not.toThrow()
  })

  it('does not crash when both name and model are null', () => {
    expect(() =>
      classifyItem(null as unknown as string, undefined, null as unknown as string),
    ).not.toThrow()
  })

  it('still classifies correctly when model is empty string', () => {
    expect(classifyItem('Electric Hinge', undefined, '')).toBe('electric_hinge')
    expect(classifyItem('Hinges', undefined, '')).toBe('hinges')
  })
})

// ===========================================================================
// 5. scanElectricHinges — model field support
// ===========================================================================

describe('scanElectricHinges — detects electric hinges via model field', () => {
  it('detects electric hinge from model field on pair door', () => {
    const items = [
      { name: 'Hinges', model: '5BB1 HW 4 1/2 x 4 1/2 NRP', qty: 4 },
      { name: 'Hinges', model: '5BB1 HW 4 1/2 x 4 1/2 CON TW8', qty: 1 },
    ]
    const result = scanElectricHinges(items, true)
    expect(result.hasElectricHinge).toBe(true)
    expect(result.totalElectricQty).toBe(1)
  })

  it('does not detect electric hinge on single doors (returns 0)', () => {
    const items = [
      { name: 'Hinges', model: '5BB1 HW 4 1/2 x 4 1/2 CON TW8', qty: 1 },
    ]
    const result = scanElectricHinges(items, false)
    expect(result.hasElectricHinge).toBe(false)
    expect(result.totalElectricQty).toBe(0)
  })

  it('skips items that already have leaf_side set', () => {
    // Items with leaf_side already set were processed by the save path.
    // scanElectricHinges should not count them (avoids double-adjusting).
    const items = [
      { name: 'Hinges', model: '5BB1 CON TW8', qty: 1, leaf_side: 'active' },
    ]
    const result = scanElectricHinges(items, true)
    expect(result.hasElectricHinge).toBe(false)
    expect(result.totalElectricQty).toBe(0)
  })

  it('handles null model gracefully', () => {
    const items = [
      { name: 'Hinges', model: null, qty: 4 },
    ]
    expect(() => scanElectricHinges(items, true)).not.toThrow()
    const result = scanElectricHinges(items, true)
    expect(result.hasElectricHinge).toBe(false)
  })
})

// ===========================================================================
// 6. isAsymmetricHingeSplit — helper correctness
// ===========================================================================

describe('isAsymmetricHingeSplit — validates asymmetric hinge detection', () => {
  it('returns true for 7 standard + 1 electric divided by 2', () => {
    // (7 + 1) / 2 = 4 → integer → asymmetric split detected
    expect(isAsymmetricHingeSplit(7, 1, 2)).toBe(true)
  })

  it('returns true for 3 standard + 1 electric divided by 2', () => {
    // (3 + 1) / 2 = 2 → integer
    expect(isAsymmetricHingeSplit(3, 1, 2)).toBe(true)
  })

  it('returns false when electric qty is 0', () => {
    expect(isAsymmetricHingeSplit(7, 0, 2)).toBe(false)
  })

  it('returns false when total is not evenly divisible', () => {
    // (6 + 1) / 2 = 3.5 → not integer
    expect(isAsymmetricHingeSplit(6, 1, 2)).toBe(false)
  })
})

// ===========================================================================
// 7. computeLeafSide — leaf_side propagation (regression: PR #196)
// ===========================================================================

describe('computeLeafSide — leaf_side is computed and not silently dropped', () => {
  it('structural: Door (Active Leaf) → "active"', () => {
    expect(computeLeafSide('Door (Active Leaf)', 2)).toBe('active')
  })

  it('structural: Door (Inactive Leaf) → "inactive"', () => {
    expect(computeLeafSide('Door (Inactive Leaf)', 2)).toBe('inactive')
  })

  it('structural: Frame → "shared"', () => {
    expect(computeLeafSide('Frame', 2)).toBe('shared')
  })

  it('structural: bare "Door" on single opening → "active"', () => {
    expect(computeLeafSide('Door', 1)).toBe('active')
  })

  it('structural: bare "Door" on pair opening → null (ambiguous)', () => {
    expect(computeLeafSide('Door', 2)).toBeNull()
  })

  it('per_pair item → "shared"', () => {
    expect(computeLeafSide('Coordinator', 2)).toBe('shared')
  })

  it('per_frame item → "shared"', () => {
    expect(computeLeafSide('Threshold', 2)).toBe('shared')
  })

  it('per_leaf item on pair door → null (deferred to groupItemsByLeaf)', () => {
    // Hinges are per_leaf — on pair doors, the side is ambiguous at save time
    expect(computeLeafSide('Hinges', 2)).toBeNull()
  })

  it('per_opening item on pair door → null (deferred)', () => {
    expect(computeLeafSide('Closer', 2)).toBeNull()
  })
})

// ===========================================================================
// 8. classifyItemScope — model field used for scope lookup
// ===========================================================================

describe('classifyItemScope — uses model field for accurate scope', () => {
  it('electric hinge (via model) has per_opening scope', () => {
    expect(classifyItemScope('Hinges', '5BB1 HW 4 1/2 x 4 1/2 CON TW8')).toBe('per_opening')
  })

  it('standard hinge (via model) has per_leaf scope', () => {
    expect(classifyItemScope('Hinges', '5BB1 HW 4 1/2 x 4 1/2 NRP')).toBe('per_leaf')
  })

  it('standard hinge (no model) has per_leaf scope', () => {
    expect(classifyItemScope('Hinges')).toBe('per_leaf')
  })
})

// ===========================================================================
// 9. TAXONOMY ORDERING — electric_hinge must precede generic hinges
// ===========================================================================

describe('HARDWARE_TAXONOMY — electric_hinge before generic hinges (structural invariant)', () => {
  it('electric_hinge appears before hinges in HARDWARE_TAXONOMY array', () => {
    const electricIdx = HARDWARE_TAXONOMY.findIndex(c => c.id === 'electric_hinge')
    const genericIdx = HARDWARE_TAXONOMY.findIndex(c => c.id === 'hinges')
    expect(electricIdx).toBeGreaterThanOrEqual(0)
    expect(genericIdx).toBeGreaterThanOrEqual(0)
    expect(electricIdx).toBeLessThan(genericIdx)
  })

  it('electric_hinge has per_opening install_scope', () => {
    const cat = HARDWARE_TAXONOMY.find(c => c.id === 'electric_hinge')
    expect(cat).toBeDefined()
    expect(cat!.install_scope).toBe('per_opening')
  })

  it('electric_hinge name_patterns include standalone CON TW pattern', () => {
    const cat = HARDWARE_TAXONOMY.find(c => c.id === 'electric_hinge')
    expect(cat).toBeDefined()
    const hasConTwPattern = cat!.name_patterns.some(p => p.includes('CON') && p.includes('TW'))
    expect(hasConTwPattern).toBe(true)
  })
})

// ===========================================================================
// 10. END-TO-END: Pair door with electric hinge — THE critical scenario
// ===========================================================================

describe('END-TO-END: pair door hinge distribution (THE critical regression test)', () => {
  /**
   * This is the scenario that triggered the original bug report.
   *
   * A pair door has:
   *   - 7 standard hinges (per-leaf qty after normalization = 4 per leaf × 2 = 8 total
   *     minus 1 electric = 7 standard)
   *     Actually: qty is already per-leaf (4), but active leaf gets qty-1 because
   *     the electric hinge replaces one position on the active leaf.
   *   - 1 electric hinge (qty=1, active leaf only)
   *
   * Expected distribution:
   *   Active leaf:   3 standard + 1 electric = 4 hinge positions
   *   Inactive leaf: 4 standard + 0 electric = 4 hinge positions
   */
  it('wizard preview: 4 standard + 1 electric → active=3+1, inactive=4+0', () => {
    // Wizard preview path: leaf_side is null on all items (not yet saved).
    // This simulates what the user sees before hitting Save.
    const items: LeafGroupableItem[] = [
      makeItem('Hinges', { qty: 4, model: '5BB1 HW 4 1/2 x 4 1/2 NRP' }),
      makeItem('Hinges', { qty: 1, model: '5BB1 HW 4 1/2 x 4 1/2 CON TW8' }),
    ]
    const { shared, leaf1, leaf2 } = groupItemsByLeaf(items, 2)

    // No hinges should be in shared
    expect(shared).toHaveLength(0)

    // Active leaf (leaf1): 3 standard + 1 electric
    expect(leaf1).toHaveLength(2)
    const activeStandard = leaf1.find(i => !i.model?.includes('CON TW'))
    const activeElectric = leaf1.find(i => i.model?.includes('CON TW'))
    expect(activeStandard).toBeDefined()
    expect(activeElectric).toBeDefined()
    expect(activeStandard!.qty).toBe(3) // 4 - 1 = 3 standard on active
    expect(activeElectric!.qty).toBe(1) // 1 electric on active

    // Inactive leaf (leaf2): 4 standard, NO electric
    expect(leaf2).toHaveLength(1)
    expect(leaf2[0].qty).toBe(4) // full standard qty
    expect(leaf2.some(i => i.model?.includes('CON TW'))).toBe(false) // no electric
  })

  it('wizard preview: 7 standard + 1 electric → active=6+1, inactive=7+0', () => {
    // Variant with higher hinge count (taller doors).
    const items: LeafGroupableItem[] = [
      makeItem('Hinges', { qty: 7, model: '5BB1 HW 4 1/2 x 4 1/2 NRP' }),
      makeItem('Hinges', { qty: 1, model: '5BB1 HW 4 1/2 x 4 1/2 CON TW8' }),
    ]
    const { leaf1, leaf2 } = groupItemsByLeaf(items, 2)

    // Active leaf: 6 standard + 1 electric
    expect(leaf1).toHaveLength(2)
    expect(leaf1[0].qty).toBe(6) // 7 - 1 = 6
    expect(leaf1[1].qty).toBe(1)

    // Inactive leaf: 7 standard, no electric
    expect(leaf2).toHaveLength(1)
    expect(leaf2[0].qty).toBe(7)
  })

  it('saved path: pre-split quantities with leaf_side persisted', () => {
    // After saving, buildPerOpeningItems has already split the quantities
    // and stamped leaf_side on each row. groupItemsByLeaf should route
    // them correctly without further qty adjustment.
    const items: LeafGroupableItem[] = [
      makeItem('Hinges', { qty: 3, model: '5BB1 HW NRP', leaf_side: 'active' }),
      makeItem('Hinges', { qty: 4, model: '5BB1 HW NRP', leaf_side: 'inactive' }),
      makeItem('Hinges', { qty: 1, model: '5BB1 HW CON TW8', leaf_side: 'active' }),
    ]
    const { shared, leaf1, leaf2 } = groupItemsByLeaf(items, 2)

    expect(shared).toHaveLength(0)

    // Active leaf: 3 standard + 1 electric
    expect(leaf1).toHaveLength(2)
    expect(leaf1.map(i => i.qty)).toEqual([3, 1])

    // Inactive leaf: 4 standard
    expect(leaf2).toHaveLength(1)
    expect(leaf2[0].qty).toBe(4)
  })

  it('single door: no asymmetric split, electric hinge goes to leaf1', () => {
    // Single doors should NOT get the pair-door split logic.
    const items: LeafGroupableItem[] = [
      makeItem('Hinges', { qty: 3, model: '5BB1 HW 4 1/2 x 4 1/2 NRP' }),
      makeItem('Hinges', { qty: 1, model: '5BB1 HW 4 1/2 x 4 1/2 CON TW8' }),
    ]
    const { leaf1, leaf2 } = groupItemsByLeaf(items, 1)

    // All items go to leaf1, no qty adjustment
    expect(leaf1).toHaveLength(2)
    expect(leaf1[0].qty).toBe(3) // unchanged
    expect(leaf1[1].qty).toBe(1) // unchanged
    expect(leaf2).toHaveLength(0)
  })

  it('pair door with no electric hinges: standard hinges on both leaves, same qty', () => {
    // Control test: no electric hinges → no asymmetric split
    const items: LeafGroupableItem[] = [
      makeItem('Hinges', { qty: 4, model: '5BB1 HW 4 1/2 x 4 1/2 NRP' }),
    ]
    const { leaf1, leaf2 } = groupItemsByLeaf(items, 2)

    expect(leaf1).toHaveLength(1)
    expect(leaf1[0].qty).toBe(4)
    expect(leaf2).toHaveLength(1)
    expect(leaf2[0].qty).toBe(4)
  })
})

// ===========================================================================
// 11. Mixed hardware set — electric hinge doesn't affect non-hinge items
// ===========================================================================

describe('groupItemsByLeaf — electric hinge does not affect non-hinge items', () => {
  it('closer and lockset route normally alongside electric hinge', () => {
    // 2026-04-18: Updated for PAIR_LEAF_PLACEMENT routing.
    // Under the new placement map: Lockset is 'active' (active leaf only),
    // Closer is 'split' (both leaves), Coordinator is 'shared'. This asserts
    // the electric-hinge qty adjustment still layers cleanly on top of the
    // placement map — it only subtracts from the standard hinge row on the
    // active leaf and doesn't leak into other hardware's routing.
    const items: LeafGroupableItem[] = [
      makeItem('Hinges', { qty: 4, model: '5BB1 HW NRP' }),
      makeItem('Hinges', { qty: 1, model: '5BB1 HW CON TW8' }),
      makeItem('Closer', { qty: 1 }),
      makeItem('Lockset', { qty: 1 }),
      makeItem('Coordinator', { qty: 1 }),
      makeItem('Frame', { qty: 1 }),
    ]
    const { shared, leaf1, leaf2 } = groupItemsByLeaf(items, 2)

    // Shared: Coordinator + Frame
    expect(shared.map(i => i.name)).toEqual(['Coordinator', 'Frame'])

    // Active leaf: 3 standard hinges (4-1) + 1 electric + closer + lockset
    expect(leaf1).toHaveLength(4)
    expect(leaf1[0].qty).toBe(3) // standard hinge: 4-1
    expect(leaf1[1].qty).toBe(1) // electric hinge
    const closerOnActive = leaf1.find(i => i.name === 'Closer')
    expect(closerOnActive).toBeDefined()
    expect(closerOnActive!.qty).toBe(1)
    const locksetOnActive = leaf1.find(i => i.name === 'Lockset')
    expect(locksetOnActive).toBeDefined()
    expect(locksetOnActive!.qty).toBe(1)

    // Inactive leaf: 4 standard hinges (full qty, no electric adjust) + closer
    // Lockset is placement='active' → must NOT appear on leaf2 under the
    // duplication fix; prior behavior mirrored it and inflated the count.
    expect(leaf2).toHaveLength(2)
    expect(leaf2.some(i => i.name === 'Hinges' && i.qty === 4)).toBe(true)
    expect(leaf2.some(i => i.model?.includes('CON TW'))).toBe(false)
    expect(leaf2.some(i => i.name === 'Closer')).toBe(true)
    expect(leaf2.some(i => i.name === 'Lockset')).toBe(false)
  })
})

// ===========================================================================
// 12. Edge case: multiple electric hinges on a pair door
// ===========================================================================

describe('groupItemsByLeaf — multiple electric hinges', () => {
  it('pair door with 2 electric hinges adjusts standard qty by 2', () => {
    const items: LeafGroupableItem[] = [
      makeItem('Hinges', { qty: 4, model: '5BB1 HW NRP' }),
      makeItem('Hinges', { qty: 2, model: '5BB1 HW CON TW8' }),
    ]
    const { leaf1, leaf2 } = groupItemsByLeaf(items, 2)

    // Active leaf: 2 standard (4-2) + 2 electric
    expect(leaf1).toHaveLength(2)
    expect(leaf1[0].qty).toBe(2) // 4 - 2
    expect(leaf1[1].qty).toBe(2) // electric

    // Inactive leaf: 4 standard, no electric
    expect(leaf2).toHaveLength(1)
    expect(leaf2[0].qty).toBe(4)
  })
})
