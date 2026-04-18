-- Migration 048: Remove conflicting structural door rows from existing data
--
-- Root cause: apply-revision/route.ts preserved "Door" rows that had a
-- user-set install_type, then inserted "Door (Active Leaf)" when pair
-- detection changed.  Because the two names don't collide, both ended up
-- in the DB — violating the conflicting_door_variants invariant.
--
-- Fix applied to code: isStructuralRow() now forces Door*/Frame rows into
-- toDeleteIds regardless of install_type, so they are always regenerated
-- from the fresh PDF on revision reset.
--
-- This migration cleans up rows that already exist in production:
--   • Pair openings (leaf_count = 2): delete bare "Door" rows — the
--     "Door (Active Leaf)" / "Door (Inactive Leaf)" pair is correct.
--   • Single openings (leaf_count = 1): delete "Door (Active Leaf)" and
--     "Door (Inactive Leaf)" rows — the bare "Door" row is correct.
--
-- All deletes are idempotent; re-running is safe.

-- 1. Pair openings: drop bare "Door" rows where leaf-specific rows exist
DELETE FROM hardware_items
WHERE name = 'Door'
  AND opening_id IN (
    SELECT o.id
    FROM openings o
    WHERE o.leaf_count = 2
      AND EXISTS (
        SELECT 1 FROM hardware_items hi
        WHERE hi.opening_id = o.id
          AND hi.name IN ('Door (Active Leaf)', 'Door (Inactive Leaf)')
      )
  );

-- 2. Single openings: drop leaf-specific "Door (*)" rows where a bare "Door"
--    row also exists (bare "Door" is the correct representation for singles)
DELETE FROM hardware_items
WHERE name IN ('Door (Active Leaf)', 'Door (Inactive Leaf)')
  AND opening_id IN (
    SELECT o.id
    FROM openings o
    WHERE (o.leaf_count = 1 OR o.leaf_count IS NULL)
      AND EXISTS (
        SELECT 1 FROM hardware_items hi
        WHERE hi.opening_id = o.id
          AND hi.name = 'Door'
      )
  );
