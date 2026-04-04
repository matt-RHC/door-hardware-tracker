-- Migration 005: Add PDF hash column for duplicate detection
-- Adds SHA-256 hash of last uploaded PDF to projects table
-- Used to detect when the same PDF is re-uploaded (skip redundant parsing)

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS last_pdf_hash TEXT,
  ADD COLUMN IF NOT EXISTS last_pdf_uploaded_at TIMESTAMPTZ;

COMMENT ON COLUMN projects.last_pdf_hash IS 'SHA-256 hash of the most recently uploaded PDF submittal';
COMMENT ON COLUMN projects.last_pdf_uploaded_at IS 'Timestamp of the most recent PDF upload';
