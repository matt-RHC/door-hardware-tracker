import { describe, it, expect } from 'vitest'
import { getDeepExtractionPrompt } from './punchy-prompts'

describe('getDeepExtractionPrompt', () => {
  it('omits the USER GUIDANCE block when no hint is provided', () => {
    const prompt = getDeepExtractionPrompt()
    expect(prompt).not.toContain('USER GUIDANCE')
  })

  it('omits the USER GUIDANCE block for empty / whitespace hints', () => {
    expect(getDeepExtractionPrompt('')).not.toContain('USER GUIDANCE')
    expect(getDeepExtractionPrompt('   ')).not.toContain('USER GUIDANCE')
    expect(getDeepExtractionPrompt('\n\t  \n')).not.toContain('USER GUIDANCE')
  })

  it('injects the hint verbatim and the anti-fabrication reminder when present', () => {
    const prompt = getDeepExtractionPrompt('this set is on page 18')
    expect(prompt).toContain('USER GUIDANCE')
    expect(prompt).toContain('this set is on page 18')
    expect(prompt).toContain('Do NOT fabricate')
  })

  it('trims surrounding whitespace before injecting the hint', () => {
    const prompt = getDeepExtractionPrompt('   look on pages 47-52   ')
    expect(prompt).toContain('"look on pages 47-52"')
    // No leading/trailing whitespace inside the quoted hint.
    expect(prompt).not.toContain('"   look on pages 47-52')
  })

  it('still includes the rest of the deep-extraction prompt when a hint is present', () => {
    const prompt = getDeepExtractionPrompt('a hint')
    // Spot-check that the core task instructions still survive the injection.
    expect(prompt).toContain('SEARCH STRATEGY')
    expect(prompt).toContain('EXTRACTION RULES')
    expect(prompt).toContain('SET ID FORMATS')
  })
})
