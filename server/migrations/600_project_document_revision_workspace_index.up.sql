CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_project_document_revision_workspace ON project_document_revision (workspace_id, project_id);
