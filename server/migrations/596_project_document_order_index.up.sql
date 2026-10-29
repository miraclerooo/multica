CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_project_document_order
ON project_document (workspace_id, project_id, is_pinned DESC, position ASC, updated_at DESC, id ASC);
