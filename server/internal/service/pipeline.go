package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issuestatus"
	"github.com/multica-ai/multica/server/internal/issueworkflow"
	"github.com/multica-ai/multica/server/internal/pipeline"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type PipelineService struct {
	Queries           *db.Queries
	TxStarter         TxStarter
	Tasks             *TaskService
	CanInvoke         func(context.Context, db.Agent, string, string) bool
	ArtifactAvailable func(context.Context, db.Attachment) bool
	RepositoryFile    func(context.Context, string, string, string, string, string) (string, []byte, error)
}

func pipelineUUID(s string) pgtype.UUID { v, _ := util.ParseUUID(s); return v }

func (s *PipelineService) Bindings(ctx context.Context, q *db.Queries, squad db.Squad, plan pipeline.Plan, user string) (map[string]string, []pipeline.Diagnostic) {
	bindings := map[string]string{}
	diagnostics := []pipeline.Diagnostic{}
	members, err := q.ListSquadMembers(ctx, squad.ID)
	if err != nil {
		return bindings, []pipeline.Diagnostic{{Code: "binding_unavailable", Severity: "error", Message: "could not read squad members"}}
	}
	for _, node := range plan.Nodes {
		add := func(code, field, message string) {
			diagnostics = append(diagnostics, pipeline.Diagnostic{Code: code, Severity: "error", Message: message, JobID: node.ID, Field: field, Location: node.Location})
		}
		if node.Owner != "" {
			count := 0
			for _, m := range members {
				if m.MemberType == "member" && strings.EqualFold(strings.TrimSpace(m.Role), strings.TrimSpace(node.Owner)) {
					if _, e := q.GetMemberByUserAndWorkspace(ctx, db.GetMemberByUserAndWorkspaceParams{UserID: m.MemberID, WorkspaceID: squad.WorkspaceID}); e == nil {
						count++
						bindings["owner:"+node.ID] = util.UUIDToString(m.MemberID)
					}
				}
			}
			if count != 1 {
				add("owner_unbound", "owner", "owner must match exactly one human squad member")
			}
		}
		if node.Type == "manual" {
			continue
		}
		target := squad.LeaderID
		if node.Role != "" {
			matches := []pgtype.UUID{}
			for _, m := range members {
				if strings.EqualFold(strings.TrimSpace(m.Role), strings.TrimSpace(node.Role)) {
					if m.MemberType == "agent" {
						matches = append(matches, m.MemberID)
					} else {
						add("role_unbound", "role", "selected role belongs to a human")
					}
				}
			}
			if len(matches) == 0 {
				add("role_unbound", "role", "selected role has no agent")
				continue
			}
			if len(matches) > 1 {
				add("role_ambiguous", "role", "selected role matches multiple agents")
				continue
			}
			target = matches[0]
		}
		agent, e := q.GetAgent(ctx, target)
		if e != nil || agent.WorkspaceID != squad.WorkspaceID || agent.ArchivedAt.Valid {
			add("role_unbound", "role", "executor is unavailable")
			continue
		}
		if s.CanInvoke == nil || !s.CanInvoke(ctx, agent, user, util.UUIDToString(squad.WorkspaceID)) {
			add("invocation_forbidden", "role", "triggering member cannot invoke this executor")
			continue
		}
		bindings[node.ID] = util.UUIDToString(target)
	}
	return bindings, diagnostics
}

