-- name: ListProjectDocuments :many
SELECT id, workspace_id, project_id, title, is_pinned, position, revision,
       created_by, updated_by, created_at, updated_at, left(content, 240)::text AS excerpt
FROM project_document
WHERE workspace_id = $1 AND project_id = $2
ORDER BY is_pinned DESC, position ASC, updated_at DESC, id ASC
LIMIT sqlc.arg('page_limit') OFFSET sqlc.arg('page_offset');

-- name: CountProjectDocuments :one
SELECT count(*) FROM project_document WHERE workspace_id = $1 AND project_id = $2;

-- name: GetProjectDocument :one
SELECT * FROM project_document
WHERE id = $1 AND workspace_id = $2 AND project_id = $3;

-- name: CreateProjectDocument :one
INSERT INTO project_document (workspace_id, project_id, title, content, is_pinned, position, created_by, updated_by)
VALUES ($1, $2, $3, $4, $5, $6, sqlc.arg('actor_id'), sqlc.arg('actor_id'))
RETURNING *;

-- name: UpdateProjectDocument :one
UPDATE project_document
SET title = COALESCE(sqlc.narg('title')::text, title),
    content = COALESCE(sqlc.narg('content')::text, content),
    is_pinned = COALESCE(sqlc.narg('is_pinned')::boolean, is_pinned),
    position = COALESCE(sqlc.narg('position')::integer, position),
    updated_by = sqlc.arg('actor_id'),
    updated_at = clock_timestamp(),
    revision = revision + 1
WHERE id = sqlc.arg('id') AND workspace_id = sqlc.arg('workspace_id')
  AND project_id = sqlc.arg('project_id') AND revision = sqlc.arg('revision')
RETURNING *;

-- name: DeleteProjectDocument :one
DELETE FROM project_document
WHERE id = $1 AND workspace_id = $2 AND project_id = $3 AND revision = $4
RETURNING *;

-- name: DeleteProjectDocumentsByProject :exec
DELETE FROM project_document WHERE workspace_id = $1 AND project_id = $2;

-- name: LockWorkspaceForProjectDocumentCreate :one
SELECT id FROM workspace WHERE id = $1 FOR KEY SHARE;

-- name: LockProjectForDocumentCreate :one
-- Match the existing workspace -> project deletion lock order for soft references.
SELECT id FROM project WHERE id = $1 AND workspace_id = $2 FOR KEY SHARE;
