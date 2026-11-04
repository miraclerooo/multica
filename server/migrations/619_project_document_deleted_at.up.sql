ALTER TABLE project_document ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
