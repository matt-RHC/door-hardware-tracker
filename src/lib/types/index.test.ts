import { describe, it, expect } from 'vitest'
import { toDarrinConfidence } from './index'

describe('toDarrinConfidence', () => {
  it('accepts the three valid union members', () => {
    expect(toDarrinConfidence('high')).toBe('high')
    expect(toDarrinConfidence('medium')).toBe('medium')
    expect(toDarrinConfidence('low')).toBe('low')
  })

  it('coerces unknown strings to the default', () => {
    expect(toDarrinConfidence('fair')).toBe('medium')
    expect(toDarrinConfidence('unknown')).toBe('medium')
    expect(toDarrinConfidence('HIGH')).toBe('medium') // case-sensitive by design
  })

  it('coerces nullish and non-string values to the default', () => {
    expect(toDarrinConfidence(undefined)).toBe('medium')
    expect(toDarrinConfidence(null)).toBe('medium')
    expect(toDarrinConfidence(0)).toBe('medium')
    expect(toDarrinConfidence({})).toBe('medium')
  })

  it('honours a caller-supplied fallback', () => {
    expect(toDarrinConfidence('bogus', 'low')).toBe('low')
    expect(toDarrinConfidence(undefined, 'high')).toBe('high')
  })
})
