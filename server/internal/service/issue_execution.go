package service

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"

	"github.com/multica-ai/multica/server/internal/pipeline"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func issueCreateFingerprint(p IssueCreateParams) (string, error) {
	properties := map[string]json.RawMessage{}
	for id, value := range p.Properties {
		properties[util.UUIDToString(id)] = value
	}
	sourceDigest := ""
	if p.SourceContext != nil {
		sourceDigest = p.SourceContext.Digest
	}
	request := map[string]any{"workspace_id": p.WorkspaceID, "creator_id": p.CreatorID, "creator_type": p.CreatorType, "title": p.Title, "description": p.Description, "status": p.Status, "priority": p.Priority, "assignee_type": p.AssigneeType, "assignee_id": p.AssigneeID, "parent_issue_id": p.ParentIssueID, "project_id": p.ProjectID, "start_date": p.StartDate, "due_date": p.DueDate, "stage": p.Stage, "origin_type": p.OriginType, "origin_id": p.OriginID, "attachment_ids": p.AttachmentIDs, "label_ids": p.LabelIDs, "properties": properties, "allow_duplicate": p.AllowDuplicate, "source_digest": sourceDigest, "execution": p.Execution, "execution_user_id": p.ExecutionUserID}
	data, err := json.Marshal(request)
	if err != nil {
		return "", err
	}
	return pipeline.Fingerprint(json.RawMessage(data)), nil
}

type ExecutionSelection struct {
	Mode         string `json:"mode"`
	PipelineID   string `json:"pipeline_id,omitempty"`
	DefinitionID string `json:"definition_id,omitempty"`
}

// A misspelled version field must not silently select the latest version.
func (s *ExecutionSelection) UnmarshalJSON(data []byte) error {
	type selection ExecutionSelection
	var decoded selection
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return err
	}
	*s = ExecutionSelection(decoded)
	return nil
}

type ExecutionPrincipal struct {
	ActorType string
	ActorID   string
}

type IssueExecution struct {
	RequestedMode      string             `json:"requested_mode"`
	Mode               string             `json:"mode"`
	SquadID            string             `json:"squad_id"`
	PipelineID         string             `json:"pipeline_id,omitempty"`
	PipelineName       string             `json:"pipeline_name,omitempty"`
	DefinitionID       string             `json:"definition_id,omitempty"`
	DefinitionRevision int64              `json:"definition_revision,omitempty"`
	CreatorID          string             `json:"creator_id"`
	Bindings           map[string]string  `json:"bindings,omitempty"`
	Policy             string             `json:"policy"`
	State              string             `json:"state"`
	Readiness          ExecutionReadiness `json:"readiness"`
}

// Old rows have no snapshot and retain legacy assignment behavior. A changed
// assignee cannot accidentally execute a previous squad's frozen selection.
func ExecutionForIssue(issue db.Issue) *IssueExecution {
	if len(issue.Execution) == 0 || issue.AssigneeType.String != "squad" {
		return nil
	}
	var out IssueExecution
	if json.Unmarshal(issue.Execution, &out) != nil || out.SquadID != util.UUIDToString(issue.AssigneeID) {
		return nil
	}
	return &out
}

func SquadExecutionMode(issue db.Issue, squad db.Squad) string {
	if e := ExecutionForIssue(issue); e != nil {
		return e.Mode
	}
	return squad.InstructionsMode
}

