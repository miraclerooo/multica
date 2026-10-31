package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"fmt"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/integrations/ghsnapshot"
	"github.com/multica-ai/multica/server/internal/pipeline"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func (h *Handler) PipelineRoutes(r chi.Router) {
	r.Get("/api/pipelines/capabilities", h.PipelineCapabilities)
	r.Post("/api/pipelines/validate", h.ValidatePipeline)
	r.Get("/api/pipelines/definitions", h.ListPipelineDefinitions)
	r.Post("/api/pipelines/definitions", h.CreatePipelineDefinition)
	r.Get("/api/pipelines/definitions/{id}", h.GetPipelineDefinition)
	r.Post("/api/squads/{id}/pipeline-versions", h.CreatePipelineDefinition)
	r.Get("/api/pipeline-runs", h.ListPipelineRuns)
	r.Post("/api/pipeline-runs", h.CreatePipelineRun)
	r.Get("/api/pipeline-runs/{id}", h.GetPipelineRun)
	r.Post("/api/pipeline-runs/{id}/cancel", h.CancelPipelineRun)
	r.Get("/api/pipeline-runs/{id}/jobs/{job}", h.GetPipelineJob)
	r.Post("/api/pipeline-runs/{id}/jobs/{job}/retry", h.RetryPipelineJob)
	r.Post("/api/pipeline-runs/{id}/jobs/{job}/report", h.ReportPipelineJob)
	r.Post("/api/pipeline-runs/{id}/jobs/{job}/decisions", h.DecidePipelineJob)
	r.Get("/api/pipeline-runs/{id}/artifacts", h.ListPipelineArtifacts)
	r.Get("/api/pipeline-runs/{id}/artifact-content", h.DownloadPipelineArtifact)
}

func writePipelineError(w http.ResponseWriter, err error) {
	var e *pipeline.Error
	if errors.As(err, &e) {
		status := http.StatusConflict
		switch e.Code {
		case "approval_forbidden", "report_forbidden", "invocation_forbidden":
			status = 403
		case "job_not_found", "definition_not_owned":
			status = 404
		case "invalid_definition", "invalid_result", "invalid_artifact", "report_required", "reason_required", "invalid_decision", "idempotency_key_required":
			status = 422
		}
		writeJSON(w, status, e)
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		writeJSON(w, 404, pipeline.Error{Code: "not_found", Message: "pipeline resource not found"})
		return
	}
	writeJSON(w, 500, pipeline.Error{Code: "pipeline_error", Message: "pipeline operation failed"})
}

func (h *Handler) pipelineMember(w http.ResponseWriter, r *http.Request, human bool) (db.Member, string, bool) {
	ws := h.resolveWorkspaceID(r)
	member, ok := h.requireWorkspaceMember(w, r, ws, "workspace not found")
	if !ok {
		return member, ws, false
	}
	if human {
		actor, _ := h.resolveActor(r, requestUserID(r), ws)
		if actor != "member" {
			writePipelineError(w, pipeline.Fail("approval_forbidden", "this operation requires an authenticated human member"))
			return member, ws, false
		}
	}
	return member, ws, true
}
func decodePipelineBody(w http.ResponseWriter, r *http.Request, v any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1048576))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		writeJSON(w, 400, pipeline.Error{Code: "invalid_request", Message: err.Error()})
		return false
	}
	return true
}
func pipelinePage(r *http.Request) (int32, int32) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	if limit < 1 || limit > 100 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	if offset > 1000000 {
		offset = 1000000
	}
	return int32(limit), int32(offset)
}

func (h *Handler) PipelineCapabilities(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := h.pipelineMember(w, r, false); ok {
		writeJSON(w, 200, pipeline.Capabilities())
	}
}

