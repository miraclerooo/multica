CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS pipeline_definition_version ON pipeline_definition (workspace_id, squad_id, revision);
