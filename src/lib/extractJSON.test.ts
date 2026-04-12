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

  it('returns null on pure prose with no JSON', () => {
    const result = extractJSON('I could not find any hardware sets. Please try a different PDF.')
    expect(result).toBeNull()
  })

  it('extracts JSON from unlabeled code block', () => {
    const input = '```\n{"data": true}\n```'
    const result = extractJSON(input) as { data: boolean }
    expect(result.data).toBe(true)
  })

  it('returns null on empty string', () => {
    expect(extractJSON('')).toBeNull()
  })

  it('returns null on whitespace-only string', () => {
    expect(extractJSON('   \n\t  ')).toBeNull()
  })

  it('extracts JSON with trailing prose after the object', () => {
    const input = '{"overall_confidence": "medium", "notes": "Looks good"}\n\nHere are some additional thoughts about the extraction.'
    const result = extractJSON(input) as { overall_confidence: string }
    expect(result.overall_confidence).toBe('medium')
  })

  it('extracts JSON with leading prose before the object', () => {
    const input = 'Here is my review:\n\n{"flags": [], "notes": "All clear"}'
    const result = extractJSON(input) as { flags: unknown[]; notes: string }
    expect(result.flags).toEqual([])
    expect(result.notes).toBe('All clear')
  })

  it('extracts JSON from code fence with trailing prose', () => {
    const input = 'Results:\n```json\n{"set_id": "DH1", "items": []}\n```\nLet me know if you have questions!'
    const result = extractJSON(input) as { set_id: string }
    expect(result.set_id).toBe('DH1')
  })

  it('returns null on malformed JSON (unbalanced braces)', () => {
    const result = extractJSON('{"broken": true, "missing_close')
    expect(result).toBeNull()
  })
})
