package handler

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/pipeline"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func catalogResponse(p db.SquadPipeline) map[string]any {
	return map[string]any{"id": uuidToString(p.ID), "workspace_id": uuidToString(p.WorkspaceID), "squad_id": uuidToString(p.SquadID), "name": p.Name, "revision": p.Revision, "executable_definition_id": uuidToPtr(p.ExecutableDefinitionID), "legacy": p.Legacy, "created_at": timestampToString(p.CreatedAt), "updated_at": timestampToString(p.UpdatedAt)}
}

func (h *Handler) ListPipelineCatalog(w http.ResponseWriter, r *http.Request) {
	_, ws, ok := h.pipelineMember(w, r, false)
	if !ok {
		return
	}
	squad, ok := parseUUIDOrBadRequest(w, r.URL.Query().Get("squad_id"), "squad_id")
	if !ok {
		return
	}
	if _, err := h.Queries.GetSquadInWorkspace(r.Context(), db.GetSquadInWorkspaceParams{ID: squad, WorkspaceID: parseUUID(ws)}); err != nil {
		writePipelineError(w, err)
		return
	}
	limit, offset := pipelinePage(r)
	rows, err := h.Queries.ListSquadPipelines(r.Context(), db.ListSquadPipelinesParams{WorkspaceID: parseUUID(ws), SquadID: squad, Limit: limit, Offset: offset})
	if err != nil {
		writePipelineError(w, err)
		return
	}
	items := []map[string]any{}
	for _, p := range rows {
		items = append(items, catalogResponse(p))
	}
	writeJSON(w, 200, map[string]any{"items": items, "limit": limit, "offset": offset})
}

func (h *Handler) CreatePipelineCatalog(w http.ResponseWriter, r *http.Request) {
	member, ws, ok := h.pipelineMember(w, r, true)
	if !ok {
		return
	}
	var req struct {
		Name             string `json:"name"`
		SquadID          string `json:"squad_id"`
		Source           string `json:"source"`
		IdempotencyKey   string `json:"idempotency_key"`
		Activate         bool   `json:"activate"`
		ExpectedRevision int64  `json:"expected_revision"`
	}
	if !decodePipelineBody(w, r, &req) {
		return
	}
	sid, ok := parseUUIDOrBadRequest(w, req.SquadID, "squad_id")
	if !ok {
		return
	}
	squad, err := h.Queries.GetSquadInWorkspace(r.Context(), db.GetSquadInWorkspaceParams{ID: sid, WorkspaceID: parseUUID(ws)})
	if err != nil {
		writePipelineError(w, err)
		return
	}
	if !canManageSquad(member, squad) {
		writePipelineError(w, pipeline.Fail("approval_forbidden", "squad management permission required"))
		return
	}
	d, err := h.Pipelines.SaveDefinition(r.Context(), ws, req.SquadID, uuidToString(member.UserID), req.Source, req.IdempotencyKey, req.Activate, req.ExpectedRevision, service.PipelineSaveOptions{New: true, Name: req.Name})
	if err != nil {
		writePipelineError(w, err)
		return
	}
	p, err := h.Queries.GetSquadPipeline(r.Context(), db.GetSquadPipelineParams{ID: d.PipelineID, WorkspaceID: d.WorkspaceID})
	if err != nil {
		writePipelineError(w, err)
		return
	}
	h.publish("pipeline:definition_created", ws, "member", uuidToString(member.UserID), map[string]any{"pipeline_id": uuidToString(p.ID), "squad_id": req.SquadID})
	writeJSON(w, 201, map[string]any{"pipeline": catalogResponse(p), "definition": pipelineDefinitionResponse(d)})
}

func (h *Handler) GetPipelineCatalog(w http.ResponseWriter, r *http.Request) {
	_, ws, ok := h.pipelineMember(w, r, false)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "pipelineId"), "pipeline_id")
	if !ok {
		return
	}
	p, err := h.Queries.GetSquadPipeline(r.Context(), db.GetSquadPipelineParams{ID: id, WorkspaceID: parseUUID(ws)})
	if err != nil {
		writePipelineError(w, err)
		return
	}
	writeJSON(w, 200, catalogResponse(p))
}

func (h *Handler) RenamePipelineCatalog(w http.ResponseWriter, r *http.Request) {
	member, ws, ok := h.pipelineMember(w, r, true)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "pipelineId"), "pipeline_id")
	if !ok {
		return
	}
	var req struct {
		Name             string `json:"name"`
		ExpectedRevision int64  `json:"expected_revision"`
	}
	if !decodePipelineBody(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 200 {
		writePipelineError(w, pipeline.Fail("invalid_pipeline_name", "name must contain 1 to 200 bytes"))
		return
	}
	p, err := h.Queries.GetSquadPipeline(r.Context(), db.GetSquadPipelineParams{ID: id, WorkspaceID: parseUUID(ws)})
	if err != nil {
		writePipelineError(w, err)
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writePipelineError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	q := h.Queries.WithTx(tx)
	squad, err := q.LockSquadForUpdate(r.Context(), db.LockSquadForUpdateParams{ID: p.SquadID, WorkspaceID: p.WorkspaceID})
	if err != nil {
		writePipelineError(w, err)
		return
	}
	if !canManageSquad(member, squad) {
		writePipelineError(w, pipeline.Fail("approval_forbidden", "squad management permission required"))
		return
	}
	p, err = q.UpdateSquadPipeline(r.Context(), db.UpdateSquadPipelineParams{ID: id, WorkspaceID: p.WorkspaceID, Name: req.Name, Revision: req.ExpectedRevision})
	if errors.Is(err, pgx.ErrNoRows) {
		writePipelineError(w, pipeline.Fail("revision_conflict", "pipeline revision changed"))
		return
	}
	if err != nil {
		writePipelineError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		writePipelineError(w, err)
		return
	}
	h.publish("pipeline:definition_created", ws, "member", uuidToString(member.UserID), map[string]any{"pipeline_id": uuidToString(p.ID), "squad_id": uuidToString(p.SquadID)})
	writeJSON(w, 200, catalogResponse(p))
}
