DROP TABLE IF EXISTS issue_create_request;
ALTER TABLE issue DROP COLUMN IF EXISTS execution;
ALTER TABLE pipeline_definition DROP COLUMN IF EXISTS pipeline_id;
DROP TABLE IF EXISTS squad_pipeline;
-- The old squad-wide revision constraint cannot be restored after independent
-- histories have diverged. Rolling back requires restoring the pre-upgrade DB.
