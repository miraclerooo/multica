CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS document_issue_key ON project_document_issue (workspace_id, document_id, issue_id);