func (h *Handler) ValidatePipeline(w http.ResponseWriter, r *http.Request) {
	member, ws, ok := h.pipelineMember(w, r, false)
	if !ok {
		return
	}
	var req struct {
		Source  string `json:"source"`
		SquadID string `json:"squad_id"`
	}
	if !decodePipelineBody(w, r, &req) {
		return
	}
	v := pipeline.Compile(req.Source)
	if req.SquadID != "" {
		id, ok := parseUUIDOrBadRequest(w, req.SquadID, "squad_id")
		if !ok {
			return
		}
		squad, err := h.Queries.GetSquadInWorkspace(r.Context(), db.GetSquadInWorkspaceParams{ID: id, WorkspaceID: parseUUID(ws)})
		if err != nil {
			writePipelineError(w, err)
			return
		}
		valid := false
		if v.SyntaxValid {
			_, d := h.Pipelines.Bindings(r.Context(), h.Queries, squad, *v.Plan, uuidToString(member.UserID))
			valid = len(d) == 0
			v.Diagnostics = append(v.Diagnostics, d...)
		}
		v.BindingValid = &valid
	}
	writeJSON(w, 200, v)
}

func pipelineDefinitionResponse(d db.PipelineDefinition) map[string]any {
	return map[string]any{"id": uuidToString(d.ID), "workspace_id": uuidToString(d.WorkspaceID), "squad_id": uuidToString(d.SquadID), "revision": d.Revision, "kind": d.Kind, "source": d.Source, "source_hash": d.SourceHash, "compiler_version": d.CompilerVersion, "plan": json.RawMessage(d.Plan), "creator_id": uuidToString(d.CreatorID), "created_at": timestampToString(d.CreatedAt)}
}

func (h *Handler) CreatePipelineDefinition(w http.ResponseWriter, r *http.Request) {
	member, ws, ok := h.pipelineMember(w, r, true)
	if !ok {
		return
	}
	var req struct {
		Source           string `json:"source"`
		SquadID          string `json:"squad_id"`
		IdempotencyKey   string `json:"idempotency_key"`
		Activate         bool   `json:"activate"`
		ExpectedRevision int64  `json:"expected_revision"`
	}
	if !decodePipelineBody(w, r, &req) {
		return
	}
	if id := chi.URLParam(r, "id"); id != "" {
		req.SquadID = id
	}
	id, ok := parseUUIDOrBadRequest(w, req.SquadID, "squad_id")
	if !ok {
		return
	}
	squad, err := h.Queries.GetSquadInWorkspace(r.Context(), db.GetSquadInWorkspaceParams{ID: id, WorkspaceID: parseUUID(ws)})
	if err != nil {
		writePipelineError(w, err)
		return
	}
	if !canManageSquad(member, squad) {
		writePipelineError(w, pipeline.Fail("approval_forbidden", "squad management permission required"))
		return
	}
	v := pipeline.Compile(req.Source)
	if !v.SyntaxValid {
		writeJSON(w, 422, map[string]any{"code": "invalid_definition", "error": "source does not compile", "validation": v})
		return
	}
	d, err := h.Pipelines.SaveDefinition(r.Context(), ws, req.SquadID, uuidToString(member.UserID), req.Source, req.IdempotencyKey, req.Activate, req.ExpectedRevision)
	if err != nil {
		writePipelineError(w, err)
		return
	}
	h.publish("pipeline:definition_created", ws, "member", uuidToString(member.UserID), map[string]any{"definition_id": uuidToString(d.ID), "squad_id": req.SquadID})
	if req.Activate {
		if squad, e := h.Queries.GetSquadInWorkspace(r.Context(), db.GetSquadInWorkspaceParams{ID: d.SquadID, WorkspaceID: d.WorkspaceID}); e == nil {
			h.publish(protocol.EventSquadUpdated, ws, "member", uuidToString(member.UserID), map[string]any{"squad": h.squadToResponse(squad)})
		}
	}
	writeJSON(w, 201, pipelineDefinitionResponse(d))
}

