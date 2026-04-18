import { describe, it, expect } from 'vitest'
import { groupItemsByLeaf, itemsIndicatePair, type LeafGroupableItem } from './classify-leaf-items'

function makeItem(
  name: string,
  opts: Partial<LeafGroupableItem> = {},
): LeafGroupableItem {
  return {
    name,
    qty: 1,
    ...opts,
  }
}

describe('groupItemsByLeaf — DB leaf_side preference (Phase 3)', () => {
  it('routes an item with leaf_side="shared" to shared regardless of taxonomy', () => {
    // "Hinge" would normally taxonomy-classify as per_leaf and go to both
    // leaves. If the user (or save path) explicitly marked leaf_side="shared",
    // the persisted value wins.
    const items = [makeItem('Hinge 5BB1', { leaf_side: 'shared' })]
    const { shared, leaf1, leaf2 } = groupItemsByLeaf(items, 2)
    expect(shared).toHaveLength(1)
    expect(leaf1).toHaveLength(0)
    expect(leaf2).toHaveLength(0)
  })

  it('routes an item with leaf_side="active" to leaf1 only', () => {
    // Exit Device would normally go to both leaves by taxonomy. Explicit
    // 'active' sends it to leaf1 only (DFH-correct pair behavior).
    const items = [makeItem('Exit Device 9875', { leaf_side: 'active' })]
    const { shared, leaf1, leaf2 } = groupItemsByLeaf(items, 2)
    expect(shared).toHaveLength(0)
    expect(leaf1).toHaveLength(1)
    expect(leaf2).toHaveLength(0)
  })

  it('routes an item with leaf_side="inactive" to leaf2 only on pairs', () => {
    const items = [makeItem('Flush Bolt FB32', { leaf_side: 'inactive' })]
    const { shared, leaf1, leaf2 } = groupItemsByLeaf(items, 2)
    expect(shared).toHaveLength(0)
    expect(leaf1).toHaveLength(0)
    expect(leaf2).toHaveLength(1)
  })

  it('drops leaf_side="inactive" items on single openings (no inactive leaf exists)', () => {
    const items = [makeItem('Flush Bolt FB32', { leaf_side: 'inactive' })]
    const { shared, leaf1, leaf2 } = groupItemsByLeaf(items, 1)
    expect(shared).toHaveLength(0)
    expect(leaf1).toHaveLength(0)
    expect(leaf2).toHaveLength(0)
  })

  it('routes leaf_side="both" to both leaves on pairs', () => {
    const items = [makeItem('Hinge', { leaf_side: 'both' })]
    const { shared, leaf1, leaf2 } = groupItemsByLeaf(items, 2)
    expect(shared).toHaveLength(0)
    expect(leaf1).toHaveLength(1)
    expect(leaf2).toHaveLength(1)
  })

  it('falls back to taxonomy regex when leaf_side is null/undefined', () => {
    // Coordinator is per_pair → shared. Flush Bolt is per_pair → shared.
    // Both have leaf_side=undefined in this test, so legacy classification
    // applies.
    const items = [
      makeItem('Coordinator'),
      makeItem('Flush Bolt FB32'),
      makeItem('Hinge'),
    ]
    const { shared, leaf1, leaf2 } = groupItemsByLeaf(items, 2)
    expect(shared.map(i => i.name)).toEqual(['Coordinator', 'Flush Bolt FB32'])
    // Hinge (per_leaf, leaf_side unset) → both leaves via legacy logic
    expect(leaf1.map(i => i.name)).toEqual(['Hinge'])
    expect(leaf2.map(i => i.name)).toEqual(['Hinge'])
  })

  it('explicit leaf_side overrides taxonomy even when taxonomy disagrees', () => {
    // Flush Bolt is per_pair (→ shared by taxonomy). But the user may have
    // set it to leaf_side='inactive' via the triage UI because that's where
    // it physically installs. The DB value wins.
    const items = [makeItem('Flush Bolt FB32', { leaf_side: 'inactive' })]
    const { shared, leaf1, leaf2 } = groupItemsByLeaf(items, 2)
    expect(shared).toHaveLength(0)
    expect(leaf2).toHaveLength(1)
    expect(leaf1).toHaveLength(0)
  })

  it('structural Door/Frame rows still route correctly when leaf_side is null', () => {
    // These should go via the name-based fallback even though leaf_side isn't
    // set on legacy rows.
    const items = [
      makeItem('Door (Active Leaf)'),
      makeItem('Door (Inactive Leaf)'),
      makeItem('Frame'),
    ]
    const { shared, leaf1, leaf2 } = groupItemsByLeaf(items, 2)
    expect(leaf1.map(i => i.name)).toEqual(['Door (Active Leaf)'])
    expect(leaf2.map(i => i.name)).toEqual(['Door (Inactive Leaf)'])
    expect(shared.map(i => i.name)).toEqual(['Frame'])
  })


  it('routes electric hinge to active leaf only on pairs when leaf_side is null (wizard preview)', () => {
    // Wizard preview: items haven't been saved to DB so leaf_side is null.
    // Electric hinges (per_opening) should NOT appear on both leaves.
    // Standard hinge qty on active leaf is reduced by electric hinge count.
    const items = [
      makeItem('Hinges 5BB1 4.5x4.5 NRP', { qty: 4 }),       // standard hinge → both leaves
      makeItem('Hinges 5BB1 4.5x4.5 CON TW8', { qty: 1 }),   // electric hinge → active only
    ]
    const { shared, leaf1, leaf2 } = groupItemsByLeaf(items, 2)
    expect(shared).toHaveLength(0)
    // Active leaf: 3 standard (4-1) + 1 electric = 2 items
    expect(leaf1).toHaveLength(2)
    expect(leaf1.map(i => i.name)).toEqual([
      'Hinges 5BB1 4.5x4.5 NRP',
      'Hinges 5BB1 4.5x4.5 CON TW8',
    ])
    expect(leaf1[0].qty).toBe(3) // 4 standard - 1 electric = 3
    expect(leaf1[1].qty).toBe(1) // electric hinge unchanged
    // Inactive leaf: full standard qty — NO electric hinge
    expect(leaf2).toHaveLength(1)
    expect(leaf2[0].name).toBe('Hinges 5BB1 4.5x4.5 NRP')
    expect(leaf2[0].qty).toBe(4) // inactive keeps full qty
  })

  it('routes electric/conductor hinge to active leaf only on pairs when leaf_side is null', () => {
    // "electr.*hinge" pattern matches "Electric Hinge" names
    const items = [makeItem('Electric Hinge 4.5x4.5', { qty: 1 })]
    const { leaf1, leaf2 } = groupItemsByLeaf(items, 2)
    expect(leaf1).toHaveLength(1)
    expect(leaf2).toHaveLength(0)
  })

  it('does not apply electric hinge guard on single doors', () => {
    // Single doors: electric hinge should go to leaf1 (no leaf2 regardless)
    const items = [makeItem('Hinges 5BB1 4.5x4.5 CON TW8', { qty: 1 })]
    const { leaf1, leaf2 } = groupItemsByLeaf(items, 1)
    expect(leaf1).toHaveLength(1)
    expect(leaf2).toHaveLength(0)
  })

  it('routes electric hinge with leaf_side="active" to active leaf only on pairs', () => {
    // Phase 4: buildPerOpeningItems stamps leaf_side='active' on electric
    // hinges for pair doors. groupItemsByLeaf should route them correctly.
    // When leaf_side is already set, the standard hinge qty adjustment does
    // NOT apply — the save path already split the qty correctly.
    const items = [
      makeItem('Hinges 5BB1 4.5x4.5 NRP', { qty: 3, leaf_side: 'active' }),
      makeItem('Hinges 5BB1 4.5x4.5 NRP', { qty: 4, leaf_side: 'inactive' }),
      makeItem('Hinges 5BB1 4.5x4.5 CON TW8', { qty: 1, leaf_side: 'active' }),
    ]
    const { shared, leaf1, leaf2 } = groupItemsByLeaf(items, 2)
    expect(shared).toHaveLength(0)
    // Active leaf: 3 standard + 1 electric = 2 items
    expect(leaf1).toHaveLength(2)
    expect(leaf1.map(i => i.qty)).toEqual([3, 1])
    // Inactive leaf: 4 standard only = 1 item
    expect(leaf2).toHaveLength(1)
    expect(leaf2[0].qty).toBe(4)
  })
})

