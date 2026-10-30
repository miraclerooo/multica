CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_project_document_directory ON project_document (workspace_id, project_id, updated_at DESC);