func (h *Handler) GetPipelineDefinition(w http.ResponseWriter, r *http.Request) {
	_, ws, ok := h.pipelineMember(w, r, false)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "definition_id")
	if !ok {
		return
	}
	d, err := h.Queries.GetPipelineDefinition(r.Context(), db.GetPipelineDefinitionParams{ID: id, WorkspaceID: parseUUID(ws)})
	if err != nil {
		writePipelineError(w, err)
		return
	}
	writeJSON(w, 200, pipelineDefinitionResponse(d))
}
func (h *Handler) ListPipelineDefinitions(w http.ResponseWriter, r *http.Request) {
	_, ws, ok := h.pipelineMember(w, r, false)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, r.URL.Query().Get("squad_id"), "squad_id")
	if !ok {
		return
	}
	limit, offset := pipelinePage(r)
	rows, err := h.Queries.ListPipelineDefinitions(r.Context(), db.ListPipelineDefinitionsParams{WorkspaceID: parseUUID(ws), SquadID: id, Limit: limit, Offset: offset})
	if err != nil {
		writePipelineError(w, err)
		return
	}
	out := []map[string]any{}
	for _, d := range rows {
		out = append(out, pipelineDefinitionResponse(d))
	}
	writeJSON(w, 200, map[string]any{"items": out, "limit": limit, "offset": offset})
}

func (h *Handler) loadPipelineRun(w http.ResponseWriter, r *http.Request, human bool) (db.PipelineRun, bool) {
	_, ws, ok := h.pipelineMember(w, r, human)
	if !ok {
		return db.PipelineRun{}, false
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "run_id")
	if !ok {
		return db.PipelineRun{}, false
	}
	row, err := h.Queries.GetPipelineRun(r.Context(), db.GetPipelineRunParams{ID: id, WorkspaceID: parseUUID(ws)})
	if err != nil {
		writePipelineError(w, err)
		return row, false
	}
	if _, ok := h.loadIssueForUser(w, r, uuidToString(row.IssueID)); !ok {
		return row, false
	}
	return row, true
}
func (h *Handler) CreatePipelineRun(w http.ResponseWriter, r *http.Request) {
	member, _, ok := h.pipelineMember(w, r, true)
	if !ok {
		return
	}
	var req struct {
		IssueID        string `json:"issue_id"`
		SquadID        string `json:"squad_id"`
		DefinitionID   string `json:"definition_id"`
		IdempotencyKey string `json:"idempotency_key"`
	}
	if !decodePipelineBody(w, r, &req) {
		return
	}
	if _, ok := parseUUIDOrBadRequest(w, req.SquadID, "squad_id"); !ok {
		return
	}
	if req.DefinitionID != "" {
		if _, ok := parseUUIDOrBadRequest(w, req.DefinitionID, "definition_id"); !ok {
			return
		}
	}
	issue, ok := h.loadIssueForUser(w, r, req.IssueID)
	if !ok {
		return
	}
	run, err := h.Pipelines.Start(r.Context(), issue, req.SquadID, req.DefinitionID, uuidToString(member.UserID), req.IdempotencyKey)
	if err != nil {
		writePipelineError(w, err)
		return
	}
	writeJSON(w, 201, run)
}
func (h *Handler) GetPipelineRun(w http.ResponseWriter, r *http.Request) {
	row, ok := h.loadPipelineRun(w, r, false)
	if !ok {
		return
	}
	run, err := service.DecodePipelineRun(row)
	if err != nil {
		writePipelineError(w, err)
		return
	}
	if err := h.Pipelines.HydrateUsage(r.Context(), &run); err != nil {
		writePipelineError(w, err)
		return
	}
	writeJSON(w, 200, run)
}
func (h *Handler) ListPipelineRuns(w http.ResponseWriter, r *http.Request) {
	_, ws, ok := h.pipelineMember(w, r, false)
	if !ok {
		return
	}
	var issueID, squadID pgtype.UUID
	if id := r.URL.Query().Get("issue_id"); id != "" {
		issue, ok := h.loadIssueForUser(w, r, id)
		if !ok {
			return
		}
		issueID = issue.ID
	}
	if id := r.URL.Query().Get("squad_id"); id != "" {
		squadID, ok = parseUUIDOrBadRequest(w, id, "squad_id")
		if !ok {
			return
		}
	}
	limit, offset := pipelinePage(r)
	rows, err := h.Queries.ListPipelineRuns(r.Context(), db.ListPipelineRunsParams{WorkspaceID: parseUUID(ws), IssueID: issueID, SquadID: squadID, Limit: limit, Offset: offset})
	if err != nil {
		writePipelineError(w, err)
		return
	}
	out := []pipeline.Run{}
	for _, row := range rows {
		run, e := service.DecodePipelineRun(row)
		if e != nil {
			writePipelineError(w, e)
			return
		}
		if e := h.Pipelines.HydrateUsage(r.Context(), &run); e != nil {
			writePipelineError(w, e)
			return
		}
		out = append(out, run)
	}
	writeJSON(w, 200, map[string]any{"items": out, "limit": limit, "offset": offset})
}
func (h *Handler) GetPipelineJob(w http.ResponseWriter, r *http.Request) {
	row, ok := h.loadPipelineRun(w, r, false)
	if !ok {
		return
	}
	run, err := service.DecodePipelineRun(row)
	if err != nil {
		writePipelineError(w, err)
		return
	}
	if err := h.Pipelines.HydrateUsage(r.Context(), &run); err != nil {
		writePipelineError(w, err)
		return
	}
	job := run.Job(chi.URLParam(r, "job"))
	if job == nil {
		writePipelineError(w, pipeline.Fail("job_not_found", "job not found"))
		return
	}
	writeJSON(w, 200, job)
}