describe('groupItemsByLeaf — standard hinge qty adjustment for electric hinges', () => {
  it('pair door: 4 standard + 1 electric → active gets 3 standard, inactive gets 4', () => {
    // 8 total hinge positions (4 per leaf), 1 is electric on active leaf.
    // Wizard preview path: leaf_side is null on all items.
    const items = [
      makeItem('Hinges 5BB1 4.5x4.5 NRP', { qty: 4 }),
      makeItem('Hinges 5BB1 4.5x4.5 CON TW8', { qty: 1 }),
    ]
    const { leaf1, leaf2 } = groupItemsByLeaf(items, 2)
    // Active leaf: 3 standard + 1 electric
    expect(leaf1).toHaveLength(2)
    expect(leaf1[0].qty).toBe(3)
    expect(leaf1[1].qty).toBe(1)
    // Inactive leaf: 4 standard, no electric
    expect(leaf2).toHaveLength(1)
    expect(leaf2[0].qty).toBe(4)
  })

  it('pair door: 7 standard + 1 electric → active gets 6 standard, inactive gets 7', () => {
    // Aggregate across the set: e.g., taller doors with more hinge positions.
    const items = [
      makeItem('Hinges 5BB1 4.5x4.5 NRP', { qty: 7 }),
      makeItem('Hinges 5BB1 4.5x4.5 CON TW8', { qty: 1 }),
    ]
    const { leaf1, leaf2 } = groupItemsByLeaf(items, 2)
    expect(leaf1).toHaveLength(2)
    expect(leaf1[0].qty).toBe(6) // 7 - 1 electric
    expect(leaf1[1].qty).toBe(1)
    expect(leaf2).toHaveLength(1)
    expect(leaf2[0].qty).toBe(7) // inactive keeps full qty
  })

  it('single door: no standard hinge qty adjustment even with electric hinge', () => {
    // Single doors: electricHingeQty is 0 (isPair is false), no adjustment.
    const items = [
      makeItem('Hinges 5BB1 4.5x4.5 NRP', { qty: 3 }),
      makeItem('Hinges 5BB1 4.5x4.5 CON TW8', { qty: 1 }),
    ]
    const { leaf1, leaf2 } = groupItemsByLeaf(items, 1)
    expect(leaf1).toHaveLength(2)
    expect(leaf1[0].qty).toBe(3) // unchanged — no adjustment on single doors
    expect(leaf1[1].qty).toBe(1)
    expect(leaf2).toHaveLength(0)
  })

  it('pair door: standard hinges only — no qty adjustment', () => {
    // No electric hinges in the set → electricHingeQty is 0, no adjustment.
    const items = [
      makeItem('Hinges 5BB1 4.5x4.5 NRP', { qty: 4 }),
    ]
    const { leaf1, leaf2 } = groupItemsByLeaf(items, 2)
    expect(leaf1).toHaveLength(1)
    expect(leaf1[0].qty).toBe(4) // unchanged
    expect(leaf2).toHaveLength(1)
    expect(leaf2[0].qty).toBe(4) // unchanged
  })

  it('does not adjust standard hinge qty when leaf_side is already set', () => {
    // After save, buildPerOpeningItems already split the qty correctly.
    // The pre-scan only counts items with null leaf_side, so persisted
    // electric hinges don't trigger the adjustment.
    const items = [
      makeItem('Hinges 5BB1 4.5x4.5 NRP', { qty: 3, leaf_side: 'active' }),
      makeItem('Hinges 5BB1 4.5x4.5 NRP', { qty: 4, leaf_side: 'inactive' }),
      makeItem('Hinges 5BB1 4.5x4.5 CON TW8', { qty: 1, leaf_side: 'active' }),
    ]
    const { leaf1, leaf2 } = groupItemsByLeaf(items, 2)
    expect(leaf1).toHaveLength(2)
    expect(leaf1[0].qty).toBe(3) // already correct from save path, not further reduced
    expect(leaf2).toHaveLength(1)
    expect(leaf2[0].qty).toBe(4)
  })
})

