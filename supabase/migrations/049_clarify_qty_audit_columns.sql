-- Migration 049: Clarify the semantics of hardware_items qty audit columns.
--
-- Migration 029 added qty_total / qty_door_count / qty_source but only
-- documented qty_source. The remaining columns have been quietly causing
-- "audit math doesn't reconcile" suspicions because readers (and tools
-- like ad-hoc SQL audits) assumed qty = ceil(qty_total / qty_door_count).
--
-- That invariant does NOT hold. The qty column carries any post-
-- normalization mutation the pipeline applies — pair-leaf hinge split
-- (active leaf = raw - electric_count), handing filter, manual edits.
-- The qty_total / qty_door_count columns record the RAW PDF context
-- that the original normalization saw, NOT a recomputable formula.
--
-- This migration only changes column comments. No data is touched.
-- Backfill is implicit (column comments are catalog metadata).

COMMENT ON COLUMN hardware_items.qty IS
  'Per-opening quantity AFTER all normalization and post-write mutations '
  'apply (pair-leaf hinge split, handing filter, user edits). '
  'This is the authoritative value rendered to users.';

COMMENT ON COLUMN hardware_items.qty_total IS
  'RAW per-set PDF quantity at the time of extraction. Records what the '
  'PDF originally said, not a recomputable derivation of qty. Stays '
  'constant across leaf-split / handing-filter mutations applied to qty. '
  'Use for audit ("what did the PDF say?"), NOT for math (qty != '
  'ceil(qty_total/qty_door_count) on pair-leaf or sub-aggregate cases).';

COMMENT ON COLUMN hardware_items.qty_door_count IS
  'Divisor Python recommended at extraction time (door count or leaf '
  'count, depending on qty_convention). Same caveat as qty_total: this '
  'is raw PDF context, not a math invariant on qty. May be set to a '
  'value larger than qty_total when Python detected per-opening qty '
  '(meaning no division was applied — qty is already per-opening).';

COMMENT ON COLUMN hardware_items.qty_source IS
  'How qty was derived. Values include: parsed | divided | flagged | '
  'capped | manual | region_extract | needs_division | needs_cap | '
  'needs_review | rhr_lhr_pair | llm_override | auto_corrected | '
  'deep_extract | propagated | reverted | manual_placeholder. '
  'See NEVER_RENORMALIZE in src/lib/parse-pdf-helpers.ts for the set '
  'of terminal values that lock qty from further division.';