// The squad lock serializes version allocation and optional activation. Source
// text is stored byte-for-byte; each compiler reads its own dialect directly.
func (s *PipelineService) SaveDefinition(ctx context.Context, ws, squadID, user, source, key string, activate bool, expected int64) (db.PipelineDefinition, error) {
	var out db.PipelineDefinition
	v := pipeline.Compile(source)
	if !v.SyntaxValid {
		return out, pipeline.Fail("invalid_definition", "source does not compile")
	}
	if strings.TrimSpace(key) == "" || len(key) > 200 {
		return out, pipeline.Fail("idempotency_key_required", "idempotency key is required")
	}

	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	q := s.Queries.WithTx(tx)
	squad, err := q.LockSquadForUpdate(ctx, db.LockSquadForUpdateParams{ID: pipelineUUID(squadID), WorkspaceID: pipelineUUID(ws)})
	if err != nil {
		return out, err
	}
	if squad.ArchivedAt.Valid {
		return out, pipeline.Fail("squad_archived", "squad is archived")
	}
	old, e := q.GetPipelineDefinitionByKey(ctx, db.GetPipelineDefinitionByKeyParams{WorkspaceID: squad.WorkspaceID, SquadID: squad.ID, IdempotencyKey: key})
	if e == nil {
		if old.Source != source {
			return out, pipeline.Fail("idempotency_conflict", "key already used for different source")
		}
		if activate && squad.PipelineDefinitionID != old.ID {
			return out, pipeline.Fail("revision_conflict", "saved version is no longer active; bind it explicitly")
		}
		return old, nil
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return out, e
	}
	if activate {
		if expected != squad.Revision {
			return out, pipeline.Fail("revision_conflict", "squad revision changed")
		}
		if _, d := s.Bindings(ctx, q, squad, *v.Plan, user); len(d) > 0 {
			return out, pipeline.Fail(d[0].Code, d[0].Message)
		}
	}
	plan, _ := json.Marshal(v.Plan)
	out, err = q.CreatePipelineDefinition(ctx, db.CreatePipelineDefinitionParams{ID: dbid.NewV7(), WorkspaceID: squad.WorkspaceID, SquadID: squad.ID, Kind: v.Kind, Source: source, SourceHash: v.Plan.SourceHash, CompilerVersion: pipeline.CompilerVersion, Plan: plan, CreatorID: pipelineUUID(user), IdempotencyKey: key})
	if err != nil {
		return out, err
	}
	if activate {
		_, err = q.SetSquadPipeline(ctx, db.SetSquadPipelineParams{ID: squad.ID, WorkspaceID: squad.WorkspaceID, InstructionsMode: "pipeline", PipelineDefinitionID: out.ID, Revision: expected})
		if err != nil {
			return out, err
		}
	}
	return out, tx.Commit(ctx)
}

func DecodePipelineRun(row db.PipelineRun) (pipeline.Run, error) {
	var run pipeline.Run
	err := json.Unmarshal(row.State, &run)
	if err != nil {
		return run, err
	}
	run.Revision = row.Revision
	run.CreatedAt = row.CreatedAt.Time.UTC().Format(time.RFC3339Nano)
	run.UpdatedAt = row.UpdatedAt.Time.UTC().Format(time.RFC3339Nano)
	return run, nil
}

