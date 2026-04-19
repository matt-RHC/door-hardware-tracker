/**
 * Darrin decisions ledger — per-decision observability writer.
 *
 * Complements `logDarrinCall` (in parse-pdf-helpers.ts) which persists one
 * row per Darrin API call to `darrin_logs`. This module writes one row per
 * ACTION inside that call (every add/remove/fix/group_question) to
 * `darrin_decisions`, so downstream accept-vs-reject rates are queryable
 * without code changes.
 *
 * Session 1: writer only. Call sites are instrumented in Session 2.
 *
 * Design:
 *   - Service-role writes via createAdminSupabaseClient (no RLS).
 *   - Fire-and-forget on errors — never throws, never blocks extraction.
 *   - recordDarrinDecision returns the new row id so patchDarrinDecisionOutcome
 *     can update it once the decision resolves (applied / rejected / error).
 *   - If the insert fails, returns null and emits a Sentry breadcrumb; the
 *     caller MUST treat a null id as "can't patch outcome" (no-op, don't throw).
 */

import { createHash } from 'crypto'
import * as Sentry from '@sentry/nextjs'
import { createAdminSupabaseClient } from './supabase/admin'
import {
  classifyDarrinInfrastructureError,
  type DarrinInfrastructureErrorCategory,
} from './parse-pdf-helpers'

// ─── Cost model ──────────────────────────────────────────────────────────

/**
 * Anthropic model prices (USD per million tokens). Verified against
 * https://docs.anthropic.com/en/docs/about-claude/pricing on 2026-04-18.
 * Re-verify when the @anthropic-ai/sdk version bumps or if cost_usd totals
 * on the debug view look off.
 */
export const DARRIN_MODEL_COSTS: Record<string, { inputPerMtok: number; outputPerMtok: number }> = {
  'claude-haiku-4-5': { inputPerMtok: 0.80, outputPerMtok: 4.00 },
  'claude-haiku-4-5-20251001': { inputPerMtok: 0.80, outputPerMtok: 4.00 },
}

// Prevent log spam: each unknown model string only warns once per process.
const loggedMissingCostModels = new Set<string>()

/**
 * Compute USD cost for a Darrin call. Returns null when the model is not
 * in DARRIN_MODEL_COSTS — emits a one-time Sentry breadcrumb per process
 * so model-id drift (e.g. a new haiku snapshot) surfaces on the dashboard
 * without flooding.
 */
export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing = DARRIN_MODEL_COSTS[model]
  if (!pricing) {
    if (!loggedMissingCostModels.has(model)) {
      loggedMissingCostModels.add(model)
      try {
        Sentry.captureMessage(`DARRIN_MODEL_COSTS missing entry for model "${model}"`, {
          level: 'warning',
          tags: { source: 'darrin-ledger' },
        })
      } catch {
        // Never let Sentry break the writer.
      }
    }
    return null
  }
  return (inputTokens * pricing.inputPerMtok + outputTokens * pricing.outputPerMtok) / 1_000_000
}

// ─── Prompt versioning ───────────────────────────────────────────────────

/**
 * Deterministic prompt fingerprint: sha256(promptString) truncated to the
 * first 16 hex chars. Cheap to compute, unique enough to correlate
 * accuracy shifts to prompt edits in the ledger.
 */
export function promptVersion(promptString: string): string {
  return createHash('sha256').update(promptString).digest('hex').slice(0, 16)
}

// ─── Writer ──────────────────────────────────────────────────────────────

/** Fixed enums mirroring the CHECK constraints on darrin_decisions. */
export type DarrinCheckpoint = 'CP1' | 'CP2' | 'CP3'

export type DarrinLane = 'hardware' | 'opening' | 'leaf' | 'frame'

export type DarrinAction =
  | 'add'
  | 'remove'
  | 'fix'
  | 'infill'
  | 'group_question'
  | 'no_change'

export type DarrinOutcome =
  | 'proposed'
  | 'auto_applied'
  | 'auto_applied_partial'
  | 'user_accepted'
  | 'user_rejected'
  | 'user_edited'
  | 'superseded'
  | 'error'

export type DarrinOutcomeSource =
  | 'darrin_auto'
  | 'user_review'
  | 'rule_promotion'
  | 'system'

const MAX_REASONING_LENGTH = 2000

/**
 * Input shape for recordDarrinDecision — intentionally wide because the
 * caller at each checkpoint has different context available.
 */
export interface DarrinDecisionInput {
  // Context
  projectId: string
  extractionRunId?: string | null
  openingId?: string | null
  hardwareItemId?: string | null
  sourcePage?: number | null
  checkpoint: DarrinCheckpoint
  lane?: DarrinLane | null

  // Decision
  action: DarrinAction
  targetField?: string | null
  proposedValue?: unknown
  priorValue?: unknown
  siblingsConsidered?: unknown

  // Reasoning
  confidence?: number | null
  reasoning?: string | null
  promptVersion?: string | null

  // Cost / telemetry
  model?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  costUsd?: number | null
  latencyMs?: number | null

