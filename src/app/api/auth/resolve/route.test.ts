import { describe, it, expect } from 'vitest'
import { providerForDomain, resolveProviderForDomain } from './route'

// Pure-function tests for the provider-selection logic. The full POST
// handler (Supabase lookup, rate limit, identity check) is covered by the
// RLS integration job; keeping these as pure unit tests lets them run in
// the `test-ts` CI job without any Supabase fixture.

describe('providerForDomain — regex heuristic', () => {
  it('routes *.onmicrosoft.com to azure', () => {
    expect(providerForDomain('contoso.onmicrosoft.com')).toBe('azure')
    expect(providerForDomain('foo.bar.onmicrosoft.com')).toBe('azure')
  })

  it('defaults everything else to google', () => {
    expect(providerForDomain('rabbitholeconsultants.com')).toBe('google')
    expect(providerForDomain('dpr.com')).toBe('google')
    expect(providerForDomain('anything.example')).toBe('google')
  })
})

describe('resolveProviderForDomain — preferred_provider override', () => {
  it('returns the explicit override when set to azure', () => {
    // DPR.com is the canonical motivating case: Microsoft 365 shop whose
    // vanity domain the regex heuristic would mis-route to google.
    expect(resolveProviderForDomain('dpr.com', 'azure')).toBe('azure')
  })

  it('returns the explicit override when set to google', () => {
    // Override must also win over the onmicrosoft.com heuristic — an
    // admin who has pinned their tenant domain to google should be
    // honoured even if the heuristic would have returned azure.
    expect(resolveProviderForDomain('foo.onmicrosoft.com', 'google')).toBe('google')
  })

  it('falls back to the regex heuristic when preferred_provider is null', () => {
    expect(resolveProviderForDomain('dpr.com', null)).toBe(providerForDomain('dpr.com'))
    expect(resolveProviderForDomain('dpr.com', null)).toBe('google')
  })

  it('falls back to the regex heuristic when preferred_provider is undefined', () => {
    expect(resolveProviderForDomain('contoso.onmicrosoft.com', undefined)).toBe('azure')
  })
})
