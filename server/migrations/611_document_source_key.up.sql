CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS document_source_key ON project_document_source (workspace_id, document_id, source_key);
