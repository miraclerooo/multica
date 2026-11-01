CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS squad_pipeline_key ON squad_pipeline (workspace_id,squad_id,idempotency_key);
