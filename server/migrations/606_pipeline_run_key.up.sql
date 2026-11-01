CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS pipeline_run_key ON pipeline_run (workspace_id, issue_id, idempotency_key);
