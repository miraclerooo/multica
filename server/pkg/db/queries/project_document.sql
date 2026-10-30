-- name: ListProjectDocuments :many
SELECT * FROM project_document
WHERE workspace_id = $1 AND project_id = $2
ORDER BY updated_at DESC, id;

-- name: GetProjectDocument :one
SELECT * FROM project_document
WHERE id = $1 AND workspace_id = $2 AND project_id = $3;

-- name: CreateProjectDocument :one
INSERT INTO project_document (workspace_id, project_id, kind, title, body, author_type, author_id, author_name)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING *;

-- name: SaveProjectDocument :one
UPDATE project_document SET title = $4, body = $5, version = version + 1,
    author_type = $6, author_id = $7, author_name = $8, updated_at = now()
WHERE id = $1 AND workspace_id = $2 AND project_id = $3 AND version = sqlc.arg(base_version)
RETURNING *;

-- name: CreateProjectDocumentRevision :exec
INSERT INTO project_document_revision (document_id, workspace_id, project_id, title, body, version, base_version, author_type, author_id, author_name, created_at)
SELECT d.id, d.workspace_id, d.project_id, d.title, d.body, d.version, d.version - 1, d.author_type, d.author_id, d.author_name, d.updated_at
FROM project_document d WHERE d.id = $1 AND d.workspace_id = $2 AND d.project_id = $3;

-- name: ListProjectDocumentRevisions :many
SELECT * FROM project_document_revision
WHERE document_id = $1 AND workspace_id = $2 AND project_id = $3
ORDER BY version DESC;

-- name: RenameProjectDocumentResource :exec
UPDATE project_resource SET label = sqlc.narg(label)::text
WHERE workspace_id = sqlc.arg(workspace_id) AND project_id = sqlc.arg(project_id) AND resource_type = 'project_document'
    AND resource_ref->>'document_id' = sqlc.arg(document_id)::text;

-- name: DeleteProjectDocumentRevisionsByProject :exec
DELETE FROM project_document_revision WHERE workspace_id = $1 AND project_id = $2;

-- name: DeleteProjectDocumentsByProject :exec
DELETE FROM project_document WHERE workspace_id = $1 AND project_id = $2;
