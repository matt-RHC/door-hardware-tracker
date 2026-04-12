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
})
