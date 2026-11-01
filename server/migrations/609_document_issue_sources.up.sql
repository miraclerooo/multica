CREATE TABLE project_document_issue (
    workspace_id UUID NOT NULL, project_id UUID NOT NULL,
    document_id UUID NOT NULL, issue_id UUID NOT NULL,
    document_version INT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project_document_source (
    workspace_id UUID NOT NULL, project_id UUID NOT NULL,
    document_id UUID NOT NULL, issue_id UUID NOT NULL,
    source_key TEXT NOT NULL, source JSONB NOT NULL,
    document_version INT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE project_document_operation (
    workspace_id UUID NOT NULL, project_id UUID NOT NULL, issue_id UUID NOT NULL,
    idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
    document_id UUID NOT NULL, document_version INT NOT NULL, inserted BOOLEAN NOT NULL
);
