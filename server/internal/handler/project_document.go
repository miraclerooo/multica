package handler

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const projectSpecTemplate = `## 1. Context & Goals

Describe the background, goals and scope.

## 2. Requirements

### REQ-01: First requirement

Describe the expected behavior.

## 3. Scenarios — WHEN / THEN

### Scenario: Happy path

**WHEN** the user performs an action

**THEN** the expected result is observable.

## 4. Acceptance Criteria

- [ ] REQ-01 is implemented and verified
`

type ProjectDocumentResponse struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	ProjectID   string `json:"project_id"`
	Kind        string `json:"kind"`
	Title       string `json:"title"`
	Body        string `json:"body"`
	Version     int32  `json:"version"`
	BaseVersion int32  `json:"base_version"`
	AuthorType  string `json:"author_type"`
	AuthorID    string `json:"author_id"`
	AuthorName  string `json:"author_name"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
	ResourceURI string `json:"resource_uri"`
}

func projectDocumentToResponse(d db.ProjectDocument) ProjectDocumentResponse {
	id, projectID := uuidToString(d.ID), uuidToString(d.ProjectID)
	return ProjectDocumentResponse{
		ID: id, WorkspaceID: uuidToString(d.WorkspaceID), ProjectID: projectID,
		Kind: d.Kind, Title: d.Title, Body: d.Body, Version: d.Version, BaseVersion: d.Version - 1,
		AuthorType: d.AuthorType, AuthorID: uuidToString(d.AuthorID), AuthorName: d.AuthorName,
		CreatedAt: timestampToString(d.CreatedAt), UpdatedAt: timestampToString(d.UpdatedAt),
		ResourceURI: fmt.Sprintf("multica://project/%s/documents/%s", projectID, id),
	}
}

func (h *Handler) ListProjectDocuments(w http.ResponseWriter, r *http.Request) {
	p, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	rows, err := h.Queries.ListProjectDocuments(r.Context(), db.ListProjectDocumentsParams{WorkspaceID: p.WorkspaceID, ProjectID: p.ID})
	if err != nil {
		writeError(w, 500, "failed to list documents")
		return
	}
	documents := make([]ProjectDocumentResponse, 0, len(rows))
	for _, d := range rows {
		documents = append(documents, projectDocumentToResponse(d))
	}
	writeJSON(w, 200, map[string]any{"documents": documents, "total": len(documents)})
}

func (h *Handler) loadProjectDocument(w http.ResponseWriter, r *http.Request) (db.ProjectDocument, bool) {
	p, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return db.ProjectDocument{}, false
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "documentId"), "document id")
	if !ok {
		return db.ProjectDocument{}, false
	}
	d, err := h.Queries.GetProjectDocument(r.Context(), db.GetProjectDocumentParams{ID: id, WorkspaceID: p.WorkspaceID, ProjectID: p.ID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, 404, "document not found")
		} else {
			writeError(w, 500, "failed to read document")
		}
		return db.ProjectDocument{}, false
	}
	return d, true
}

func (h *Handler) GetProjectDocument(w http.ResponseWriter, r *http.Request) {
	d, ok := h.loadProjectDocument(w, r)
	if !ok {
		return
	}
	writeJSON(w, 200, projectDocumentToResponse(d))
}

func (h *Handler) projectDocumentAuthor(w http.ResponseWriter, r *http.Request, wsID pgtype.UUID) (string, pgtype.UUID, string, bool) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return "", pgtype.UUID{}, "", false
	}
	kind, id := h.resolveActor(r, userID, uuidToString(wsID))
	actorID, ok := parseUUIDOrBadRequest(w, id, "author id")
	if !ok {
		return "", pgtype.UUID{}, "", false
	}
	if kind == "agent" {
		a, err := h.Queries.GetAgentInWorkspace(r.Context(), db.GetAgentInWorkspaceParams{ID: actorID, WorkspaceID: wsID})
		if err != nil {
			writeError(w, 403, "author not available in workspace")
			return "", pgtype.UUID{}, "", false
		}
		return kind, actorID, a.Name, true
	}
	u, err := h.Queries.GetUser(r.Context(), actorID)
	if err != nil {
		writeError(w, 403, "author not available")
		return "", pgtype.UUID{}, "", false
	}
	return kind, actorID, u.Name, true
}

func validProjectDocumentContent(w http.ResponseWriter, title, body string) bool {
	if strings.TrimSpace(title) == "" || utf8.RuneCountInString(title) > 300 {
		writeError(w, 400, "title must contain between 1 and 300 characters")
		return false
	}
	if len(body) > 1024*1024 {
		writeError(w, 400, "document body must be at most 1 MiB")
		return false
	}
	return true
}

func (h *Handler) CreateProjectDocument(w http.ResponseWriter, r *http.Request) {
	p, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	var input struct {
		Title string  `json:"title"`
		Body  *string `json:"body"`
		Kind  string  `json:"kind"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*1024*1024)).Decode(&input); err != nil {
		writeError(w, 400, "invalid request body")
		return
	}
	if input.Kind == "" {
		input.Kind = "document"
	}
	if input.Kind != "spec" && input.Kind != "document" {
		writeError(w, 400, "kind must be spec or document")
		return
	}
	body := ""
	if input.Body != nil {
		body = *input.Body
	} else if input.Kind == "spec" {
		body = projectSpecTemplate
	}
	title := strings.TrimSpace(input.Title)
	if !validProjectDocumentContent(w, title, body) {
		return
	}
	authorType, authorID, authorName, ok := h.projectDocumentAuthor(w, r, p.WorkspaceID)
	if !ok {
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, 500, "failed to start document creation")
		return
	}
	defer tx.Rollback(r.Context())
	q := h.Queries.WithTx(tx)
	if _, err := q.LockWorkspaceForChatSessionCreate(r.Context(), p.WorkspaceID); err != nil {
		writeError(w, 404, "workspace not found")
		return
	}
	if _, err := q.LockProjectForChatSessionCreate(r.Context(), db.LockProjectForChatSessionCreateParams{ID: p.ID, WorkspaceID: p.WorkspaceID}); err != nil {
		writeError(w, 404, "project not found")
		return
	}
	d, err := q.CreateProjectDocument(r.Context(), db.CreateProjectDocumentParams{WorkspaceID: p.WorkspaceID, ProjectID: p.ID, Kind: input.Kind, Title: title, Body: body, AuthorType: authorType, AuthorID: authorID, AuthorName: authorName})
	if err != nil {
		writeError(w, 500, "failed to create document")
		return
	}
	if err := q.CreateProjectDocumentRevision(r.Context(), db.CreateProjectDocumentRevisionParams{ID: d.ID, WorkspaceID: d.WorkspaceID, ProjectID: d.ProjectID}); err != nil {
		writeError(w, 500, "failed to create revision")
		return
	}
	ref, _ := json.Marshal(map[string]string{"document_id": uuidToString(d.ID)})
	userID, _ := h.parseUserUUIDOrZero(requestUserID(r))
	resource, err := q.CreateProjectResource(r.Context(), db.CreateProjectResourceParams{ProjectID: p.ID, WorkspaceID: p.WorkspaceID, ResourceType: "project_document", ResourceRef: ref, Label: pgtype.Text{String: title, Valid: true}, CreatedBy: userID})
	if err != nil {
		writeError(w, 500, "failed to attach document resource")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, 500, "failed to commit document")
		return
	}
	h.publish(protocol.EventProjectResourceCreated, uuidToString(p.WorkspaceID), authorType, uuidToString(authorID), map[string]any{"resource": projectResourceToResponse(resource), "project_id": uuidToString(p.ID)})
	h.publishDocumentChange(d)
	writeJSON(w, 201, projectDocumentToResponse(d))
}

