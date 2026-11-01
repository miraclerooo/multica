package handler

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"unicode"

	"github.com/multica-ai/multica/server/internal/pipeline"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// DocumentSource contains a pinned source reference, never copied artifact data.
type DocumentSource struct {
	Kind            string `json:"kind"`
	AttachmentID    string `json:"attachment_id,omitempty"`
	DocumentID      string `json:"document_id,omitempty"`
	DocumentVersion int32  `json:"document_version,omitempty"`
	RunID           string `json:"run_id,omitempty"`
	JobID           string `json:"job_id,omitempty"`
	Attempt         int    `json:"attempt,omitempty"`
	Path            string `json:"path,omitempty"`
	Repo            string `json:"repo,omitempty"`
	SHA             string `json:"sha,omitempty"`
	URL             string `json:"url,omitempty"`
}

type DocumentSourceResponse struct {
	DocumentSource
	IssueID     string             `json:"issue_id"`
	TaskID      string             `json:"task_id,omitempty"`
	Artifact    *pipeline.Artifact `json:"artifact,omitempty"`
	Label       string             `json:"label"`
	Description string             `json:"description,omitempty"`
	Href        string             `json:"href"`
	Verified    bool               `json:"verified"`
	Mutable     bool               `json:"mutable"`
	Markdown    string             `json:"markdown"`
}

func (h *Handler) documentContentURL(path string, wsID string, query url.Values) string {
	if query == nil {
		query = url.Values{}
	}
	query.Set("workspace_id", wsID)
	return strings.TrimRight(h.cfg.PublicURL, "/") + path + "?" + query.Encode()
}

func markdownLinkText(s string) string {
	return strings.NewReplacer("\\", "\\\\", "[", "\\[", "]", "\\]", "<", "\\<", ">", "\\>", "*", "\\*", "_", "\\_", "`", "\\`", "\r", " ", "\n", " ").Replace(s)
}

func hasDocumentSourceLink(body, href string) bool {
	data := []byte(body)
	document := goldmark.DefaultParser().Parse(text.NewReader(data))
	found := false
	_ = ast.Walk(document, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch link := n.(type) {
		case *ast.Link:
			found = string(link.Destination) == href
		case *ast.AutoLink:
			found = string(link.URL(data)) == href
		}
		if found {
			return ast.WalkStop, nil
		}
		return ast.WalkContinue, nil
	})
	return found
}

