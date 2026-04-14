-- Add is_active column to openings table for soft-delete support
-- Applied in production, adding to repo for parity
ALTER TABLE openings ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
