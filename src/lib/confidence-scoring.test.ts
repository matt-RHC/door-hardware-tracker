import { describe, it, expect } from 'vitest'
import { scoreField, scoreDoor, scoreExtraction } from './confidence-scoring'

describe('scoreField', () => {
  it('scores a present, pattern-matching value high', () => {
    const score = scoreField('door_number', '110-01A', { completeness: 1.0 })
    // parser_match (0.4) + cross_field (0.25) + completeness (0.25) = 0.9
    expect(score).toBeGreaterThanOrEqual(0.85)
  })

  it('scores a missing value at zero for parser_match', () => {
    const score = scoreField('door_number', '', { completeness: 0 })
    // parser_match = 0, cross_field = 0 (has pattern, value empty), completeness = 0
    expect(score).toBeLessThan(0.15)
  })

  it('scores a present but non-matching value moderately', () => {
    // "LOBBY" doesn't match door_number pattern but is non-empty
    const score = scoreField('door_number', 'LOBBY', { completeness: 0.5 })
    // parser_match (0.4) + cross_field (0.3 * 0.25) + completeness (0.5 * 0.25) = 0.6
    expect(score).toBeGreaterThan(0.4)
    expect(score).toBeLessThan(0.85)
  })

  it('gives known format bonus when set', () => {
    const without = scoreField('hw_set', 'DH1', { knownFormat: false, completeness: 0.5 })
    const withBonus = scoreField('hw_set', 'DH1', { knownFormat: true, completeness: 0.5 })
    expect(withBonus).toBeGreaterThan(without)
    expect(withBonus - without).toBeCloseTo(0.10, 1) // W_KNOWN_FORMAT = 0.10
  })

  it('uses neutral cross_field for fields without a pattern', () => {
    // "location" has no pattern in FIELD_PATTERNS
    const score = scoreField('location', 'Room 101', { completeness: 0.5 })
    // parser_match (0.4) + cross_field (0.5 * 0.25 = 0.125) + completeness (0.5 * 0.25 = 0.125) = 0.65
    expect(score).toBeGreaterThan(0.5)
  })
})

describe('scoreDoor', () => {
  it('scores a complete door highly', () => {
    const door = {
      door_number: '110-01A',
      hw_set: 'DH1',
      location: 'Office',
      door_type: 'WD',
      frame_type: 'HM',
      fire_rating: '20Min',
      hand: 'LHR',
    }
    const scores = scoreDoor(door)
    const avg = Object.values(scores).reduce((a, b) => a + b, 0) / Object.values(scores).length
    expect(avg).toBeGreaterThan(0.75)
  })

  it('scores a sparse door lower', () => {
    const door = {
      door_number: '101',
      hw_set: '',
      location: '',
      door_type: '',
      frame_type: '',
      fire_rating: '',
      hand: '',
    }
    const scores = scoreDoor(door)
    const avg = Object.values(scores).reduce((a, b) => a + b, 0) / Object.values(scores).length
    expect(avg).toBeLessThan(0.5)
  })

  it('returns scores for all 7 fields', () => {
    const door = {
      door_number: '100',
      hw_set: 'DH1',
      location: '',
      door_type: '',
      frame_type: '',
      fire_rating: '',
      hand: '',
    }
    const scores = scoreDoor(door)
    expect(Object.keys(scores)).toHaveLength(7)
    expect(scores).toHaveProperty('door_number')
    expect(scores).toHaveProperty('hw_set')
    expect(scores).toHaveProperty('fire_rating')
  })
})

describe('scoreExtraction', () => {
  it('returns per-door scores and an average', () => {
    const doors = [
      { door_number: '101', hw_set: 'DH1', location: 'Lobby', door_type: 'WD', frame_type: 'HM', fire_rating: '20Min', hand: 'LHR' },
      { door_number: '102', hw_set: 'DH2', location: '', door_type: '', frame_type: '', fire_rating: '', hand: '' },
    ]
    const { perDoor, average } = scoreExtraction(doors)
    expect(perDoor.size).toBe(2)
    expect(perDoor.has('101')).toBe(true)
    expect(perDoor.has('102')).toBe(true)
    expect(average).toBeGreaterThan(0)
    expect(average).toBeLessThan(1)
  })

  it('returns zero average for empty input', () => {
    const { perDoor, average } = scoreExtraction([])
    expect(perDoor.size).toBe(0)
    expect(average).toBe(0)
  })
})
