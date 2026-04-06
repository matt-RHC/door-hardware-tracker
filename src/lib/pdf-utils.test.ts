import { describe, it, expect } from 'vitest'
import {
  arrayBufferToBase64,
  normalizeItemName,
  deduplicateHardwareItems,
  mergeHardwareSets,
  mergeDoors,
  CHUNK_SIZE_THRESHOLD,
  FALLBACK_PAGES_PER_CHUNK,
  type HardwareItem,
  type HardwareSet,
  type DoorEntry,
} from './pdf-utils'

describe('constants', () => {
  it('CHUNK_SIZE_THRESHOLD is 3MB', () => {
    expect(CHUNK_SIZE_THRESHOLD).toBe(3 * 1024 * 1024)
  })

  it('FALLBACK_PAGES_PER_CHUNK is 35', () => {
    expect(FALLBACK_PAGES_PER_CHUNK).toBe(35)
  })
})

describe('arrayBufferToBase64', () => {
  it('encodes a small buffer correctly', () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]) // "Hello"
    const result = arrayBufferToBase64(bytes)
    expect(result).toBe(btoa('Hello'))
  })

  it('accepts ArrayBuffer input', () => {
    const buffer = new Uint8Array([65, 66, 67]).buffer // "ABC"
    const result = arrayBufferToBase64(buffer)
    expect(result).toBe(btoa('ABC'))
  })

  it('handles empty buffer', () => {
    const result = arrayBufferToBase64(new Uint8Array(0))
    expect(result).toBe('')
  })

  it('handles buffer larger than 8KB chunk size', () => {
    // Create a 10KB buffer of repeated bytes
    const size = 10 * 1024
    const bytes = new Uint8Array(size)
    for (let i = 0; i < size; i++) {
      bytes[i] = i % 256
    }
    const result = arrayBufferToBase64(bytes)
    // Verify it's valid base64 by decoding
    const decoded = atob(result)
    expect(decoded.length).toBe(size)
    expect(decoded.charCodeAt(0)).toBe(0)
    expect(decoded.charCodeAt(255)).toBe(255)
  })
})

describe('normalizeItemName', () => {
  it('lowercases and trims', () => {
    expect(normalizeItemName('  Closer  ')).toBe('closer')
  })

  it('expands abbreviations (without period)', () => {
    expect(normalizeItemName('Cont Hinge')).toBe('continuous hinge')
  })

  it('expands w/ to with', () => {
    expect(normalizeItemName('Door w/ Closer')).toBe('door with closer')
  })

  it('expands floor abbreviation (without period)', () => {
    expect(normalizeItemName('Flr Stop')).toBe('floor stop')
  })

  it('expands floor abbreviation (with period key)', () => {
    // "flr." → word boundary after dot doesn't match mid-string,
    // but "flr" key matches → "floor." remains
    expect(normalizeItemName('Flr. Stop')).toBe('floor. stop')
  })

  it('removes trailing punctuation', () => {
    expect(normalizeItemName('Closer,')).toBe('closer')
    expect(normalizeItemName('Stop;')).toBe('stop')
    expect(normalizeItemName('Hinge.')).toBe('hinge')
  })

  it('removes parentheses', () => {
    expect(normalizeItemName('Closer (overhead)')).toBe('closer overhead')
  })

  it('normalizes multiple spaces', () => {
    expect(normalizeItemName('Door   Closer')).toBe('door closer')
  })
})

describe('deduplicateHardwareItems', () => {
  const makeItem = (overrides: Partial<HardwareItem> = {}): HardwareItem => ({
    qty: 1,
    name: 'Closer',
    model: '',
    finish: '',
    manufacturer: '',
    ...overrides,
  })

  it('removes exact duplicates by name', () => {
    const items = [makeItem({ name: 'Closer' }), makeItem({ name: 'Closer' })]
    const result = deduplicateHardwareItems(items)
    expect(result).toHaveLength(1)
  })

  it('deduplicates by model when present', () => {
    const items = [
      makeItem({ name: 'Closer', model: '4040XP' }),
      makeItem({ name: 'Door Closer', model: '4040XP' }),
    ]
    const result = deduplicateHardwareItems(items)
    expect(result).toHaveLength(1)
  })

  it('keeps version with more complete data', () => {
    const items = [
      makeItem({ name: 'Closer', model: '4040XP' }),
      makeItem({ name: 'Closer', model: '4040XP', manufacturer: 'LCN', finish: '689' }),
    ]
    const result = deduplicateHardwareItems(items)
    expect(result).toHaveLength(1)
    expect(result[0].manufacturer).toBe('LCN')
    expect(result[0].finish).toBe('689')
  })

  it('keeps distinct items', () => {
    const items = [
      makeItem({ name: 'Closer', model: '4040XP' }),
      makeItem({ name: 'Hinge', model: '5BB1' }),
    ]
    const result = deduplicateHardwareItems(items)
    expect(result).toHaveLength(2)
  })

  it('deduplicates by normalized name when no model', () => {
    // Both normalize to the same key when abbreviation matches cleanly
    const items = [
      makeItem({ name: 'Cont Hinge' }),
      makeItem({ name: 'Continuous Hinge' }),
    ]
    const result = deduplicateHardwareItems(items)
    expect(result).toHaveLength(1)
  })
})