func (h *Handler) SaveProjectDocument(w http.ResponseWriter, r *http.Request) {
	d, ok := h.loadProjectDocument(w, r)
	if !ok {
		return
	}
	var input struct {
		Title       *string `json:"title"`
		Body        *string `json:"body"`
		BaseVersion *int32  `json:"base_version"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*1024*1024)).Decode(&input); err != nil {
		writeError(w, 400, "invalid request body")
		return
	}
	if input.Title == nil || input.Body == nil || input.BaseVersion == nil || *input.BaseVersion < 1 {
		writeError(w, 400, "title, body and positive base_version are required")
		return
	}
	title := strings.TrimSpace(*input.Title)
	if !validProjectDocumentContent(w, title, *input.Body) {
		return
	}
	authorType, authorID, authorName, ok := h.projectDocumentAuthor(w, r, d.WorkspaceID)
	if !ok {
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, 500, "failed to start save")
		return
	}
	defer tx.Rollback(r.Context())
	q := h.Queries.WithTx(tx)
	if _, err := q.LockWorkspaceForChatSessionCreate(r.Context(), d.WorkspaceID); err != nil {
		writeError(w, 404, "workspace not found")
		return
	}
	if _, err := q.LockProjectForChatSessionCreate(r.Context(), db.LockProjectForChatSessionCreateParams{ID: d.ProjectID, WorkspaceID: d.WorkspaceID}); err != nil {
		writeError(w, 404, "project not found")
		return
	}
	saved, err := q.SaveProjectDocument(r.Context(), db.SaveProjectDocumentParams{ID: d.ID, WorkspaceID: d.WorkspaceID, ProjectID: d.ProjectID, Title: title, Body: *input.Body, AuthorType: authorType, AuthorID: authorID, AuthorName: authorName, BaseVersion: *input.BaseVersion})
	if errors.Is(err, pgx.ErrNoRows) {
		latest, readErr := q.GetProjectDocument(r.Context(), db.GetProjectDocumentParams{ID: d.ID, WorkspaceID: d.WorkspaceID, ProjectID: d.ProjectID})
		if readErr != nil {
			writeError(w, 404, "document not found")
			return
		}
		writeJSON(w, http.StatusConflict, map[string]any{"error": "document has a newer revision", "code": "document_version_conflict", "latest": projectDocumentToResponse(latest)})
		return
	}
	if err != nil {
		writeError(w, 500, "failed to save document")
		return
	}
	if err := q.CreateProjectDocumentRevision(r.Context(), db.CreateProjectDocumentRevisionParams{ID: d.ID, WorkspaceID: d.WorkspaceID, ProjectID: d.ProjectID}); err != nil {
		writeError(w, 500, "failed to save revision")
		return
	}
	if err := q.RenameProjectDocumentResource(r.Context(), db.RenameProjectDocumentResourceParams{WorkspaceID: d.WorkspaceID, ProjectID: d.ProjectID, DocumentID: uuidToString(d.ID), Label: pgtype.Text{String: title, Valid: true}}); err != nil {
		writeError(w, 500, "failed to update document resource")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, 500, "failed to commit revision")
		return
	}
	h.publishDocumentChange(saved)
	writeJSON(w, 200, projectDocumentToResponse(saved))
}

func (h *Handler) publishDocumentChange(d db.ProjectDocument) {
	h.publish(protocol.EventProjectDocumentUpdated, uuidToString(d.WorkspaceID), d.AuthorType, uuidToString(d.AuthorID), map[string]any{"project_id": uuidToString(d.ProjectID), "document_id": uuidToString(d.ID), "version": d.Version})
}

func (h *Handler) ListProjectDocumentRevisions(w http.ResponseWriter, r *http.Request) {
	d, ok := h.loadProjectDocument(w, r)
	if !ok {
		return
	}
	rows, err := h.Queries.ListProjectDocumentRevisions(r.Context(), db.ListProjectDocumentRevisionsParams{DocumentID: d.ID, WorkspaceID: d.WorkspaceID, ProjectID: d.ProjectID})
	if err != nil {
		writeError(w, 500, "failed to list revisions")
		return
	}
	revisions := make([]ProjectDocumentResponse, 0, len(rows))
	for _, rev := range rows {
		snapshot := projectDocumentToResponse(d)
		snapshot.Title, snapshot.Body, snapshot.Version, snapshot.BaseVersion = rev.Title, rev.Body, rev.Version, rev.BaseVersion
		snapshot.AuthorType, snapshot.AuthorID, snapshot.AuthorName = rev.AuthorType, uuidToString(rev.AuthorID), rev.AuthorName
		snapshot.UpdatedAt = timestampToString(rev.CreatedAt)
		revisions = append(revisions, snapshot)
	}
	writeJSON(w, 200, map[string]any{"revisions": revisions, "total": len(revisions)})
}

func (h *Handler) GetProjectResourceContent(w http.ResponseWriter, r *http.Request) {
	p, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "resourceId"), "resource id")
	if !ok {
		return
	}
	resource, err := h.Queries.GetProjectResourceInWorkspace(r.Context(), db.GetProjectResourceInWorkspaceParams{ID: id, WorkspaceID: p.WorkspaceID})
	if err != nil || resource.ProjectID != p.ID {
		writeError(w, 404, "resource not found")
		return
	}
	if resource.ResourceType != "project_document" {
		writeError(w, 400, "resource does not contain a project document")
		return
	}
	var ref struct {
		DocumentID string `json:"document_id"`
	}
	if err := json.Unmarshal(resource.ResourceRef, &ref); err != nil {
		writeError(w, 404, "document reference is invalid")
		return
	}
	documentID, ok := parseUUIDOrBadRequest(w, ref.DocumentID, "document id")
	if !ok {
		return
	}
	d, err := h.Queries.GetProjectDocument(r.Context(), db.GetProjectDocumentParams{ID: documentID, WorkspaceID: p.WorkspaceID, ProjectID: p.ID})
	if err != nil {
		writeError(w, 404, "document not found")
		return
	}
	writeJSON(w, 200, projectDocumentToResponse(d))
}
