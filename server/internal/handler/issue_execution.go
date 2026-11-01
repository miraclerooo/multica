package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/pipeline"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func validateExecutionIDs(w http.ResponseWriter, e *service.ExecutionSelection) bool {
	if e == nil {
		return true
	}
	for field, id := range map[string]string{"pipeline_id": e.PipelineID, "definition_id": e.DefinitionID} {
		if id != "" {
			if _, ok := parseUUIDOrBadRequest(w, id, field); !ok {
				return false
			}
		}
	}
	return true
}

func (h *Handler) PreflightPipelineExecution(w http.ResponseWriter, r *http.Request) {
	member, ws, ok := h.pipelineMember(w, r, false)
	if !ok {
		return
	}
	var req struct {
		SquadID   string                      `json:"squad_id"`
		Execution *service.ExecutionSelection `json:"execution"`
	}
	if !decodePipelineBody(w, r, &req) || !validateExecutionIDs(w, req.Execution) {
		return
	}
	if _, ok := parseUUIDOrBadRequest(w, req.SquadID, "squad_id"); !ok {
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writePipelineError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	e, err := h.Pipelines.ResolveIssueExecution(r.Context(), h.Queries.WithTx(tx), ws, req.SquadID, uuidToString(member.UserID), req.Execution)
	if err != nil {
		writePipelineError(w, err)
		return
	}
	writeJSON(w, 200, e)
}

func (h *Handler) GetIssueExecution(w http.ResponseWriter, r *http.Request) {
	member, _, ok := h.pipelineMember(w, r, false)
	if !ok {
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	e := service.ExecutionForIssue(issue)
	if e == nil {
		writeJSON(w, 200, map[string]any{"execution": nil})
		return
	}
	if e.Mode == "pipeline" {
		readiness, err := h.Pipelines.CheckFrozenExecution(r.Context(), h.Queries, issue, e, uuidToString(member.UserID))
		if err != nil {
			writePipelineError(w, err)
			return
		}
		e.Readiness = readiness
		if e.State != "started" && readiness.Ready {
			e.State = "ready"
		}
	}
	writeJSON(w, 200, map[string]any{"execution": e})
}

func (h *Handler) StartIssueExecution(w http.ResponseWriter, r *http.Request) {
	member, _, ok := h.pipelineMember(w, r, true)
	if !ok {
		return
	}
	if r.ContentLength != 0 {
		var body struct{}
		if !decodePipelineBody(w, r, &body) {
			return
		}
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	e := service.ExecutionForIssue(issue)
	if e == nil || e.Mode != "pipeline" {
		writePipelineError(w, pipeline.Fail("invalid_execution_selection", "issue has no frozen pipeline selection"))
		return
	}
	readiness, err := h.Pipelines.CheckFrozenExecution(r.Context(), h.Queries, issue, e, uuidToString(member.UserID))
	if err != nil {
		writePipelineError(w, err)
		return
	}
	e.Readiness = readiness
	if !readiness.Ready && e.State != "started" {
		writeJSON(w, 409, map[string]any{"code": "runtime_not_ready", "error": "selected execution runtimes are not ready", "execution": e})
		return
	}
	run, err := h.Pipelines.StartFrozenExecution(r.Context(), issue, uuidToString(member.UserID))
	if err != nil {
		writePipelineError(w, err)
		return
	}
	params := db.GetPipelineRunParams{ID: parseUUID(run.ID), WorkspaceID: issue.WorkspaceID}
	row, err := h.Queries.GetPipelineRun(r.Context(), params)
	if err != nil {
		writePipelineError(w, err)
		return
	}
	if err = h.Pipelines.Reconcile(r.Context(), row); err != nil {
		writePipelineError(w, err)
		return
	}
	row, err = h.Queries.GetPipelineRun(r.Context(), params)
	if err != nil {
		writePipelineError(w, err)
		return
	}
	run, err = service.DecodePipelineRun(row)
	if err != nil {
		writePipelineError(w, err)
		return
	}
	e.State = "started"
	writeJSON(w, 200, map[string]any{"execution": e, "run": run})
}