func (s *PipelineService) Start(ctx context.Context, issue db.Issue, squadID, definitionID, user, key string, notes ...string) (pipeline.Run, error) {
	var out pipeline.Run
	if strings.TrimSpace(key) == "" || len(key) > 200 {
		return out, pipeline.Fail("idempotency_key_required", "idempotency key is required")
	}
	if active, e := s.Queries.GetActivePipelineRun(ctx, db.GetActivePipelineRunParams{WorkspaceID: issue.WorkspaceID, IssueID: issue.ID}); e == nil {
		previous, e := DecodePipelineRun(active)
		if e != nil {
			return out, e
		}
		var changed *pipeline.Error
		if e = s.CheckContext(ctx, s.Queries, &previous); errors.As(e, &changed) && changed.Code == "issue_context_changed" {
			if e = s.Reconcile(ctx, active); e != nil {
				return out, e
			}
		} else if e != nil {
			return out, e
		}
	} else if !errors.Is(e, pgx.ErrNoRows) {
		return out, e
	}
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	q := s.Queries.WithTx(tx)
	issue, err = q.LockPipelineIssue(ctx, db.LockPipelineIssueParams{ID: issue.ID, WorkspaceID: issue.WorkspaceID})
	if err != nil {
		return out, err
	}
	hash := pipeline.Fingerprint([]string{squadID, definitionID, user})
	old, e := q.GetPipelineRunByKey(ctx, db.GetPipelineRunByKeyParams{WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, IdempotencyKey: key})
	if e == nil {
		if old.RequestHash != hash {
			return out, pipeline.Fail("idempotency_conflict", "key already used for another run request")
		}
		return DecodePipelineRun(old)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return out, e
	}
	if _, e = q.GetActivePipelineRun(ctx, db.GetActivePipelineRunParams{WorkspaceID: issue.WorkspaceID, IssueID: issue.ID}); e == nil {
		return out, pipeline.Fail("active_run_exists", "issue already has an active pipeline")
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return out, e
	}
	if issue.AssigneeType.String != "squad" || util.UUIDToString(issue.AssigneeID) != squadID {
		return out, pipeline.Fail("assignee_conflict", "issue must be assigned to this squad")
	}
	category := issuestatus.Category(ctx, q, issue.WorkspaceID, issue.Status)
	if issue.Status == "backlog" || category == "done" || category == "cancelled" || issue.TriageState.Valid {
		return out, pipeline.Fail("issue_not_runnable", "issue is parked, terminal or in triage")
	}
	squad, err := q.GetSquadInWorkspace(ctx, db.GetSquadInWorkspaceParams{ID: pipelineUUID(squadID), WorkspaceID: issue.WorkspaceID})
	if err != nil {
		return out, err
	}
	if squad.ArchivedAt.Valid {
		return out, pipeline.Fail("squad_archived", "squad is archived")
	}
	if squad.InstructionsMode != "pipeline" {
		return out, pipeline.Fail("mode_conflict", "squad is not in pipeline mode")
	}
	defID := squad.PipelineDefinitionID
	if definitionID != "" {
		defID = pipelineUUID(definitionID)
	}
	d, err := q.GetPipelineDefinition(ctx, db.GetPipelineDefinitionParams{ID: defID, WorkspaceID: issue.WorkspaceID})
	if err != nil || d.SquadID != squad.ID {
		return out, pipeline.Fail("definition_not_owned", "definition must belong to this squad")
	}
	var plan pipeline.Plan
	if err = json.Unmarshal(d.Plan, &plan); err != nil {
		return out, err
	}
	bindings, diags := s.Bindings(ctx, q, squad, plan, user)
	if len(diags) > 0 {
		return out, pipeline.Fail(diags[0].Code, diags[0].Message)
	}
	out = pipeline.NewRun(plan, bindings)
	out.ID = util.UUIDToString(dbid.NewV7())
	out.WorkspaceID = util.UUIDToString(issue.WorkspaceID)
	out.IssueID = util.UUIDToString(issue.ID)
	out.SquadID = squadID
	out.DefinitionID = util.UUIDToString(d.ID)
	out.CreatorID = user
	out.Policy = squad.Instructions
	if len(notes) > 0 && notes[0] != "" {
		out.Policy += "\n\nWorkflow handoff:\n" + notes[0]
	}
	out.IssueTitle = issue.Title
	out.IssueDescription = issue.Description.String
	out.IssueRevision = issue.Revision
	out.ProjectID = util.UUIDToString(issue.ProjectID)
	out.ProjectedStatus = issue.Status
	workflow, _, err := issueworkflow.ForProject(ctx, q, issue.WorkspaceID, issue.ProjectID)
	if err != nil {
		return out, err
	}
	if workflow != nil && (!workflow.IsDefault || workflow.HandsOffAnywhere()) {
		out.WorkflowID = util.UUIDToString(workflow.ID)
		out.WorkflowStep = issue.Status
	}
	state, _ := json.Marshal(out)
	row, err := q.CreatePipelineRun(ctx, db.CreatePipelineRunParams{ID: pipelineUUID(out.ID), WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, SquadID: squad.ID, DefinitionID: d.ID, CreatorID: pipelineUUID(user), IdempotencyKey: key, RequestHash: hash, Status: out.Status, State: state})
	if err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	if err = s.Reconcile(ctx, row); err != nil {
		return out, err
	}
	row, err = s.Queries.GetPipelineRun(ctx, db.GetPipelineRunParams{ID: row.ID, WorkspaceID: row.WorkspaceID})
	if err != nil {
		return out, err
	}
	return DecodePipelineRun(row)
}

