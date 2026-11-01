-- name: CreatePipelineDefinition :one
INSERT INTO pipeline_definition (id,workspace_id,squad_id,revision,kind,source,source_hash,compiler_version,plan,creator_id,idempotency_key)
VALUES ($1,$2,$3,(SELECT COALESCE(MAX(d.revision),0)+1 FROM pipeline_definition d WHERE d.workspace_id=$2 AND d.squad_id=$3),$4,$5,$6,$7,$8,$9,$10) RETURNING *;

-- name: GetPipelineDefinition :one
SELECT * FROM pipeline_definition WHERE id=$1 AND workspace_id=$2;

-- name: GetPipelineDefinitionByKey :one
SELECT * FROM pipeline_definition WHERE workspace_id=$1 AND squad_id=$2 AND idempotency_key=$3;

-- name: ListPipelineDefinitions :many
SELECT * FROM pipeline_definition WHERE workspace_id=$1 AND squad_id=$2 ORDER BY revision DESC LIMIT $3 OFFSET $4;

-- name: SetSquadPipeline :one
UPDATE squad SET instructions_mode=$3,pipeline_definition_id=$4,revision=revision+1,updated_at=now()
WHERE id=$1 AND workspace_id=$2 AND revision=$5 RETURNING *;

-- name: LockPipelineIssue :one
SELECT * FROM issue WHERE id=$1 AND workspace_id=$2 FOR UPDATE;

-- name: CreatePipelineRun :one
INSERT INTO pipeline_run (id,workspace_id,issue_id,squad_id,definition_id,creator_id,idempotency_key,request_hash,status,state)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *;

-- name: GetPipelineRun :one
SELECT * FROM pipeline_run WHERE id=$1 AND workspace_id=$2;

-- name: LockPipelineRun :one
SELECT * FROM pipeline_run WHERE id=$1 AND workspace_id=$2 FOR UPDATE;

-- name: GetPipelineRunByKey :one
SELECT * FROM pipeline_run WHERE workspace_id=$1 AND issue_id=$2 AND idempotency_key=$3;

-- name: GetActivePipelineRun :one
SELECT * FROM pipeline_run WHERE workspace_id=$1 AND issue_id=$2 AND status IN ('queued','running','waiting_approval','blocked','cancelling');

-- name: GetLatestPipelineRunForIssue :one
SELECT * FROM pipeline_run WHERE workspace_id=$1 AND issue_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1;

-- name: ListPipelineRuns :many
SELECT * FROM pipeline_run WHERE workspace_id=$1 AND (sqlc.narg('issue_id')::uuid IS NULL OR issue_id=sqlc.narg('issue_id'))
AND (sqlc.narg('squad_id')::uuid IS NULL OR squad_id=sqlc.narg('squad_id')) ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3;

-- name: ListActivePipelineRuns :many
SELECT * FROM pipeline_run WHERE status IN ('queued','running','waiting_approval','blocked','cancelling') ORDER BY id LIMIT $1 OFFSET $2;

-- name: UpdatePipelineRun :one
UPDATE pipeline_run SET state=$3,status=$4,revision=revision+1,updated_at=now() WHERE id=$1 AND workspace_id=$2 RETURNING *;

-- name: RegisterPipelineTask :exec
UPDATE agent_task_queue SET pipeline_run_id=$2,pipeline_job_id=$3,pipeline_attempt=$4 WHERE id=$1;

-- name: ProjectPipelineIssueStatus :execrows
UPDATE issue SET status=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND status=$4 AND assignee_id=$5 AND assignee_type='squad';
