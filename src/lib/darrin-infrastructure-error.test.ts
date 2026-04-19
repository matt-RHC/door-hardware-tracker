/**
 * Tests for classifyDarrinInfrastructureError.
 *
 * Goal: pin down the substring patterns that cause a Darrin API error
 * to be escalated to a Sentry.captureMessage (and in the 'credit_balance'
 * and 'auth' cases, a fatal-level alert that pages on-call).
 *
 * A FALSE POSITIVE here fires a fatal alert on a normal extraction
 * error. A FALSE NEGATIVE lets a billing/config problem silently
 * degrade extraction for every user. Both matter — tests lean toward
 * being specific over lenient.
 *
 * Patterns come from real Anthropic SDK error bodies observed in
 * `darrin_logs.response.error` during the April 2026 incident where
 * 60% of Darrin calls failed silently for ~24 hours.
 */

import { describe, it, expect } from 'vitest'
import { classifyDarrinInfrastructureError } from './parse-pdf-helpers'

describe('classifyDarrinInfrastructureError', () => {
  // ── credit_balance ────────────────────────────────────────────────

  it('recognizes the real credit-balance error body', () => {
    // Verbatim from darrin_logs response.error column — April 2026.
    const msg =
      '400 {"type":"error","error":{"type":"invalid_request_error",'
      + '"message":"Your credit balance is too low to access the '
      + 'Anthropic API. Please go to Plans & Billing to upgrade or '
      + 'purchase credits."},"request_id":"req_011CaBN9h511PB67CMbfZLyF"}'
    expect(classifyDarrinInfrastructureError(msg)).toBe('credit_balance')
  })

  it('is case-insensitive on credit-balance detection', () => {
    expect(classifyDarrinInfrastructureError('CREDIT BALANCE IS TOO LOW')).toBe('credit_balance')
  })

  // ── rate_limit ────────────────────────────────────────────────────

  it('recognizes rate_limit_error', () => {
    const msg = '{"error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}'
    expect(classifyDarrinInfrastructureError(msg)).toBe('rate_limit')
  })

  it('recognizes rate_limit_exceeded variant', () => {
    expect(classifyDarrinInfrastructureError('rate_limit_exceeded on requests')).toBe('rate_limit')
  })

  // ── context_length ────────────────────────────────────────────────

  it('recognizes "prompt is too long" overflow (the 211k-token case)', () => {
    const msg =
      '400 {"type":"error","error":{"type":"invalid_request_error",'
      + '"message":"prompt is too long: 211811 tokens > 200000 maximum"}}'
    expect(classifyDarrinInfrastructureError(msg)).toBe('context_length')
  })

  it('recognizes max_tokens variant', () => {
    expect(classifyDarrinInfrastructureError('max_tokens exceeded')).toBe('context_length')
  })

  // ── auth ──────────────────────────────────────────────────────────

  it('recognizes invalid-key errors', () => {
    const msg = '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}'
    expect(classifyDarrinInfrastructureError(msg)).toBe('auth')
  })

  it('recognizes authentication_error type without the key phrase', () => {
    expect(classifyDarrinInfrastructureError('authentication_error: not allowed')).toBe('auth')
  })

  it('recognizes permission_error', () => {
    expect(classifyDarrinInfrastructureError('permission_error on this workspace')).toBe('auth')
  })

  // ── null (normal extraction errors — must NOT fire alerts) ────────

  it('returns null for generic SDK network errors', () => {
    expect(classifyDarrinInfrastructureError('fetch failed: ECONNRESET')).toBeNull()
    expect(classifyDarrinInfrastructureError('socket hang up')).toBeNull()
  })

  it('returns null for Darrin-side parse errors', () => {
    // The caller already handles these — we don't want to alert on them.
    expect(classifyDarrinInfrastructureError('LLM returned non-JSON response: ...')).toBeNull()
    expect(classifyDarrinInfrastructureError('Darrin returned no text')).toBeNull()
  })

  it('returns null for 500-ish transient errors', () => {
    // Anthropic has internal 529 (overloaded) / 500 — transient, retries
    // will recover. Don't want a fatal alert for these.
    expect(classifyDarrinInfrastructureError('overloaded_error: please retry')).toBeNull()
    expect(classifyDarrinInfrastructureError('internal_server_error')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(classifyDarrinInfrastructureError('')).toBeNull()
  })

  it('does NOT match substrings in unrelated sentences', () => {
    // Defensive — make sure "credit" on its own doesn't trigger.
    expect(classifyDarrinInfrastructureError('credit card accepted')).toBeNull()
    expect(classifyDarrinInfrastructureError('permission granted')).toBeNull()
  })
})