  // Error envelope — set when the Darrin call itself failed. error_kind
  // is normalized via classifyDarrinInfrastructureError when errorDetail
  // is a raw SDK error message; callers may also pass a domain-specific
  // errorKind directly (e.g. 'apply_failed', 'validation_rejected').
  errorKind?: string | null
  errorDetail?: string | null
}

/**
 * Insert one row into darrin_decisions. Returns the new id, or null if the
 * insert failed. Never throws.
 *
 * Cast through `any` because `darrin_decisions` isn't in the generated
 * Database type yet (TODO(darrin-decisions types) — see below).
 */
export async function recordDarrinDecision(
  input: DarrinDecisionInput,
): Promise<string | null> {
  try {
    const supabase = createAdminSupabaseClient()
    const reasoning = input.reasoning
      ? input.reasoning.slice(0, MAX_REASONING_LENGTH)
      : null
    // TODO(darrin-decisions types): hand-add the `darrin_decisions` table to
    // src/lib/types/database.ts after this migration applies, then remove the
    // `as any` cast here. (No `gen:supabase-types` script exists in this repo;
    // types/database.ts is hand-edited.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.from('darrin_decisions') as any)
      .insert({
        project_id: input.projectId,
        extraction_run_id: input.extractionRunId ?? null,
        opening_id: input.openingId ?? null,
        hardware_item_id: input.hardwareItemId ?? null,
        source_page: input.sourcePage ?? null,
        checkpoint: input.checkpoint,
        lane: input.lane ?? null,
        action: input.action,
        target_field: input.targetField ?? null,
        proposed_value: input.proposedValue ?? null,
        prior_value: input.priorValue ?? null,
        siblings_considered: input.siblingsConsidered ?? null,
        confidence: input.confidence ?? null,
        reasoning,
        prompt_version: input.promptVersion ?? null,
        model: input.model ?? null,
        input_tokens: input.inputTokens ?? null,
        output_tokens: input.outputTokens ?? null,
        cost_usd: input.costUsd ?? null,
        latency_ms: input.latencyMs ?? null,
        error_kind: input.errorKind ?? null,
        error_detail: input.errorDetail ?? null,
      })
      .select('id')
      .single()
    if (error) {
      try {
        Sentry.addBreadcrumb({
          category: 'darrin-ledger',
          level: 'warning',
          message: 'recordDarrinDecision insert failed',
          data: { checkpoint: input.checkpoint, action: input.action, error: error.message },
        })
      } catch {
        // swallow
      }
      return null
    }
    return (data?.id as string | undefined) ?? null
  } catch (err) {
    try {
      Sentry.addBreadcrumb({
        category: 'darrin-ledger',
        level: 'warning',
        message: 'recordDarrinDecision threw',
        data: {
          checkpoint: input.checkpoint,
          action: input.action,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    } catch {
      // swallow
    }
    return null
  }
}

/**
 * Patch the outcome of a previously-recorded decision. Safe on a null id
 * (no-op) so callers don't have to guard. Never throws.
 */
export async function patchDarrinDecisionOutcome(
  id: string | null,
  outcome: DarrinOutcome,
  source: DarrinOutcomeSource,
  opts?: { errorKind?: string | null; errorDetail?: string | null },
): Promise<void> {
  if (!id) return
  try {
    const supabase = createAdminSupabaseClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = (supabase.from('darrin_decisions') as any)
      .update({
        outcome,
        outcome_set_at: new Date().toISOString(),
        outcome_source: source,
        ...(opts?.errorKind !== undefined ? { error_kind: opts.errorKind } : {}),
        ...(opts?.errorDetail !== undefined ? { error_detail: opts.errorDetail } : {}),
      })
      .eq('id', id)
    const { error } = await query
    if (error) {
      try {
        Sentry.addBreadcrumb({
          category: 'darrin-ledger',
          level: 'warning',
          message: 'patchDarrinDecisionOutcome failed',
          data: { id, outcome, error: error.message },
        })
      } catch {
        // swallow
      }
    }
  } catch (err) {
    try {
      Sentry.addBreadcrumb({
        category: 'darrin-ledger',
        level: 'warning',
        message: 'patchDarrinDecisionOutcome threw',
        data: { id, outcome, error: err instanceof Error ? err.message : String(err) },
      })
    } catch {
      // swallow
    }
  }
}

// ─── Convenience: error_kind classification ─────────────────────────────

/**
 * Normalize an error into the string we persist in darrin_decisions.error_kind.
 *
 * If the message matches an Anthropic infrastructure pattern
 * (classifyDarrinInfrastructureError), we persist the category so ledger
 * queries can distinguish a pipeline-wide billing outage from per-call
 * glitches. Otherwise we return the caller-provided fallback (e.g.
 * 'call_failed', 'apply_failed').
 */
export function classifyLedgerErrorKind(
  errorMessage: string | null | undefined,
  fallback: string,
): string {
  if (!errorMessage) return fallback
  const infra: DarrinInfrastructureErrorCategory = classifyDarrinInfrastructureError(errorMessage)
  return infra ?? fallback
}
