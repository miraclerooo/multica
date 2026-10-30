CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_project_document_revision_version ON project_document_revision (document_id, version DESC);
