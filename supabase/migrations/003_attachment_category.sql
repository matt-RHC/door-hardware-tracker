-- Add category column to attachments for organizing drawings
-- Categories: floor_plan, door_drawing, frame_drawing, general
ALTER TABLE attachments
ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'general';

-- Update existing attachments to 'general'
UPDATE attachments SET category = 'general' WHERE category IS NULL;
