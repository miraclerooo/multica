CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS document_operation_key ON project_document_operation (workspace_id, issue_id, idempotency_key);
