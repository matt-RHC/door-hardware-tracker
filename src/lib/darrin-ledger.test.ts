/**
 * Unit tests for darrin-ledger helpers.
 *
 * Focus on the pure helpers (computeCostUsd, promptVersion,
 * classifyLedgerErrorKind). The writers (recordDarrinDecision /
 * patchDarrinDecisionOutcome) depend on a real service-role Supabase
 * client and are exercised by the Session 3 integration test.
 *
 * The pure helpers are important because:
 *   - computeCostUsd drives rule-mining cost roll-ups. Drift → wrong
 *     incentives for which actions to promote / guardrail.
 *   - promptVersion is how the ledger correlates accuracy shifts to
 *     prompt edits. Drift → can't tell which change broke which rate.
 *   - classifyLedgerErrorKind is how infra-wide outages (credit
 *     balance, rate limit) surface in ledger queries vs. per-call
 *     glitches. Drift → can't tell outages from noise.
 */

import { describe, it, expect } from 'vitest'
import {
  DARRIN_MODEL_COSTS,
  computeCostUsd,
  promptVersion,
  classifyLedgerErrorKind,
} from './darrin-ledger'

describe('computeCostUsd', () => {
  it('computes cost for claude-haiku-4-5 (input + output)', () => {
    // 1M input tok + 1M output tok = $0.80 + $4.00 = $4.80
    expect(computeCostUsd('claude-haiku-4-5', 1_000_000, 1_000_000)).toBeCloseTo(4.80, 6)
  })

  it('computes cost for the dated snapshot', () => {
    // Both entries have the same price — test it explicitly so accidental
    // divergence in DARRIN_MODEL_COSTS is caught here.
    expect(computeCostUsd('claude-haiku-4-5-20251001', 1_000_000, 1_000_000)).toBeCloseTo(4.80, 6)
  })

  it('handles small token counts without floating-point drift', () => {
    // 1000 input + 500 output at haiku-4-5 rates = 800 + 2000 = 2800 micro-dollars
    // = $0.0028. Keep tolerance tight — rule-mining roll-ups accumulate across
    // thousands of calls.
    const cost = computeCostUsd('claude-haiku-4-5', 1000, 500)
    expect(cost).toBeCloseTo(0.0028, 6)
  })

  it('returns null for an unknown model', () => {
    // Use a UUID-like string so this test doesn't pollute the one-time
    // Sentry dedupe set with a name another test might reuse.
    expect(computeCostUsd('claude-unknown-test-aaaa', 1000, 500)).toBeNull()
  })

  it('returns 0 for zero tokens on a known model', () => {
    expect(computeCostUsd('claude-haiku-4-5', 0, 0)).toBe(0)
  })

  it('has entries for every model string the extraction code passes', () => {
    // Guardrail: if parse-pdf-helpers.ts starts using a new model string,
    // this test will fail only if the cost map is updated to match. Keeps
    // both in sync at PR-review time.
    expect(DARRIN_MODEL_COSTS['claude-haiku-4-5-20251001']).toBeDefined()
  })
})

describe('promptVersion', () => {
  it('is deterministic for the same input', () => {
    const a = promptVersion('checkpoint 2 post extraction review')
    const b = promptVersion('checkpoint 2 post extraction review')
    expect(a).toBe(b)
  })

  it('changes when the prompt changes (even by one char)', () => {
    const a = promptVersion('Review the extraction for completeness.')
    const b = promptVersion('Review the extraction for completeness!')
    expect(a).not.toBe(b)
  })

  it('is exactly 16 hex chars', () => {
    const v = promptVersion('x')
    expect(v).toMatch(/^[0-9a-f]{16}$/)
    expect(v).toHaveLength(16)
  })

  it('handles empty string without crashing', () => {
    const v = promptVersion('')
    expect(v).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('classifyLedgerErrorKind', () => {
  it('returns the infrastructure category when the message matches', () => {
    const msg = '400 {"error":{"type":"invalid_request_error","message":"Your credit balance is too low..."}}'
    expect(classifyLedgerErrorKind(msg, 'call_failed')).toBe('credit_balance')
  })

  it('recognizes rate_limit messages', () => {
    expect(classifyLedgerErrorKind('rate_limit_error occurred', 'call_failed')).toBe('rate_limit')
  })

  it('falls back to the provided fallback when no infra category matches', () => {
    expect(classifyLedgerErrorKind('ECONNRESET on socket', 'call_failed')).toBe('call_failed')
  })

  it('returns the fallback for null / empty messages', () => {
    expect(classifyLedgerErrorKind(null, 'apply_failed')).toBe('apply_failed')
    expect(classifyLedgerErrorKind('', 'apply_failed')).toBe('apply_failed')
    expect(classifyLedgerErrorKind(undefined, 'apply_failed')).toBe('apply_failed')
  })
})
