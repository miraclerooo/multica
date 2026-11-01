CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS pipeline_run_active ON pipeline_run (workspace_id, issue_id) WHERE status IN ('queued', 'running', 'waiting_approval', 'blocked', 'cancelling');
