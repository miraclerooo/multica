package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/issueworkflow"
	"github.com/multica-ai/multica/server/internal/pipeline"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func (s *PipelineService) CheckContext(ctx context.Context, q *db.Queries, run *pipeline.Run) error {
	issue, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: pipelineUUID(run.IssueID), WorkspaceID: pipelineUUID(run.WorkspaceID)})
	if err != nil {
		return err
	}
	workflow, _, err := issueworkflow.ForProject(ctx, q, issue.WorkspaceID, issue.ProjectID)
	if err != nil {
		return err
	}
	workflowID := ""
	if workflow != nil && (!workflow.IsDefault || workflow.HandsOffAnywhere()) {
		workflowID = util.UUIDToString(workflow.ID)
	}
	if issue.Title != run.IssueTitle || issue.Description.String != run.IssueDescription || issue.AssigneeType.String != "squad" || util.UUIDToString(issue.AssigneeID) != run.SquadID || util.UUIDToString(issue.ProjectID) != run.ProjectID || workflowID != run.WorkflowID || (run.WorkflowStep != "" && issue.Status != run.WorkflowStep) || (run.WorkflowStep == "" && issue.Status != run.ProjectedStatus) {
		return pipeline.Fail("issue_context_changed", "issue scope, assignment or workflow changed")
	}
	return nil
}

