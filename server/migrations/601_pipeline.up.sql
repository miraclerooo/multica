ALTER TABLE squad ADD COLUMN instructions_mode TEXT NOT NULL DEFAULT 'markdown',
    ADD COLUMN pipeline_definition_id UUID, ADD COLUMN revision BIGINT NOT NULL DEFAULT 1;

CREATE TABLE pipeline_definition (
    id UUID NOT NULL, workspace_id UUID NOT NULL, squad_id UUID NOT NULL,
    revision BIGINT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL,
    source_hash TEXT NOT NULL, compiler_version TEXT NOT NULL, plan JSONB NOT NULL,
    creator_id UUID NOT NULL, idempotency_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The run is a transactional aggregate: jobs, append-only attempts, artifact
-- references, decisions and operation receipts are persisted together in state.
-- Task rows are registered in the same transaction as the aggregate update.
CREATE TABLE pipeline_run (
    id UUID NOT NULL, workspace_id UUID NOT NULL, issue_id UUID NOT NULL,
    squad_id UUID NOT NULL, definition_id UUID NOT NULL, creator_id UUID NOT NULL,
    idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
    status TEXT NOT NULL, revision BIGINT NOT NULL DEFAULT 1, state JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE agent_task_queue ADD COLUMN pipeline_run_id UUID,
    ADD COLUMN pipeline_job_id TEXT, ADD COLUMN pipeline_attempt INT;