describe('mergeHardwareSets', () => {
  const makeSet = (overrides: Partial<HardwareSet> = {}): HardwareSet => ({
    set_id: 'DH1',
    heading: 'Single Door',
    items: [{ qty: 3, name: 'Hinge', model: '5BB1', finish: '626', manufacturer: 'Ives' }],
    ...overrides,
  })

  it('keeps unique sets as-is', () => {
    const sets = [makeSet({ set_id: 'DH1' }), makeSet({ set_id: 'DH2' })]
    const result = mergeHardwareSets(sets)
    expect(result).toHaveLength(2)
  })

  it('merges items from duplicate set_ids', () => {
    const sets = [
      makeSet({ set_id: 'DH1', items: [{ qty: 3, name: 'Hinge', model: '5BB1', finish: '626', manufacturer: 'Ives' }] }),
      makeSet({ set_id: 'DH1', items: [{ qty: 1, name: 'Closer', model: '4040XP', finish: '689', manufacturer: 'LCN' }] }),
    ]
    const result = mergeHardwareSets(sets)
    expect(result).toHaveLength(1)
    expect(result[0].items).toHaveLength(2)
  })

  it('deduplicates items within merged sets', () => {
    const hinge: HardwareItem = { qty: 3, name: 'Hinge', model: '5BB1', finish: '626', manufacturer: 'Ives' }
    const sets = [
      makeSet({ set_id: 'DH1', items: [hinge] }),
      makeSet({ set_id: 'DH1', items: [{ ...hinge }] }), // same item from another chunk
    ]
    const result = mergeHardwareSets(sets)
    expect(result).toHaveLength(1)
    expect(result[0].items).toHaveLength(1) // deduped
  })

  it('keeps the longer heading', () => {
    const sets = [
      makeSet({ set_id: 'DH1', heading: 'Door' }),
      makeSet({ set_id: 'DH1', heading: 'Single Door 20Min' }),
    ]
    const result = mergeHardwareSets(sets)
    expect(result[0].heading).toBe('Single Door 20Min')
  })

  it('handles empty input', () => {
    expect(mergeHardwareSets([])).toHaveLength(0)
  })
})

describe('mergeDoors', () => {
  const makeDoor = (overrides: Partial<DoorEntry> = {}): DoorEntry => ({
    door_number: '101',
    hw_set: 'DH1',
    location: 'Lobby',
    door_type: 'WD',
    frame_type: 'HM',
    fire_rating: '20Min',
    hand: 'LHR',
    ...overrides,
  })

  it('removes duplicate door_numbers', () => {
    const doors = [makeDoor({ door_number: '101' }), makeDoor({ door_number: '101' })]
    const result = mergeDoors(doors)
    expect(result).toHaveLength(1)
  })

  it('keeps first occurrence', () => {
    const doors = [
      makeDoor({ door_number: '101', location: 'Lobby' }),
      makeDoor({ door_number: '101', location: 'Office' }),
    ]
    const result = mergeDoors(doors)
    expect(result[0].location).toBe('Lobby')
  })

  it('keeps all unique doors', () => {
    const doors = [
      makeDoor({ door_number: '101' }),
      makeDoor({ door_number: '102' }),
      makeDoor({ door_number: '103' }),
    ]
    const result = mergeDoors(doors)
    expect(result).toHaveLength(3)
  })

  it('handles empty input', () => {
    expect(mergeDoors([])).toHaveLength(0)
  })
})
