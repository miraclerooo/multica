package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type DocumentIssueGroup struct {
	IssueID    *string                   `json:"issue_id"`
	Identifier string                    `json:"identifier"`
	Title      string                    `json:"title"`
	Count      int                       `json:"count"`
	Documents  []ProjectDocumentResponse `json:"documents"`
}

type DocumentReference struct {
	DocumentID      string                 `json:"document_id"`
	IssueID         string                 `json:"issue_id"`
	DocumentVersion int32                  `json:"document_version"`
	Sources         []DocumentSourceRecord `json:"sources"`
}

type DocumentSourceRecord struct {
	SourceKey       string                 `json:"source_key"`
	DocumentVersion int32                  `json:"document_version"`
	Source          DocumentSourceResponse `json:"source"`
}

func (h *Handler) ListIssueDocuments(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.documentIssue(w, r)
	if !ok {
		return
	}
	h.listDocuments(w, r, issue.WorkspaceID, issue.ProjectID, uuidToString(issue.ID), true)
}

func (h *Handler) ListDocumentSources(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireWorkspaceMember(w, r, h.resolveWorkspaceID(r), "workspace not found"); !ok {
		return
	}
	d, ok := h.loadProjectDocument(w, r)
	if !ok {
		return
	}
	sources, err := h.documentSources(r, d)
	if err != nil {
		writeError(w, 500, "failed to read document sources")
		return
	}
	writeJSON(w, 200, map[string]any{"sources": sources, "total": len(sources)})
}

func (h *Handler) documentSources(r *http.Request, d db.ProjectDocument) ([]DocumentSourceRecord, error) {
	rows, err := h.Queries.ListProjectDocumentSources(r.Context(), db.ListProjectDocumentSourcesParams{WorkspaceID: d.WorkspaceID, ProjectID: d.ProjectID, DocumentID: d.ID})
	if err != nil {
		return nil, err
	}
	out := make([]DocumentSourceRecord, 0, len(rows))
	for _, row := range rows {
		var source DocumentSourceResponse
		if err = json.Unmarshal(row.Source, &source); err != nil {
			return nil, err
		}
		out = append(out, DocumentSourceRecord{SourceKey: row.SourceKey, DocumentVersion: row.DocumentVersion, Source: source})
	}
	return out, nil
}

func (h *Handler) listDocuments(w http.ResponseWriter, r *http.Request, ws, project pgtype.UUID, issueFilter string, withSources bool) {
	rows, err := h.Queries.ListProjectDocuments(r.Context(), db.ListProjectDocumentsParams{WorkspaceID: ws, ProjectID: project})
	if err != nil {
		writeError(w, 500, "failed to list documents")
		return
	}
	relations, err := h.Queries.ListProjectDocumentIssues(r.Context(), db.ListProjectDocumentIssuesParams{WorkspaceID: ws, ProjectID: project})
	if err != nil {
		writeError(w, 500, "failed to list document relationships")
		return
	}
	byID := map[string]db.ProjectDocument{}
	for _, d := range rows {
		byID[uuidToString(d.ID)] = d
	}
	groups := []DocumentIssueGroup{}
	groupIndex := map[string]int{}
	linked := map[string]bool{}
	selected := map[string]bool{}
	references := []DocumentReference{}
	query := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	match := func(d db.ProjectDocument, issueText string) bool {
		return query == "" || strings.Contains(strings.ToLower(d.Title+"\n"+d.Body+"\n"+issueText), query)
	}
	for _, rel := range relations {
		id, issueID := uuidToString(rel.DocumentID), uuidToString(rel.IssueID)
		linked[id] = true
		if issueFilter != "" && issueFilter != issueID {
			continue
		}
		d, ok := byID[id]
		if !ok {
			continue
		}
		identifier := fmt.Sprintf("%s-%d", rel.IssuePrefix, rel.IssueNumber)
		if !match(d, identifier+"\n"+rel.IssueTitle) {
			continue
		}
		idx, ok := groupIndex[issueID]
		if !ok {
			idx = len(groups)
			groupIndex[issueID] = idx
			issueCopy := issueID
			groups = append(groups, DocumentIssueGroup{IssueID: &issueCopy, Identifier: identifier, Title: rel.IssueTitle, Documents: []ProjectDocumentResponse{}})
		}
		groups[idx].Documents = append(groups[idx].Documents, projectDocumentToResponse(d))
		groups[idx].Count++
		selected[id] = true
		if withSources {
			sources, e := h.documentSources(r, d)
			if e != nil {
				writeError(w, 500, "failed to read document sources")
				return
			}
			references = append(references, DocumentReference{DocumentID: id, IssueID: issueID, DocumentVersion: rel.DocumentVersion, Sources: sources})
		}
	}
	unassociated := DocumentIssueGroup{Title: "Project materials", Documents: []ProjectDocumentResponse{}}
	if issueFilter == "" {
		for _, d := range rows {
			id := uuidToString(d.ID)
			if !linked[id] && match(d, "") {
				unassociated.Documents = append(unassociated.Documents, projectDocumentToResponse(d))
				unassociated.Count++
				selected[id] = true
			}
		}
		if unassociated.Count > 0 {
			groups = append(groups, unassociated)
		}
	}
	documents := make([]ProjectDocumentResponse, 0, len(selected))
	for _, d := range rows {
		if selected[uuidToString(d.ID)] {
			documents = append(documents, projectDocumentToResponse(d))
		}
	}
	writeJSON(w, 200, map[string]any{"documents": documents, "total": len(documents), "groups": groups, "references": references})
}

func (h *Handler) listProjectDocumentsGrouped(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireWorkspaceMember(w, r, h.resolveWorkspaceID(r), "workspace not found"); !ok {
		return
	}
	p, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	issueFilter := ""
	if id := r.URL.Query().Get("issue_id"); id != "" {
		issue, ok := h.loadIssueForUser(w, r, id)
		if !ok {
			return
		}
		if issue.ProjectID != p.ID {
			writeError(w, 404, "issue not in project")
			return
		}
		issueFilter = uuidToString(issue.ID)
	}
	h.listDocuments(w, r, p.WorkspaceID, p.ID, issueFilter, false)
}