func (s *PipelineService) Reconcile(ctx context.Context, row db.PipelineRun) error {
	queued := []db.AgentTaskQueue{}
	cancelIDs := []pgtype.UUID{}
	items := []db.InboxItem{}
	run, err := s.Update(ctx, row, func(run *pipeline.Run, q *db.Queries) error {
		if pipeline.Terminal(run.Status) {
			return nil
		}
		issue, err := q.GetIssueInWorkspace(ctx, db.GetIssueInWorkspaceParams{ID: row.IssueID, WorkspaceID: row.WorkspaceID})
		if err != nil {
			return err
		}
		if err = s.CheckContext(ctx, q, run); err != nil {
			var changed *pipeline.Error
			if !errors.As(err, &changed) {
				return err
			}
			run.Status = "cancelling"
			run.Reason = "issue_context_changed"
		}
		if run.Status == "cancelling" {
			for i := range run.Jobs {
				job := &run.Jobs[i]
				if pipeline.Terminal(job.Status) {
					continue
				}
				if a := job.Current(); a != nil {
					task, e := q.GetAgentTask(ctx, pipelineUUID(a.TaskID))
					if e != nil {
						return e
					}
					if task.Status != "completed" && task.Status != "failed" && task.Status != "cancelled" {
						cancelIDs = append(cancelIDs, task.ID)
						continue
					}
					a.Status = task.Status
					if task.StartedAt.Valid {
						a.StartedAt = task.StartedAt.Time.UTC().Format(time.RFC3339Nano)
					}
					if task.CompletedAt.Valid {
						a.CompletedAt = task.CompletedAt.Time.UTC().Format(time.RFC3339Nano)
					}
				}
				job.Set("cancelled", run.Reason)
			}
			run.Summarize()
			return nil
		}
		s.RefreshArtifacts(ctx, q, run)
		for i := range run.Jobs {
			job := &run.Jobs[i]
			if job.Status != "queued" && job.Status != "running" {
				continue
			}
			a := job.Current()
			if a == nil {
				return fmt.Errorf("pipeline job has no registered attempt")
			}
			task, e := q.GetAgentTask(ctx, pipelineUUID(a.TaskID))
			if e != nil {
				return e
			}
			a.Status = task.Status
			if task.StartedAt.Valid {
				a.StartedAt = task.StartedAt.Time.UTC().Format(time.RFC3339Nano)
			}
			if task.CompletedAt.Valid {
				a.CompletedAt = task.CompletedAt.Time.UTC().Format(time.RFC3339Nano)
			}
			switch task.Status {
			case "completed", "failed", "cancelled":
				run.Finish(job, task.Status)
			case "running":
				job.Set("running", "")
			}
		}
		run.Advance()
		for i := range run.Jobs {
			job := &run.Jobs[i]
			if job.Status != "ready" {
				continue
			}
			agent, e := q.GetAgent(ctx, pipelineUUID(job.ExecutorID))
			if e != nil || agent.ArchivedAt.Valid || agent.WorkspaceID != row.WorkspaceID {
				job.Set("blocked", "executor_unavailable")
				continue
			}
			if s.CanInvoke == nil || !s.CanInvoke(ctx, agent, run.CreatorID, run.WorkspaceID) {
				job.Set("blocked", "invocation_forbidden")
				continue
			}
			if !agent.RuntimeID.Valid {
				job.Set("blocked", "runtime_unavailable")
				continue
			}
			pending, e := q.HasPendingTaskForIssueAndAgent(ctx, db.HasPendingTaskForIssueAndAgentParams{IssueID: issue.ID, AgentID: agent.ID})
			if e != nil {
				return e
			}
			if pending {
				continue
			}
			inputs, available := run.Inputs(job)
			if !available {
				job.Set("blocked", "artifact_unavailable")
				continue
			}
			task, e := s.Tasks.createPipelineTask(ctx, q, issue, agent, run.CreatorID, run.Brief(job))
			if e != nil {
				return e
			}
			number := len(job.Attempts) + 1
			if e = q.RegisterPipelineTask(ctx, db.RegisterPipelineTaskParams{ID: task.ID, PipelineRunID: row.ID, PipelineJobID: pgtype.Text{String: job.Node.ID, Valid: true}, PipelineAttempt: pgtype.Int4{Int32: int32(number), Valid: true}}); e != nil {
				return e
			}
			task.PipelineRunID = row.ID
			task.PipelineJobID = pgtype.Text{String: job.Node.ID, Valid: true}
			task.PipelineAttempt = pgtype.Int4{Int32: int32(number), Valid: true}
			job.Attempts = append(job.Attempts, pipeline.Attempt{Number: number, TaskID: util.UUIDToString(task.ID), ExecutorID: job.ExecutorID, Status: "queued", Inputs: inputs})
			job.Set("queued", "")
			queued = append(queued, task)
		}
		run.Summarize()
		for i := range run.Jobs {
			job := &run.Jobs[i]
			stamp := fmt.Sprintf("%d:%s", len(job.Attempts), job.Status)
			if job.OwnerID == "" || job.NotifiedStatus == stamp || (job.Status != "waiting_approval" && job.Status != "failed" && job.Status != "blocked") {
				continue
			}
			details, _ := json.Marshal(map[string]any{"pipeline_run_id": run.ID, "job_id": job.Node.ID, "status": job.Status})
			item, e := q.CreateInboxItem(ctx, db.CreateInboxItemParams{ID: dbid.NewV7(), WorkspaceID: row.WorkspaceID, RecipientType: "member", RecipientID: pipelineUUID(job.OwnerID), Type: "pipeline_job", Severity: "info", IssueID: row.IssueID, Title: job.Node.Title + ": " + job.Status, Body: pgtype.Text{String: job.Reason, Valid: job.Reason != ""}, ActorType: pgtype.Text{String: "system", Valid: true}, Details: details})
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
			if e == nil {
				items = append(items, item)
			}
			job.NotifiedStatus = stamp
		}
		if run.WorkflowStep == "" {
			target := "in_progress"
			switch run.Status {
			case "succeeded":
				target = "in_review"
			case "failed", "blocked":
				target = "blocked"
			case "waiting_approval":
				final := true
				for _, job := range run.Jobs {
					if job.Node.Type == "agent" && !pipeline.Terminal(job.Status) {
						final = false
					}
				}
				if final {
					target = "in_review"
				}
			}
			if issue.Status != target {
				n, e := q.ProjectPipelineIssueStatus(ctx, db.ProjectPipelineIssueStatusParams{ID: issue.ID, WorkspaceID: issue.WorkspaceID, Status: target, Status_2: run.ProjectedStatus, AssigneeID: issue.AssigneeID})
				if e != nil {
					return e
				}
				if n > 0 {
					run.ProjectedStatus = target
				}
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	for _, task := range queued {
		s.Tasks.broadcastTaskEvent(ctx, protocol.EventTaskQueued, task)
		s.Tasks.NotifyTaskEnqueued(ctx, task)
	}
	for _, item := range items {
		if s.Tasks.Bus != nil {
			s.Tasks.publishQuickCreateInbox(item, run.WorkspaceID, "", run.ProjectedStatus)
		}
	}
	for _, id := range cancelIDs {
		if _, e := s.Tasks.CancelTask(ctx, id); e != nil {
			return e
		}
	}
	if len(cancelIDs) > 0 {
		return s.Reconcile(ctx, row)
	}
	if s.Tasks.Bus != nil && run.Revision != row.Revision {
		s.Tasks.Bus.Publish(events.Event{Type: "pipeline:updated", WorkspaceID: run.WorkspaceID, ActorType: "system", Payload: map[string]any{"run_id": run.ID, "issue_id": run.IssueID, "status": run.Status}})
	}
	return nil
}

func (s *TaskService) createPipelineTask(ctx context.Context, q *db.Queries, issue db.Issue, agent db.Agent, user, brief string) (db.AgentTaskQueue, error) {
	overlay := s.buildRuntimeMCPOverlay(ctx, pipelineUUID(user), agent)
	return q.CreateAgentTask(ctx, db.CreateAgentTaskParams{ID: dbid.NewV7(), AgentID: agent.ID, RuntimeID: agent.RuntimeID, IssueID: issue.ID, Priority: priorityToInt(issue.Priority), ForceFreshSession: pgtype.Bool{Bool: true, Valid: true}, FreshRerun: pgtype.Bool{Bool: true, Valid: true}, HandoffNote: pgtype.Text{String: brief, Valid: true}, OriginatorUserID: pipelineUUID(user), AccountableUserID: pipelineUUID(user), OriginatorSource: pgtype.Text{String: "direct_human", Valid: true}, RuntimeMcpOverlay: overlay.Overlay, RuntimeConnectedApps: overlay.ConnectedApps})
}
func (s *PipelineService) Recover(ctx context.Context) {
	for offset := int32(0); ; offset += 500 {
		rows, err := s.Queries.ListActivePipelineRuns(ctx, db.ListActivePipelineRunsParams{Limit: 500, Offset: offset})
		if err != nil {
			slog.Error("list pipeline recovery candidates", "error", err)
			return
		}
		for _, row := range rows {
			if e := s.Reconcile(ctx, row); e != nil {
				slog.Error("reconcile pipeline", "run_id", util.UUIDToString(row.ID), "error", e)
			}
		}
		if len(rows) < 500 {
			return
		}
	}
}

func (s *PipelineService) TaskFinished(ctx context.Context, task db.AgentTaskQueue) {
	if !task.PipelineRunID.Valid {
		return
	}
	issue, err := s.Queries.GetIssue(ctx, task.IssueID)
	if err != nil {
		return
	}
	row, err := s.Queries.GetPipelineRun(ctx, db.GetPipelineRunParams{ID: task.PipelineRunID, WorkspaceID: issue.WorkspaceID})
	if err == nil {
		err = s.Reconcile(ctx, row)
	}
	if err != nil {
		slog.Error("pipeline task completion", "task_id", util.UUIDToString(task.ID), "error", err)
	}
}

func (s *PipelineService) CheckTask(ctx context.Context, task db.AgentTaskQueue) error {
	issue, err := s.Queries.GetIssue(ctx, task.IssueID)
	if err != nil {
		return err
	}
	row, err := s.Queries.GetPipelineRun(ctx, db.GetPipelineRunParams{ID: task.PipelineRunID, WorkspaceID: issue.WorkspaceID})
	if err != nil {
		return err
	}
	run, err := DecodePipelineRun(row)
	if err != nil {
		return err
	}
	if err = s.CheckContext(ctx, s.Queries, &run); err != nil {
		return err
	}
	job := run.Job(task.PipelineJobID.String)
	if pipeline.Terminal(run.Status) || run.Status == "cancelling" || job == nil || job.Current() == nil || job.Current().TaskID != util.UUIDToString(task.ID) {
		return pipeline.Fail("revision_conflict", "pipeline task is no longer current")
	}
	agent, err := s.Queries.GetAgent(ctx, task.AgentID)
	if err != nil || agent.ArchivedAt.Valid || s.CanInvoke == nil || !s.CanInvoke(ctx, agent, run.CreatorID, run.WorkspaceID) {
		return pipeline.Fail("invocation_forbidden", "pipeline executor permission changed")
	}
	return nil
}
