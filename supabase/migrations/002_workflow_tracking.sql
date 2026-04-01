-- ============================================================================
-- Migration 002: Hardware Classification & Multi-Step Workflow
-- ============================================================================
-- Adds install_type to hardware_items (bench vs field)
-- Replaces single checked boolean with multi-step workflow tracking
-- Steps: received -> pre_install (bench) OR installed (field) -> qa_qc

-- Add install_type to hardware_items
ALTER TABLE hardware_items
  ADD COLUMN IF NOT EXISTS install_type TEXT DEFAULT NULL
  CHECK (install_type IN ('bench', 'field'));

-- Add workflow step columns to checklist_progress
-- Keep 'checked' for backward compatibility (will represent fully complete)
ALTER TABLE checklist_progress
  ADD COLUMN IF NOT EXISTS received BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS received_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pre_install BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS pre_install_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pre_install_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS installed BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS installed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS installed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qa_qc BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS qa_qc_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS qa_qc_at TIMESTAMPTZ;

-- Migrate existing checked data: if an item was checked, mark it as received
UPDATE checklist_progress SET received = true, received_at = checked_at, received_by = checked_by WHERE checked = true AND received = false;
