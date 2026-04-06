import { describe, it, expect } from 'vitest'
import { extractJSON } from './extractJSON'

describe('extractJSON', () => {
  it('parses valid JSON directly', () => {
    const result = extractJSON('{"hardware_sets": []}')
    expect(result).toEqual({ hardware_sets: [] })
  })

  it('extracts JSON from markdown code block', () => {
    const input =
      'Here are the results:\n```json\n{"hardware_sets": [{"set_id": "DH1"}]}\n```\nLet me know if you need more.'
    const result = extractJSON(input) as { hardware_sets: Array<{ set_id: string }> }
    expect(result.hardware_sets[0].set_id).toBe('DH1')
  })

  it('extracts JSON from prose with embedded JSON', () => {
    const input =
      'I found the following hardware sets:\n\n{"hardware_sets": [{"set_id": "EX1", "heading": "Exterior"}]}'
    const result = extractJSON(input) as { hardware_sets: Array<{ set_id: string }> }
    expect(result.hardware_sets[0].set_id).toBe('EX1')
  })

  it('extracts JSON array', () => {
    const input = 'Results: [{"id": 1}, {"id": 2}]'
    const result = extractJSON(input) as Array<{ id: number }>
    expect(result).toHaveLength(2)
  })

  it('throws on pure prose with no JSON', () => {
    expect(() =>
      extractJSON('I could not find any hardware sets. Please try a different PDF.')
    ).toThrow('non-JSON response')
  })

  it('extracts JSON from unlabeled code block', () => {
    const input = '```\n{"data": true}\n```'
    const result = extractJSON(input) as { data: boolean }
    expect(result.data).toBe(true)
  })
})
