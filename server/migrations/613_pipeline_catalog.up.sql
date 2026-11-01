CREATE TABLE squad_pipeline (
    id UUID NOT NULL, workspace_id UUID NOT NULL, squad_id UUID NOT NULL,
    name TEXT NOT NULL, revision BIGINT NOT NULL DEFAULT 1,
    executable_definition_id UUID, legacy BOOLEAN NOT NULL DEFAULT false,
    creator_id UUID NOT NULL, idempotency_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE pipeline_definition ADD COLUMN pipeline_id UUID;

-- One old squad-wide sequence becomes one catalog entry. Reusing its first
-- definition's ID is deterministic and does not change any historical ID.
INSERT INTO squad_pipeline (id,workspace_id,squad_id,name,executable_definition_id,legacy,creator_id,idempotency_key)
SELECT first.id,first.workspace_id,first.squad_id,'Migrated pipeline',
       COALESCE(s.pipeline_definition_id, latest.id),true,first.creator_id,'legacy'
FROM (SELECT DISTINCT ON (workspace_id,squad_id) * FROM pipeline_definition ORDER BY workspace_id,squad_id,revision,id) first
JOIN LATERAL (SELECT id FROM pipeline_definition d WHERE d.workspace_id=first.workspace_id AND d.squad_id=first.squad_id ORDER BY revision DESC,id DESC LIMIT 1) latest ON true
LEFT JOIN squad s ON s.id=first.squad_id AND s.workspace_id=first.workspace_id;
UPDATE pipeline_definition d SET pipeline_id=p.id FROM squad_pipeline p
WHERE p.workspace_id=d.workspace_id AND p.squad_id=d.squad_id AND p.legacy;
ALTER TABLE pipeline_definition ALTER COLUMN pipeline_id SET NOT NULL;
DROP INDEX IF EXISTS pipeline_definition_version;

ALTER TABLE issue ADD COLUMN execution JSONB;
CREATE TABLE issue_create_request (
    workspace_id UUID NOT NULL, creator_id UUID NOT NULL, idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL, issue_id UUID NOT NULL
);