func (h *Handler) CancelPipelineRun(w http.ResponseWriter, r *http.Request) {
	row, ok := h.loadPipelineRun(w, r, true)
	if !ok {
		return
	}
	var req struct {
		Reason         string `json:"reason"`
		IdempotencyKey string `json:"idempotency_key"`
	}
	if !decodePipelineBody(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		writePipelineError(w, pipeline.Fail("reason_required", "cancellation requires a reason"))
		return
	}
	_, err := h.Pipelines.Update(r.Context(), row, func(run *pipeline.Run, _ *db.Queries) error {
		body := []string{"cancel", req.Reason}
		dup, e := run.Receipt(req.IdempotencyKey, body)
		if e != nil || dup {
			return e
		}
		if pipeline.Terminal(run.Status) {
			return pipeline.Fail("revision_conflict", "run is already terminal")
		}
		run.Status = "cancelling"
		run.Reason = req.Reason
		run.Record(req.IdempotencyKey, body)
		return nil
	})
	if err != nil {
		writePipelineError(w, err)
		return
	}
	if err = h.Pipelines.Reconcile(r.Context(), row); err != nil {
		writePipelineError(w, err)
		return
	}
	h.GetPipelineRun(w, r)
}
func (h *Handler) RetryPipelineJob(w http.ResponseWriter, r *http.Request) {
	row, ok := h.loadPipelineRun(w, r, true)
	if !ok {
		return
	}
	var req struct {
		ExpectedRevision int64  `json:"expected_revision"`
		IdempotencyKey   string `json:"idempotency_key"`
	}
	if !decodePipelineBody(w, r, &req) {
		return
	}
	_, err := h.Pipelines.Update(r.Context(), row, func(run *pipeline.Run, _ *db.Queries) error {
		return run.Retry(chi.URLParam(r, "job"), req.ExpectedRevision, req.IdempotencyKey)
	})
	if err != nil {
		writePipelineError(w, err)
		return
	}
	if err = h.Pipelines.Reconcile(r.Context(), row); err != nil {
		writePipelineError(w, err)
		return
	}
	h.GetPipelineRun(w, r)
}
func (h *Handler) DecidePipelineJob(w http.ResponseWriter, r *http.Request) {
	row, ok := h.loadPipelineRun(w, r, true)
	if !ok {
		return
	}
	var req struct {
		ExpectedRevision int64  `json:"expected_revision"`
		IdempotencyKey   string `json:"idempotency_key"`
		Decision         string `json:"decision"`
		Reason           string `json:"reason"`
	}
	if !decodePipelineBody(w, r, &req) {
		return
	}
	run, err := h.Pipelines.Update(r.Context(), row, func(run *pipeline.Run, q *db.Queries) error {
		if err := h.Pipelines.CheckContext(r.Context(), q, run); err != nil {
			return err
		}
		h.Pipelines.RefreshArtifacts(r.Context(), q, run)
		return run.Decide(chi.URLParam(r, "job"), req.ExpectedRevision, req.IdempotencyKey, requestUserID(r), req.Decision, req.Reason, time.Now().UTC().Format(time.RFC3339Nano))
	})
	if err != nil {
		writePipelineError(w, err)
		return
	}
	if run.Status != "rejected" {
		if err = h.Pipelines.Reconcile(r.Context(), row); err != nil {
			writePipelineError(w, err)
			return
		}
	}
	h.GetPipelineRun(w, r)
}
func (h *Handler) ReportPipelineJob(w http.ResponseWriter, r *http.Request) {
	row, ok := h.loadPipelineRun(w, r, false)
	if !ok {
		return
	}
	actor, id := h.resolveActor(r, requestUserID(r), uuidToString(row.WorkspaceID))
	task, exists := h.taskFromRequestHeader(r)
	if !exists || actor != "agent" || id != uuidToString(task.AgentID) {
		writePipelineError(w, pipeline.Fail("report_forbidden", "only the current task executor may report"))
		return
	}
	var req struct {
		pipeline.Report
		Attempt        int    `json:"attempt"`
		IdempotencyKey string `json:"idempotency_key"`
	}
	if !decodePipelineBody(w, r, &req) {
		return
	}
	run, err := h.Pipelines.Report(r.Context(), row, chi.URLParam(r, "job"), task, req.Attempt, req.IdempotencyKey, req.Report)
	if err != nil {
		writePipelineError(w, err)
		return
	}
	if err := h.Pipelines.HydrateUsage(r.Context(), &run); err != nil {
		writePipelineError(w, err)
		return
	}
	writeJSON(w, 200, run)
}
func (h *Handler) ListPipelineArtifacts(w http.ResponseWriter, r *http.Request) {
	row, ok := h.loadPipelineRun(w, r, false)
	if !ok {
		return
	}
	run, err := service.DecodePipelineRun(row)
	if err != nil {
		writePipelineError(w, err)
		return
	}
	h.Pipelines.RefreshArtifacts(r.Context(), h.Queries, &run)
	out := []pipeline.Artifact{}
	job := r.URL.Query().Get("job_id")
	all := run.Artifacts()
	limit, offset := pipelinePage(r)
	for _, v := range all {
		if job == "" || v.JobID == job {
			out = append(out, v)
		}
	}
	end := int(offset + limit)
	if end > len(out) {
		end = len(out)
	}
	start := int(offset)
	if start > end {
		start = end
	}
	writeJSON(w, 200, map[string]any{"items": out[start:end], "limit": limit, "offset": offset})
}

