import { describe, it, expect } from 'vitest'
import { extractFireRatings, type DoorEntry } from './fire-rating'

function makeDoor(overrides: Partial<DoorEntry> = {}): DoorEntry {
  return {
    door_number: '101',
    hw_set: 'DH1',
    hw_heading: '',
    location: '',
    door_type: 'WD',
    frame_type: 'HM',
    fire_rating: '',
    hand: 'LHR',
    ...overrides,
  }
}

describe('extractFireRatings', () => {
  it('extracts "20Min" from hw_heading', () => {
    const doors = [makeDoor({ hw_heading: 'Single Door 20Min' })]
    extractFireRatings(doors)
    expect(doors[0].fire_rating).toBe('20Min')
    expect(doors[0].hw_heading).toBe('Single Door')
  })

  it('extracts "90 Min" with space', () => {
    const doors = [makeDoor({ hw_heading: 'Pair 90 Min' })]
    extractFireRatings(doors)
    expect(doors[0].fire_rating).toBe('90 Min')
  })

  it('extracts "1Hr" from hw_heading', () => {
    const doors = [makeDoor({ hw_heading: 'Stairwell 1Hr' })]
    extractFireRatings(doors)
    expect(doors[0].fire_rating).toBe('1Hr')
  })

  it('extracts "3 Hr" with space', () => {
    const doors = [makeDoor({ hw_heading: 'Rated Wall 3 Hr' })]
    extractFireRatings(doors)
    expect(doors[0].fire_rating).toBe('3 Hr')
  })

  it('does not overwrite existing fire_rating', () => {
    const doors = [makeDoor({ fire_rating: '45Min', hw_heading: 'Door 20Min' })]
    extractFireRatings(doors)
    expect(doors[0].fire_rating).toBe('45Min')
    expect(doors[0].hw_heading).toBe('Door 20Min') // unchanged
  })

  it('falls back to location if hw_heading has no rating', () => {
    const doors = [makeDoor({ location: 'Lobby 60Min' })]
    extractFireRatings(doors)
    expect(doors[0].fire_rating).toBe('60Min')
    expect(doors[0].location).toBe('Lobby')
  })

  it('leaves doors unchanged if no rating found anywhere', () => {
    const doors = [makeDoor({ hw_heading: 'Storage Room', location: 'Floor 2' })]
    extractFireRatings(doors)
    expect(doors[0].fire_rating).toBe('')
    expect(doors[0].hw_heading).toBe('Storage Room')
    expect(doors[0].location).toBe('Floor 2')
  })

  it('extracts "90 Mins" with plural s', () => {
    const doors = [makeDoor({ hw_heading: 'Corridor 90 Mins' })]
    extractFireRatings(doors)
    expect(doors[0].fire_rating).toBe('90 Mins')
    expect(doors[0].hw_heading).toBe('Corridor')
  })

  it('extracts "60 Minutes" full word', () => {
    const doors = [makeDoor({ hw_heading: 'Stairwell 60 Minutes' })]
    extractFireRatings(doors)
    expect(doors[0].fire_rating).toBe('60 Minutes')
    expect(doors[0].hw_heading).toBe('Stairwell')
  })

  it('extracts "1 Hour" full word', () => {
    const doors = [makeDoor({ hw_heading: 'Fire Wall 1 Hour' })]
    extractFireRatings(doors)
    expect(doors[0].fire_rating).toBe('1 Hour')
    expect(doors[0].hw_heading).toBe('Fire Wall')
  })

  it('extracts "3 Hours" plural', () => {
    const doors = [makeDoor({ hw_heading: 'Vault 3 Hours' })]
    extractFireRatings(doors)
    expect(doors[0].fire_rating).toBe('3 Hours')
    expect(doors[0].hw_heading).toBe('Vault')
  })

  it('handles multiple doors in batch', () => {
    const doors = [
      makeDoor({ door_number: '101', hw_heading: 'Single 20Min' }),
      makeDoor({ door_number: '102', fire_rating: '90Min' }),
      makeDoor({ door_number: '103', location: 'Rated Area 1Hr' }),
    ]
    extractFireRatings(doors)
    expect(doors[0].fire_rating).toBe('20Min')
    expect(doors[1].fire_rating).toBe('90Min') // preserved
    expect(doors[2].fire_rating).toBe('1Hr')
  })
})
