import { describe, it, expect } from 'vitest'
import { groupItemsByLeaf, type LeafGroupableItem } from './classify-leaf-items'

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