func (h *Handler) initPipelines(github *ghsnapshot.Client) {
	h.Pipelines = &service.PipelineService{Queries: h.Queries, TxStarter: h.TxStarter, Tasks: h.TaskService, CanInvoke: func(ctx context.Context, a db.Agent, user, ws string) bool {
		if _, err := h.getWorkspaceMember(ctx, user, ws); err != nil {
			return false
		}
		return h.canInvokeAgent(ctx, a, "member", user, user, ws)
	}, ArtifactAvailable: func(ctx context.Context, a db.Attachment) bool {
		if h.Storage == nil {
			return false
		}
		reader, err := h.Storage.GetReader(ctx, h.Storage.KeyFromURL(a.Url))
		if err != nil {
			return false
		}
		_ = reader.Close()
		return true
	}}
	h.Pipelines.RepositoryFile = func(ctx context.Context, ws, user, repo, path, ref string) (string, []byte, error) {
		if _, err := h.getWorkspaceMember(ctx, user, ws); err != nil {
			return "", nil, err
		}
		installations, err := h.Queries.ListGitHubInstallationsByWorkspace(ctx, parseUUID(ws))
		if err != nil {
			return "", nil, err
		}
		for _, installation := range installations {
			sha, data, e := github.RepositoryFile(ctx, installation.InstallationID, repo, path, ref)
			if e == nil {
				return sha, data, nil
			}
		}
		return "", nil, fmt.Errorf("repository artifact unavailable")
	}
	h.TaskService.Pipelines = h.Pipelines
	if h.Bus != nil {
		h.Bus.Subscribe("pipeline:updated", func(event events.Event) {
			payload, ok := event.Payload.(map[string]any)
			if !ok {
				return
			}
			id, ok := payload["issue_id"].(string)
			if !ok {
				return
			}
			issue, e := h.Queries.GetIssue(context.Background(), parseUUID(id))
			if e == nil {
				h.AutopilotService.SyncRunFromIssue(context.Background(), issue)
			}
		})
	}
}

