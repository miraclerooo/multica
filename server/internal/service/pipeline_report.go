package service

import (
	"context"
	"fmt"
	"strings"

	"github.com/multica-ai/multica/server/internal/pipeline"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (s *PipelineService) Report(ctx context.Context, row db.PipelineRun, id string, task db.AgentTaskQueue, attempt int, key string, report pipeline.Report) (pipeline.Run, error) {
	return s.Update(ctx, row, func(run *pipeline.Run, q *db.Queries) error {
		job := run.Job(id)
		if job == nil {
			return pipeline.Fail("job_not_found", "job not found")
		}
		a := job.Current()
		hash := pipeline.Fingerprint(report)
		if a == nil || a.Number != attempt || a.TaskID != util.UUIDToString(task.ID) || a.ExecutorID != util.UUIDToString(task.AgentID) || task.PipelineRunID != row.ID || task.PipelineJobID.String != id || int(task.PipelineAttempt.Int32) != attempt {
			return pipeline.Fail("report_forbidden", "report must belong to the current task and attempt")
		}
		if a.Report != nil {
			if a.ReportKey == key && a.ReportHash == hash {
				return nil
			}
			return pipeline.Fail("revision_conflict", "attempt result already reported")
		}
		if task.Status != "running" || (job.Status != "queued" && job.Status != "running") || pipeline.Terminal(run.Status) || run.Status == "cancelling" {
			return pipeline.Fail("revision_conflict", "attempt is no longer running")
		}
		if key == "" || len(key) > 200 {
			return pipeline.Fail("idempotency_key_required", "idempotency key required")
		}
		if report.Result != "succeeded" && report.Result != "failed" && report.Result != "blocked" {
			return pipeline.Fail("invalid_result", "result must be succeeded, failed or blocked")
		}
		if strings.TrimSpace(report.Text) == "" {
			return pipeline.Fail("report_required", "a nonempty report is required")
		}
		seen := map[string]bool{}
		for i := range report.Artifacts {
			artifact := &report.Artifacts[i]
			declared := false
			for _, p := range job.Node.Paths {
				if p == artifact.Path {
					declared = true
				}
			}
			if !declared || seen[artifact.Path] {
				return pipeline.Fail("invalid_artifact", "artifact paths must uniquely match declarations")
			}
			seen[artifact.Path] = true
			artifact.ID = fmt.Sprintf("%s/%s/%d/%s", run.ID, id, attempt, artifact.Path)
			artifact.JobID = id
			artifact.Attempt = attempt
			artifact.Status = "reported"
			artifact.Reason = "artifact_unavailable"
			sources := 0
			for _, ref := range []string{artifact.AttachmentID, artifact.Repo, artifact.DocumentID} {
				if ref != "" {
					sources++
				}
			}
			if sources > 1 {
				return pipeline.Fail("invalid_artifact", "choose one artifact source")
			}
			if artifact.DocumentID != "" {
				docID, e := util.ParseUUID(artifact.DocumentID)
				projectID, projectErr := util.ParseUUID(run.ProjectID)
				if e != nil || artifact.DocumentVersion < 1 {
					return pipeline.Fail("invalid_artifact", "document_id and a positive document_version are required")
				}
				if projectErr == nil {
					_, e = q.GetProjectDocumentRevision(ctx, db.GetProjectDocumentRevisionParams{DocumentID: docID, WorkspaceID: row.WorkspaceID, ProjectID: projectID, Version: artifact.DocumentVersion})
					if e == nil {
						artifact.Status, artifact.Reason = "accessible", ""
					}
				}
			}
			if artifact.Repo != "" && s.RepositoryFile != nil {
				ref := artifact.SHA
				if ref == "" {
					ref = artifact.Ref
				}
				sha, _, e := s.RepositoryFile(ctx, run.WorkspaceID, run.CreatorID, artifact.Repo, artifact.Path, ref)
				if e == nil {
					artifact.SHA = sha
					artifact.Status = "accessible"
					artifact.Reason = ""
				}
			}
			if artifact.AttachmentID != "" {
				attachmentID, e := util.ParseUUID(artifact.AttachmentID)
				if e != nil {
					return pipeline.Fail("invalid_artifact", "attachment_id must be a UUID")
				}
				attachment, e := q.GetAttachment(ctx, db.GetAttachmentParams{ID: attachmentID, WorkspaceID: row.WorkspaceID})
				if e == nil && attachment.IssueID == row.IssueID && attachment.TaskID == task.ID && attachment.UploaderType == "agent" && attachment.UploaderID == task.AgentID && s.ArtifactAvailable != nil && s.ArtifactAvailable(ctx, attachment) {
					artifact.Status = "accessible"
					artifact.Reason = ""
				}
			}
		}
		a.Report = &report
		a.ReportKey = key
		a.ReportHash = hash
		job.Revision++
		return nil
	})
}

func (s *PipelineService) RefreshArtifacts(ctx context.Context, q *db.Queries, run *pipeline.Run) {
	for i := range run.Jobs {
		for k := range run.Jobs[i].Attempts {
			a := &run.Jobs[i].Attempts[k]
			if a.Report == nil {
				continue
			}
			for n := range a.Report.Artifacts {
				artifact := &a.Report.Artifacts[n]
				if artifact.DocumentID != "" {
					docID, docErr := util.ParseUUID(artifact.DocumentID)
					projectID, projectErr := util.ParseUUID(run.ProjectID)
					artifact.Status, artifact.Reason = "missing", "artifact_unavailable"
					if docErr == nil && projectErr == nil {
						_, err := q.GetProjectDocumentRevision(ctx, db.GetProjectDocumentRevisionParams{DocumentID: docID, WorkspaceID: pipelineUUID(run.WorkspaceID), ProjectID: projectID, Version: artifact.DocumentVersion})
						if err == nil {
							artifact.Status, artifact.Reason = "accessible", ""
						}
					}
					continue
				}
				if artifact.AttachmentID == "" {
					if artifact.Repo != "" && artifact.SHA != "" && s.RepositoryFile != nil {
						sha, _, err := s.RepositoryFile(ctx, run.WorkspaceID, run.CreatorID, artifact.Repo, artifact.Path, artifact.SHA)
						if err != nil || sha != artifact.SHA {
							artifact.Status = "missing"
							artifact.Reason = "artifact_unavailable"
						} else {
							artifact.Status = "accessible"
							artifact.Reason = ""
						}
					}
					continue
				}
				attachment, err := q.GetAttachment(ctx, db.GetAttachmentParams{ID: pipelineUUID(artifact.AttachmentID), WorkspaceID: pipelineUUID(run.WorkspaceID)})
				if err != nil || util.UUIDToString(attachment.IssueID) != run.IssueID || util.UUIDToString(attachment.TaskID) != a.TaskID || s.ArtifactAvailable == nil || !s.ArtifactAvailable(ctx, attachment) {
					artifact.Status = "missing"
					artifact.Reason = "artifact_unavailable"
				} else {
					artifact.Status = "accessible"
					artifact.Reason = ""
				}
			}
		}
	}
}

func (s *PipelineService) HydrateUsage(ctx context.Context, run *pipeline.Run) error {
	for i := range run.Jobs {
		for k := range run.Jobs[i].Attempts {
			a := &run.Jobs[i].Attempts[k]
			rows, err := s.Queries.GetTaskUsage(ctx, pipelineUUID(a.TaskID))
			if err != nil {
				return err
			}
			a.Usage = []pipeline.Usage{}
			for _, u := range rows {
				var cost *int64
				if u.CostUsdTicks.Valid {
					value := u.CostUsdTicks.Int64
					cost = &value
				}
				a.Usage = append(a.Usage, pipeline.Usage{Provider: u.Provider, Model: u.Model, InputTokens: u.InputTokens, OutputTokens: u.OutputTokens, CacheReadTokens: u.CacheReadTokens, CacheWriteTokens: u.CacheWriteTokens, CostUSDTicks: cost})
			}
		}
	}
	return nil
}
