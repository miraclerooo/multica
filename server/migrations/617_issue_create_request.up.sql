CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS issue_create_request_key ON issue_create_request (workspace_id,creator_id,idempotency_key);