func (h *Handler) DownloadPipelineArtifact(w http.ResponseWriter, r *http.Request) {
	row, ok := h.loadPipelineRun(w, r, false)
	if !ok {
		return
	}
	run, err := service.DecodePipelineRun(row)
	if err != nil {
		writePipelineError(w, err)
		return
	}
	for _, artifact := range run.Artifacts() {
		if artifact.ID != r.URL.Query().Get("artifact_id") {
			continue
		}
		if artifact.AttachmentID != "" {
			copy := r.Clone(r.Context())
			rc := chi.NewRouteContext()
			rc.URLParams.Add("id", artifact.AttachmentID)
			copy = copy.WithContext(context.WithValue(copy.Context(), chi.RouteCtxKey, rc))
			h.DownloadAttachment(w, copy)
			return
		}
		if artifact.Repo != "" && artifact.Status == "accessible" {
			sha, data, e := h.Pipelines.RepositoryFile(r.Context(), run.WorkspaceID, requestUserID(r), artifact.Repo, artifact.Path, artifact.SHA)
			if e != nil || sha != artifact.SHA {
				break
			}
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.WriteHeader(200)
			_, _ = w.Write(data)
			return
		}
	}
	writePipelineError(w, pipeline.Fail("artifact_unavailable", "artifact content is unavailable"))
}

func (h *Handler) pipelineOwnsComments(ctx context.Context, issue db.Issue, sourceTaskID pgtype.UUID) bool {
	if sourceTaskID.Valid {
		if task, err := h.Queries.GetAgentTask(ctx, sourceTaskID); err == nil && task.PipelineRunID.Valid {
			return true
		}
	}
	if _, err := h.Queries.GetActivePipelineRun(ctx, db.GetActivePipelineRunParams{WorkspaceID: issue.WorkspaceID, IssueID: issue.ID}); err == nil {
		return true
	}
	if issue.AssigneeType.String == "squad" {
		if squad, err := h.Queries.GetSquadInWorkspace(ctx, db.GetSquadInWorkspaceParams{ID: issue.AssigneeID, WorkspaceID: issue.WorkspaceID}); err == nil && squad.InstructionsMode != "markdown" {
			return true
		}
	}
	return false
}
