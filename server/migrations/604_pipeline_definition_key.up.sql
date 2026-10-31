CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS pipeline_definition_key ON pipeline_definition (workspace_id, squad_id, idempotency_key);
