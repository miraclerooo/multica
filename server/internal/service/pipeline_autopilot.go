package service

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/pipeline"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (s *AutopilotService) pipelineSquadAdmission(ctx context.Context, ap db.Autopilot, actor, trigger pgtype.UUID) (bool, error) {
	if ap.AssigneeType != "squad" {
		return false, nil
	}
	sq, err := s.Queries.GetSquadInWorkspace(ctx, db.GetSquadInWorkspaceParams{ID: ap.AssigneeID, WorkspaceID: ap.WorkspaceID})
	if err != nil || sq.InstructionsMode != "pipeline" {
		if err == nil && sq.InstructionsMode != "markdown" {
			return true, pipeline.Fail("unsupported_capability", "unknown squad instructions_mode")
		}
		return false, err
	}
	if ap.ExecutionMode != "create_issue" {
		return true, pipeline.Fail("unsupported_capability", "pipeline squads require create_issue automation")
	}
	if s.TaskSvc.Pipelines == nil {
		return true, pipeline.Fail("unsupported_capability", "pipeline service unavailable")
	}
	if sq.ArchivedAt.Valid {
		return true, errSquadArchived
	}
	if !actor.Valid {
		actor = ResolveAutopilotTriggerPrincipal(ctx, s.Queries, trigger, ap.ID, ap.WorkspaceID)
	}
	d, err := s.Queries.GetPipelineDefinition(ctx, db.GetPipelineDefinitionParams{ID: sq.PipelineDefinitionID, WorkspaceID: ap.WorkspaceID})
	if err != nil || d.SquadID != sq.ID {
		return true, pipeline.Fail("definition_not_owned", "squad needs an owned definition")
	}
	var plan pipeline.Plan
	if err = json.Unmarshal(d.Plan, &plan); err != nil {
		return true, err
	}
	_, diagnostics := s.TaskSvc.Pipelines.Bindings(ctx, s.Queries, sq, plan, util.UUIDToString(actor))
	if len(diagnostics) > 0 {
		return true, pipeline.Fail(diagnostics[0].Code, diagnostics[0].Message)
	}
	return true, nil
}

// An individual node process never settles automation. Wait for the persisted
// aggregate, including every configured human gate and required artifact.
func (s *AutopilotService) syncPipelineAutopilotRun(ctx context.Context, run db.AutopilotRun) bool {
	ap, err := s.Queries.GetAutopilot(ctx, run.AutopilotID)
	if err != nil {
		return false
	}
	row, err := s.Queries.GetLatestPipelineRunForIssue(ctx, db.GetLatestPipelineRunForIssueParams{WorkspaceID: ap.WorkspaceID, IssueID: run.IssueID})
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return true
		}
		if ap.AssigneeType == "squad" {
			sq, e := s.Queries.GetSquadInWorkspace(ctx, db.GetSquadInWorkspaceParams{ID: ap.AssigneeID, WorkspaceID: ap.WorkspaceID})
			return e == nil && sq.InstructionsMode == "pipeline"
		}
		return false
	}
	if !pipeline.Terminal(row.Status) {
		return true
	}
	if row.Status == "succeeded" {
		updated, e := s.completeAutopilotRun(ctx, db.UpdateAutopilotRunCompletedParams{ID: run.ID})
		if e == nil {
			s.captureAutopilotRunCompleted(ap, updated)
			s.publishRunDone(util.UUIDToString(ap.WorkspaceID), updated, "completed")
		}
	} else {
		reason := "pipeline " + row.Status
		updated, e := s.failAutopilotRun(ctx, db.UpdateAutopilotRunFailedParams{ID: run.ID, FailureReason: pgtype.Text{String: reason, Valid: true}})
		if e == nil {
			s.captureAutopilotRunFailed(ap, updated, updated.Source, reason)
			s.publishRunDone(util.UUIDToString(ap.WorkspaceID), updated, "failed")
		}
	}
	return true
}