describe('groupItemsByLeaf — real PDF data with split name/model fields', () => {
  it('pair door: electric hinge detected from model field (name="Hinges", model="...CON TW8")', () => {
    // Real PDF extraction: name is generic "Hinges", model has the "CON TW8" identifier.
    // Without the name+model fix, this electric hinge would be misclassified as generic
    // hinges and appear on both leaves instead of active only.
    const items = [
      makeItem('Hinges', { qty: 4, model: '5BB1 HW 4 1/2 x 4 1/2 NRP' }),           // standard
      makeItem('Hinges', { qty: 1, model: '5BB1 HW 4 1/2 x 4 1/2 CON TW8' }),       // electric
    ]
    const { shared, leaf1, leaf2 } = groupItemsByLeaf(items, 2)
    expect(shared).toHaveLength(0)
    // Active leaf: 3 standard (4-1) + 1 electric = 2 items
    expect(leaf1).toHaveLength(2)
    expect(leaf1[0].qty).toBe(3)   // standard: 4 - 1 electric = 3
    expect(leaf1[1].qty).toBe(1)   // electric hinge
    // Inactive leaf: full standard qty, no electric
    expect(leaf2).toHaveLength(1)
    expect(leaf2[0].qty).toBe(4)
  })

  it('single door: electric hinge from model field routes to leaf1 (no adjustment)', () => {
    const items = [
      makeItem('Hinges', { qty: 3, model: '5BB1 HW 4 1/2 x 4 1/2 NRP' }),
      makeItem('Hinges', { qty: 1, model: '5BB1 HW 4 1/2 x 4 1/2 CON TW8' }),
    ]
    const { leaf1, leaf2 } = groupItemsByLeaf(items, 1)
    expect(leaf1).toHaveLength(2)
    expect(leaf1[0].qty).toBe(3)   // unchanged on single doors
    expect(leaf1[1].qty).toBe(1)
    expect(leaf2).toHaveLength(0)
  })
})