func (s *PipelineService) ResolveIssueExecution(ctx context.Context, q *db.Queries, ws, squadID, user string, selection *ExecutionSelection, principal ...ExecutionPrincipal) (*IssueExecution, error) {
	choice := ExecutionSelection{Mode: "default"}
	if selection != nil {
		choice = *selection
	}
	if choice.Mode != "default" && choice.Mode != "markdown" && choice.Mode != "pipeline" {
		return nil, pipeline.Fail("invalid_execution_selection", "mode must be default, markdown or pipeline")
	}
	if choice.Mode != "pipeline" && (choice.PipelineID != "" || choice.DefinitionID != "") {
		return nil, pipeline.Fail("invalid_execution_selection", "only pipeline mode accepts pipeline or definition IDs")
	}
	squad, err := q.LockSquadForUpdate(ctx, db.LockSquadForUpdateParams{ID: pipelineUUID(squadID), WorkspaceID: pipelineUUID(ws)})
	if err != nil {
		return nil, pipeline.Fail("pipeline_not_owned", "squad not found in this workspace")
	}
	if squad.ArchivedAt.Valid {
		return nil, pipeline.Fail("squad_archived", "squad is archived")
	}
	mode := choice.Mode
	if mode == "default" {
		mode = squad.InstructionsMode
	}
	out := &IssueExecution{RequestedMode: choice.Mode, Mode: mode, SquadID: squadID, CreatorID: user, Policy: squad.Instructions, State: "ready", Readiness: ExecutionReadiness{Ready: true, Runtimes: []RuntimeCompatibility{}}}
	if mode == "markdown" {
		leader, e := q.GetAgent(ctx, squad.LeaderID)
		if e != nil || leader.ArchivedAt.Valid || leader.WorkspaceID != squad.WorkspaceID {
			return nil, pipeline.Fail("role_unbound", "squad leader is unavailable")
		}
		allowed := s.CanInvoke != nil && s.CanInvoke(ctx, q, leader, user, ws)
		if s.CanInvokeMarkdown != nil && len(principal) > 0 {
			p := principal[0]
			allowed = s.CanInvokeMarkdown(ctx, q, leader, p.ActorType, p.ActorID, user, ws)
		}
		if !allowed {
			return nil, pipeline.Fail("invocation_forbidden", "you do not have permission to assign work to this squad")
		}
		return out, nil
	}
	if mode != "pipeline" {
		return nil, pipeline.Fail("unsupported_capability", "unknown squad instructions_mode")
	}
	defID := squad.PipelineDefinitionID
	if choice.Mode == "pipeline" {
		if choice.PipelineID == "" {
			return nil, pipeline.Fail("invalid_execution_selection", "pipeline_id is required for a task-level pipeline selection")
		}
		p, e := q.GetSquadPipeline(ctx, db.GetSquadPipelineParams{ID: pipelineUUID(choice.PipelineID), WorkspaceID: squad.WorkspaceID})
		if e != nil || p.SquadID != squad.ID {
			return nil, pipeline.Fail("pipeline_not_owned", "pipeline must belong to this squad")
		}
		choice.PipelineID = util.UUIDToString(p.ID)
		defID = p.ExecutableDefinitionID
		if choice.DefinitionID != "" {
			defID = pipelineUUID(choice.DefinitionID)
		}
	}
	if !defID.Valid {
		return nil, pipeline.Fail("definition_not_executable", "pipeline has no executable version")
	}
	d, err := q.GetPipelineDefinition(ctx, db.GetPipelineDefinitionParams{ID: defID, WorkspaceID: squad.WorkspaceID})
	if err != nil || d.SquadID != squad.ID || (choice.Mode == "pipeline" && util.UUIDToString(d.PipelineID) != choice.PipelineID) {
		return nil, pipeline.Fail("definition_not_owned", "definition must belong to the selected pipeline and squad")
	}
	p, err := q.GetSquadPipeline(ctx, db.GetSquadPipelineParams{ID: d.PipelineID, WorkspaceID: squad.WorkspaceID})
	if err != nil {
		return nil, err
	}
	validation := pipeline.Compile(d.Source)
	if !validation.SyntaxValid || validation.Plan == nil || validation.Plan.SourceHash != d.SourceHash {
		return nil, pipeline.Fail("definition_not_executable", "saved definition does not compile with this server")
	}
	bindings, diags := s.Bindings(ctx, q, squad, *validation.Plan, user)
	if len(diags) > 0 {
		return nil, pipeline.Fail(diags[0].Code, diags[0].Message)
	}
	out.PipelineID = util.UUIDToString(p.ID)
	out.PipelineName = p.Name
	out.DefinitionID = util.UUIDToString(d.ID)
	out.DefinitionRevision = d.Revision
	out.Bindings = bindings
	out.Readiness, err = s.ExecutionReadiness(ctx, q, ws, bindings)
	if err != nil {
		return nil, err
	}
	if !out.Readiness.Ready {
		out.State = "waiting_runtime"
	}
	return out, nil
}

func (s *PipelineService) CheckFrozenExecution(ctx context.Context, q *db.Queries, issue db.Issue, e *IssueExecution, user string) (ExecutionReadiness, error) {
	for job, id := range e.Bindings {
		if strings.HasPrefix(job, "owner:") {
			continue
		}
		a, err := q.GetAgent(ctx, pipelineUUID(id))
		if err != nil || a.ArchivedAt.Valid || a.WorkspaceID != issue.WorkspaceID {
			return ExecutionReadiness{}, pipeline.Fail("role_unbound", "frozen executor is unavailable")
		}
		if s.CanInvoke == nil || !s.CanInvoke(ctx, q, a, e.CreatorID, util.UUIDToString(issue.WorkspaceID)) || !s.CanInvoke(ctx, q, a, user, util.UUIDToString(issue.WorkspaceID)) {
			return ExecutionReadiness{}, pipeline.Fail("invocation_forbidden", "execution permission no longer available")
		}
	}
	return s.ExecutionReadiness(ctx, q, util.UUIDToString(issue.WorkspaceID), e.Bindings)
}

func (s *PipelineService) StartFrozenExecution(ctx context.Context, issue db.Issue, user string) (pipeline.Run, error) {
	e := ExecutionForIssue(issue)
	if e == nil || e.Mode != "pipeline" {
		return pipeline.Run{}, pipeline.Fail("invalid_execution_selection", "issue has no frozen pipeline selection")
	}
	return s.Start(ctx, issue, e.SquadID, "", user, "execution:"+util.UUIDToString(issue.ID))
}
