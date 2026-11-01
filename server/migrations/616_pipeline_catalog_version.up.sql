CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS pipeline_catalog_version ON pipeline_definition (workspace_id,pipeline_id,revision);