// ── itemsIndicatePair — door detail UI fail-safe ─────────────────────────────
//
// The door detail page (src/app/project/[projectId]/door/[doorId]/page.tsx)
// uses this helper to detect when `opening.hardware_items` carry the
// unambiguous pair signal (leaf_side='inactive') despite
// `opening.leaf_count=1`. When true, the UI renders Shared/Leaf-1/Leaf-2
// tabs as a fail-safe and logs a disagreement breadcrumb to Sentry. See
// 2026-04-18 Radius DC regression.
//
// 'active' is deliberately NOT a trigger: single doors carry a bare "Door"
// row with leaf_side='active' by design (parse-pdf-helpers.ts:2746).

describe('itemsIndicatePair — door detail UI fail-safe', () => {
  it('returns true only when at least one item is leaf_side="inactive"', () => {
    const items = [
      makeItem('Door (Inactive Leaf)', { leaf_side: 'inactive' }),
    ]
    expect(itemsIndicatePair(items)).toBe(true)
  })

  it('returns false when only leaf_side="active" items are present (single-door shape)', () => {
    // CRITICAL: single-door bare "Door" rows are stamped leaf_side='active'.
    // If this returned true, every single-door page would wrongly show
    // Shared/Leaf-1/Leaf-2 tabs.
    const items = [makeItem('Door', { leaf_side: 'active' })]
    expect(itemsIndicatePair(items)).toBe(false)
  })

  it('returns false when all items are "shared" or "active" (single-door shape)', () => {
    const items = [
      makeItem('Door', { leaf_side: 'active' }),
      makeItem('Frame', { leaf_side: 'shared' }),
    ]
    expect(itemsIndicatePair(items)).toBe(false)
  })

  it('returns true on the canonical Radius DC bug shape (Active + Inactive pair)', () => {
    const items = [
      makeItem('Door (Active Leaf)', { leaf_side: 'active' }),
      makeItem('Door (Inactive Leaf)', { leaf_side: 'inactive' }),
    ]
    expect(itemsIndicatePair(items)).toBe(true)
  })

  it('treats "both" as not a pair signal', () => {
    const items = [makeItem('Wire', { leaf_side: 'both' })]
    expect(itemsIndicatePair(items)).toBe(false)
  })

  it('empty items array returns false', () => {
    expect(itemsIndicatePair([])).toBe(false)
  })
})

// ── Door detail page: leafCount derivation fail-safe ────────────────────────
//
// The door detail page computes:
//   leafCount = Math.max(backendLeafCount, itemsSuggestPair ? 2 : 1)
// This test locks down the derivation so a single backend miscompute
// (2026-04-18 Radius DC regression) can never hide Shared/Leaf-1/Leaf-2.

describe('door detail page: leafCount derivation locks out Radius DC regression', () => {
  // Pure extract of the one-line derivation in page.tsx so unit tests can
  // pin it down without booting jsdom/RTL (not installed in this repo).
  function deriveLeafCount(backendLeafCount: number, hardwareItems: LeafGroupableItem[]): number {
    return Math.max(backendLeafCount, itemsIndicatePair(hardwareItems) ? 2 : 1)
  }

  it('backend says 1 AND inactive-leaf item exists → UI treats as pair (Radius DC fail-safe)', () => {
    const items = [
      makeItem('Door (Active Leaf)', { leaf_side: 'active' }),
      makeItem('Door (Inactive Leaf)', { leaf_side: 'inactive' }),
    ]
    expect(deriveLeafCount(1, items)).toBe(2)
  })

  it('backend says 1 AND only a bare Door with leaf_side=active → UI renders single-door view', () => {
    // This is the shape buildPerOpeningItems emits for single doors. Must
    // NOT be promoted to pair or every single door breaks.
    const items = [makeItem('Door', { leaf_side: 'active' })]
    expect(deriveLeafCount(1, items)).toBe(1)
  })

  it('backend says 2 AND items carry active/inactive → UI renders pair (agreement)', () => {
    const items = [
      makeItem('Door (Active Leaf)', { leaf_side: 'active' }),
      makeItem('Door (Inactive Leaf)', { leaf_side: 'inactive' }),
    ]
    expect(deriveLeafCount(2, items)).toBe(2)
  })

  it('backend says 2 AND no leaf_side items → UI still trusts backend pair signal', () => {
    const items = [makeItem('Hinge', { leaf_side: undefined })]
    expect(deriveLeafCount(2, items)).toBe(2)
  })
})
