-- Phase 2: Reference codes table for decoding manufacturer/finish/option abbreviations
-- Populated from each submittal's reference pages during import.
-- User corrections via propagate-edit update the source to 'user_corrected'.

CREATE TABLE IF NOT EXISTS reference_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    code_type TEXT NOT NULL CHECK (code_type IN ('manufacturer', 'finish', 'option')),
    code TEXT NOT NULL,
    full_name TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'pdf_extracted' CHECK (source IN ('pdf_extracted', 'user_corrected')),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),

    -- Each code is unique per project + type
    UNIQUE (project_id, code_type, code)
);

-- Index for fast lookups during hardware set decoding
CREATE INDEX IF NOT EXISTS idx_reference_codes_lookup
    ON reference_codes (project_id, code_type, code);

-- RLS policies (match existing pattern)
ALTER TABLE reference_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view reference codes for their projects"
    ON reference_codes FOR SELECT
    USING (
        project_id IN (
            SELECT project_id FROM project_members
            WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can insert reference codes for their projects"
    ON reference_codes FOR INSERT
    WITH CHECK (
        project_id IN (
            SELECT project_id FROM project_members
            WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can update reference codes for their projects"
    ON reference_codes FOR UPDATE
    USING (
        project_id IN (
            SELECT project_id FROM project_members
            WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "Users can delete reference codes for their projects"
    ON reference_codes FOR DELETE
    USING (
        project_id IN (
            SELECT project_id FROM project_members
            WHERE user_id = auth.uid()
        )
    );
