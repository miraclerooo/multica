-- name: CreateSquadPipeline :one
INSERT INTO squad_pipeline (id,workspace_id,squad_id,name,creator_id,idempotency_key,legacy,creation_hash)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *;

-- name: GetSquadPipeline :one
SELECT * FROM squad_pipeline WHERE id=$1 AND workspace_id=$2;

-- name: GetSquadPipelineByKey :one
SELECT * FROM squad_pipeline WHERE workspace_id=$1 AND squad_id=$2 AND idempotency_key=$3;

-- name: ListSquadPipelines :many
SELECT * FROM squad_pipeline WHERE workspace_id=$1 AND squad_id=$2 ORDER BY created_at,id LIMIT $3 OFFSET $4;

-- name: UpdateSquadPipeline :one
UPDATE squad_pipeline SET name=$3,revision=revision+1,updated_at=now()
WHERE id=$1 AND workspace_id=$2 AND revision=$4 RETURNING *;

-- name: PublishSquadPipelineDefinition :exec
UPDATE squad_pipeline SET executable_definition_id=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND workspace_id=$2;

-- name: ListCatalogDefinitions :many
SELECT * FROM pipeline_definition WHERE workspace_id=$1 AND pipeline_id=$2 ORDER BY revision DESC LIMIT $3 OFFSET $4;

-- name: SaveIssueExecution :one
UPDATE issue SET execution=$3 WHERE id=$1 AND workspace_id=$2 RETURNING *;

-- name: GetIssueCreateRequest :one
SELECT * FROM issue_create_request WHERE workspace_id=$1 AND creator_id=$2 AND idempotency_key=$3;

-- name: SaveIssueCreateRequest :exec
INSERT INTO issue_create_request (workspace_id,creator_id,idempotency_key,request_hash,issue_id) VALUES ($1,$2,$3,$4,$5);

-- name: SaveRuntimeBuildReport :exec
UPDATE agent_runtime SET metadata=COALESCE(metadata,'{}'::jsonb) || sqlc.arg('report')::jsonb WHERE id=$1 AND workspace_id=$2;