func (h *Handler) resolveDocumentSource(ctx context.Context, q *db.Queries, issue db.Issue, userID string, source DocumentSource, label, description string) (DocumentSourceResponse, string, error) {
	out := DocumentSourceResponse{DocumentSource: source, IssueID: uuidToString(issue.ID), Label: label, Description: description, Verified: true}
	ws, project := uuidToString(issue.WorkspaceID), uuidToString(issue.ProjectID)
	bad := func() (DocumentSourceResponse, string, error) {
		return out, "", pipeline.Fail("invalid_document_source", "source is unavailable or outside this issue's project")
	}
	// Reject mixed sources instead of silently accepting misleading provenance.
	switch source.Kind {
	case "attachment":
		if source.DocumentID != "" || source.RunID != "" || source.Repo != "" || source.URL != "" {
			return bad()
		}
		id, err := util.ParseUUID(source.AttachmentID)
		if err != nil {
			return bad()
		}
		a, err := q.GetAttachment(ctx, db.GetAttachmentParams{ID: id, WorkspaceID: issue.WorkspaceID})
		if err != nil || a.IssueID != issue.ID || h.Pipelines.ArtifactAvailable == nil || !h.Pipelines.ArtifactAvailable(ctx, a) {
			return bad()
		}
		out.DocumentSource = DocumentSource{Kind: source.Kind, AttachmentID: util.UUIDToString(id)}
		if a.TaskID.Valid {
			out.TaskID = uuidToString(a.TaskID)
		}
		out.Href = h.documentContentURL("/api/attachments/"+source.AttachmentID+"/download", ws, nil)
		if out.Label == "" {
			out.Label = a.Filename
		}
	case "document":
		if source.AttachmentID != "" || source.RunID != "" || source.Repo != "" || source.URL != "" || source.DocumentVersion < 1 {
			return bad()
		}
		id, err := util.ParseUUID(source.DocumentID)
		if err != nil {
			return bad()
		}
		rev, err := q.GetProjectDocumentRevision(ctx, db.GetProjectDocumentRevisionParams{DocumentID: id, WorkspaceID: issue.WorkspaceID, ProjectID: issue.ProjectID, Version: source.DocumentVersion})
		if err != nil {
			return bad()
		}
		out.DocumentSource = DocumentSource{Kind: source.Kind, DocumentID: util.UUIDToString(id), DocumentVersion: source.DocumentVersion}
		out.Href = h.documentContentURL(fmt.Sprintf("/api/projects/%s/documents/%s/revisions/%d/content", project, source.DocumentID, source.DocumentVersion), ws, nil)
		if out.Label == "" {
			out.Label = rev.Title
		}
	case "pipeline_artifact":
		if source.AttachmentID != "" || source.DocumentID != "" || source.Repo != "" || source.URL != "" {
			return bad()
		}
		id, err := util.ParseUUID(source.RunID)
		if err != nil {
			return bad()
		}
		row, err := q.GetPipelineRun(ctx, db.GetPipelineRunParams{ID: id, WorkspaceID: issue.WorkspaceID})
		if err != nil || row.IssueID != issue.ID {
			return bad()
		}
		run, err := service.DecodePipelineRun(row)
		if err != nil || run.ProjectID != project {
			return bad()
		}
		h.Pipelines.RefreshArtifacts(ctx, q, &run)
		job := run.Job(source.JobID)
		if job == nil {
			return bad()
		}
		found := false
		for _, attempt := range job.Attempts {
			if attempt.Number != source.Attempt || attempt.Report == nil {
				continue
			}
			for _, artifact := range attempt.Report.Artifacts {
				if artifact.Path == source.Path && artifact.Status == "accessible" {
					pinned := artifact
					out.Artifact, out.TaskID = &pinned, attempt.TaskID
					out.Href = h.documentContentURL("/api/pipeline-runs/"+source.RunID+"/artifact-content", ws, url.Values{"artifact_id": {artifact.ID}})
					found = true
				}
			}
		}
		if !found {
			return bad()
		}
		out.DocumentSource = DocumentSource{Kind: source.Kind, RunID: util.UUIDToString(id), JobID: source.JobID, Attempt: source.Attempt, Path: source.Path}
		if out.Label == "" {
			out.Label = source.Path
		}
	case "repository":
		if source.AttachmentID != "" || source.DocumentID != "" || source.RunID != "" || source.URL != "" || source.Repo == "" || source.SHA == "" || source.Path == "" || h.Pipelines.RepositoryFile == nil {
			return bad()
		}
		sha, _, err := h.Pipelines.RepositoryFile(ctx, ws, userID, source.Repo, source.Path, source.SHA)
		if err != nil || sha != source.SHA {
			return bad()
		}
		// RepositoryFile validates GitHub repository identity, exact path and SHA.
		out.DocumentSource = DocumentSource{Kind: source.Kind, Repo: source.Repo, SHA: source.SHA, Path: source.Path}
		out.Href = (&url.URL{Scheme: "https", Host: "github.com", Path: "/" + source.Repo + "/blob/" + source.SHA + "/" + source.Path}).String()
		if out.Label == "" {
			out.Label = source.Path
		}
	case "url":
		if source.AttachmentID != "" || source.DocumentID != "" || source.RunID != "" || source.Repo != "" {
			return bad()
		}
		u, err := url.Parse(source.URL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil || strings.ContainsAny(source.URL, "<>\\") || strings.IndexFunc(source.URL, func(c rune) bool { return unicode.IsControl(c) || unicode.IsSpace(c) }) >= 0 {
			return bad()
		}
		out.DocumentSource = DocumentSource{Kind: source.Kind, URL: u.String()}
		out.Href, out.Verified, out.Mutable = u.String(), false, true
		if out.Label == "" {
			out.Label = source.URL
		}
	default:
		return bad()
	}
	out.Markdown = "[" + markdownLinkText(out.Label) + "](<" + out.Href + ">)"
	if out.Description != "" {
		out.Markdown += " — " + markdownLinkText(out.Description)
	}
	if !out.Verified {
		out.Markdown += " (external URL; content unverified)"
	}
	keySource := out.DocumentSource
	// Labels and descriptions do not change the identity of the referenced source.
	key := pipeline.Fingerprint(keySource)
	return out, key, nil
}
