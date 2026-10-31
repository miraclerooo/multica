-- name: GetProjectDocumentRevision :one
SELECT * FROM project_document_revision
WHERE document_id = $1 AND workspace_id = $2 AND project_id = $3 AND version = $4;

-- name: SetNewProjectDocumentBody :exec
UPDATE project_document SET body = $4
WHERE id = $1 AND workspace_id = $2 AND project_id = $3 AND version = 1;

-- name: ListProjectDocumentIssues :many
SELECT di.*, i.title AS issue_title, i.number AS issue_number, w.issue_prefix
FROM project_document_issue di
JOIN issue i ON i.id = di.issue_id AND i.workspace_id = di.workspace_id AND i.project_id = di.project_id
JOIN workspace w ON w.id = di.workspace_id
WHERE di.workspace_id = $1 AND di.project_id = $2
ORDER BY i.number DESC, di.created_at, di.document_id;

-- name: AssociateProjectDocumentIssue :exec
INSERT INTO project_document_issue (workspace_id, project_id, document_id, issue_id, document_version)
VALUES ($1, $2, $3, $4, $5) ON CONFLICT (workspace_id, document_id, issue_id) DO NOTHING;

-- name: UnlinkProjectDocumentIssue :exec
DELETE FROM project_document_issue WHERE workspace_id = $1 AND project_id = $2 AND document_id = $3 AND issue_id = $4;

-- name: GetProjectDocumentSource :one
SELECT * FROM project_document_source WHERE workspace_id = $1 AND document_id = $2 AND source_key = $3;

-- name: ListProjectDocumentSources :many
SELECT * FROM project_document_source WHERE workspace_id = $1 AND project_id = $2 AND document_id = $3
ORDER BY created_at, source_key;

-- name: CreateProjectDocumentSource :exec
INSERT INTO project_document_source (workspace_id, project_id, document_id, issue_id, source_key, source, document_version)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- name: GetProjectDocumentOperation :one
SELECT * FROM project_document_operation WHERE workspace_id = $1 AND issue_id = $2 AND idempotency_key = $3;

-- name: CreateProjectDocumentOperation :exec
INSERT INTO project_document_operation (workspace_id, project_id, issue_id, idempotency_key, request_hash, document_id, document_version, inserted)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: DeleteProjectDocumentRelationsByProject :exec
WITH sources AS (
 DELETE FROM project_document_source WHERE project_document_source.workspace_id = $1 AND project_document_source.project_id = $2
), operations AS (
 DELETE FROM project_document_operation WHERE project_document_operation.workspace_id = $1 AND project_document_operation.project_id = $2
)
DELETE FROM project_document_issue WHERE project_document_issue.workspace_id = $1 AND project_document_issue.project_id = $2;