// Every write locks issue then run. This also serializes decisions, retries and
// task registration across API workers and service restarts.
func (s *PipelineService) Update(ctx context.Context, row db.PipelineRun, fn func(*pipeline.Run, *db.Queries) error) (pipeline.Run, error) {
	var run pipeline.Run
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return run, err
	}
	defer tx.Rollback(ctx)
	q := s.Queries.WithTx(tx)
	if _, err = q.LockPipelineIssue(ctx, db.LockPipelineIssueParams{ID: row.IssueID, WorkspaceID: row.WorkspaceID}); err != nil {
		return run, err
	}
	row, err = q.LockPipelineRun(ctx, db.LockPipelineRunParams{ID: row.ID, WorkspaceID: row.WorkspaceID})
	if err != nil {
		return run, err
	}
	run, err = DecodePipelineRun(row)
	if err != nil {
		return run, err
	}
	before, _ := json.Marshal(run)
	if err = fn(&run, q); err != nil {
		return run, err
	}
	state, _ := json.Marshal(run)
	if string(before) == string(state) {
		return run, tx.Commit(ctx)
	}
	row, err = q.UpdatePipelineRun(ctx, db.UpdatePipelineRunParams{ID: row.ID, WorkspaceID: row.WorkspaceID, State: state, Status: run.Status})
	if err != nil {
		return run, err
	}
	if err = tx.Commit(ctx); err != nil {
		return run, err
	}
	run.Revision = row.Revision
	run.UpdatedAt = row.UpdatedAt.Time.UTC().Format(time.RFC3339Nano)
	return run, nil
}

func (s *TaskService) enqueuePipelineSquad(ctx context.Context, issue db.Issue, squadID, actor, commentID pgtype.UUID, note string) (db.AgentTaskQueue, bool, error) {
	squad, err := s.Queries.GetSquadInWorkspace(ctx, db.GetSquadInWorkspaceParams{ID: squadID, WorkspaceID: issue.WorkspaceID})
	if err != nil || squad.InstructionsMode == "markdown" {
		return db.AgentTaskQueue{}, false, nil
	}
	if squad.InstructionsMode != "pipeline" {
		return db.AgentTaskQueue{}, true, pipeline.Fail("unsupported_capability", "unknown squad instructions_mode")
	}
	if commentID.Valid {
		return db.AgentTaskQueue{}, true, nil
	}
	if s.Pipelines == nil {
		return db.AgentTaskQueue{}, true, pipeline.Fail("unsupported_capability", "pipeline service unavailable")
	}
	if !actor.Valid {
		actor = s.OriginatorForIssueTask(ctx, issue, pgtype.UUID{})
	}
	run, err := s.Pipelines.Start(ctx, issue, util.UUIDToString(squadID), "", util.UUIDToString(actor), fmt.Sprintf("assignment:%d", issue.Revision), note)
	var e *pipeline.Error
	if errors.As(err, &e) && e.Code == "active_run_exists" {
		row, lookupErr := s.Queries.GetActivePipelineRun(ctx, db.GetActivePipelineRunParams{WorkspaceID: issue.WorkspaceID, IssueID: issue.ID})
		if lookupErr != nil {
			return db.AgentTaskQueue{}, true, lookupErr
		}
		run, err = DecodePipelineRun(row)
	}
	if err != nil {
		return db.AgentTaskQueue{}, true, err
	}
	for _, job := range run.Jobs {
		if a := job.Current(); a != nil {
			task, e := s.Queries.GetAgentTask(ctx, pipelineUUID(a.TaskID))
			return task, true, e
		}
	}
	return db.AgentTaskQueue{}, true, nil
}
