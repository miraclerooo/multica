package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const maxProjectDocumentContentBytes = 1 << 20

type ProjectDocumentMetadata struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	ProjectID   string `json:"project_id"`
	Title       string `json:"title"`
	IsPinned    bool   `json:"is_pinned"`
	Position    int32  `json:"position"`
	Revision    int64  `json:"revision"`
	CreatedBy   string `json:"created_by"`
	UpdatedBy   string `json:"updated_by"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

type ProjectDocumentResponse struct {
	ProjectDocumentMetadata
	Content string `json:"content"`
}

type ProjectDocumentSummary struct {
	ProjectDocumentMetadata
	Excerpt string `json:"excerpt"`
}

func projectDocumentToResponse(d db.ProjectDocument) ProjectDocumentResponse {
	return ProjectDocumentResponse{
		ProjectDocumentMetadata: ProjectDocumentMetadata{
			ID: uuidToString(d.ID), WorkspaceID: uuidToString(d.WorkspaceID), ProjectID: uuidToString(d.ProjectID),
			Title: d.Title, IsPinned: d.IsPinned, Position: d.Position, Revision: d.Revision,
			CreatedBy: uuidToString(d.CreatedBy), UpdatedBy: uuidToString(d.UpdatedBy),
			CreatedAt: timestampToString(d.CreatedAt), UpdatedAt: timestampToString(d.UpdatedAt),
		},
		Content: d.Content,
	}
}

type CreateProjectDocumentRequest struct {
	Title    string `json:"title"`
	Content  string `json:"content"`
	IsPinned bool   `json:"is_pinned"`
	Position int32  `json:"position"`
}

type UpdateProjectDocumentRequest struct {
	Revision int64   `json:"revision"`
	Title    *string `json:"title"`
	Content  *string `json:"content"`
	IsPinned *bool   `json:"is_pinned"`
	Position *int32  `json:"position"`
}

// Identity and parent IDs come exclusively from authentication and the route.
// Reject null and unknown fields so an unsupported context/sharing toggle cannot
// appear to have been saved. The transport bound allows JSON-escaped Markdown.
func decodeProjectDocumentBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 6*maxProjectDocumentContentBytes+4096))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "document request is too large")
		} else {
			writeError(w, http.StatusBadRequest, "invalid request body")
		}
		return false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil || fields == nil {
		writeError(w, http.StatusBadRequest, "request body must be a JSON object")
		return false
	}
	for _, value := range fields {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			writeError(w, http.StatusBadRequest, "document fields cannot be null")
			return false
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "invalid or unknown document field")
		return false
	}
	return true
}

func validateProjectDocumentFields(w http.ResponseWriter, title, content *string) bool {
	if title != nil {
		*title = strings.TrimSpace(*title)
		if *title == "" || utf8.RuneCountInString(*title) > 200 || strings.ContainsRune(*title, 0) {
			writeError(w, http.StatusBadRequest, "title must contain 1 to 200 characters without NUL")
			return false
		}
	}
	if content != nil && (len(*content) > maxProjectDocumentContentBytes || strings.ContainsRune(*content, 0)) {
		writeError(w, http.StatusBadRequest, "content must be at most 1048576 bytes without NUL")
		return false
	}
	return true
}

func (h *Handler) loadProjectForDocument(w http.ResponseWriter, r *http.Request, write bool) (db.Project, db.Member, bool) {
	if write && isMachineCredentialActor(r) {
		writeError(w, http.StatusForbidden, "this endpoint is only available to human actors")
		return db.Project{}, db.Member{}, false
	}
	member, ok := h.workspaceMember(w, r, h.resolveWorkspaceID(r))
	if !ok {
		return db.Project{}, db.Member{}, false
	}
	project, ok := h.loadProjectForResource(w, r, chi.URLParam(r, "id"))
	return project, member, ok
}

func (h *Handler) ListProjectDocuments(w http.ResponseWriter, r *http.Request) {
	project, _, ok := h.loadProjectForDocument(w, r, false)
	if !ok {
		return
	}
	limit, offset := int64(50), int64(0)
	for _, field := range []struct {
		name string
		dst  *int64
		min  int64
		max  int64
	}{{"limit", &limit, 1, 100}, {"offset", &offset, 0, 2147483647}} {
		if raw := r.URL.Query().Get(field.name); raw != "" {
			value, err := strconv.ParseInt(raw, 10, 32)
			if err != nil || value < field.min || value > field.max {
				writeError(w, http.StatusBadRequest, "invalid "+field.name)
				return
			}
			*field.dst = value
		}
	}
	rows, err := h.Queries.ListProjectDocuments(r.Context(), db.ListProjectDocumentsParams{
		WorkspaceID: project.WorkspaceID, ProjectID: project.ID, PageLimit: int32(limit), PageOffset: int32(offset),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list project documents")
		return
	}
	total, err := h.Queries.CountProjectDocuments(r.Context(), db.CountProjectDocumentsParams{
		WorkspaceID: project.WorkspaceID, ProjectID: project.ID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to count project documents")
		return
	}
	documents := make([]ProjectDocumentSummary, len(rows))
	for i, row := range rows {
		documents[i] = ProjectDocumentSummary{
			ProjectDocumentMetadata: ProjectDocumentMetadata{
				ID: uuidToString(row.ID), WorkspaceID: uuidToString(row.WorkspaceID), ProjectID: uuidToString(row.ProjectID),
				Title: row.Title, IsPinned: row.IsPinned, Position: row.Position, Revision: row.Revision,
				CreatedBy: uuidToString(row.CreatedBy), UpdatedBy: uuidToString(row.UpdatedBy),
				CreatedAt: timestampToString(row.CreatedAt), UpdatedAt: timestampToString(row.UpdatedAt),
			},
			Excerpt: row.Excerpt,
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"documents": documents, "total": total, "limit": limit, "offset": offset})
}

func (h *Handler) GetProjectDocument(w http.ResponseWriter, r *http.Request) {
	project, _, ok := h.loadProjectForDocument(w, r, false)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "docId"), "document id")
	if !ok {
		return
	}
	document, err := h.Queries.GetProjectDocument(r.Context(), db.GetProjectDocumentParams{
		ID: id, WorkspaceID: project.WorkspaceID, ProjectID: project.ID,
	})
	if err != nil {
		projectDocumentReadError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, projectDocumentToResponse(document))
}

func projectDocumentReadError(w http.ResponseWriter, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "document not found")
	} else {
		writeError(w, http.StatusInternalServerError, "failed to read project document")
	}
}

func (h *Handler) CreateProjectDocument(w http.ResponseWriter, r *http.Request) {
	project, member, ok := h.loadProjectForDocument(w, r, true)
	if !ok {
		return
	}
	var req CreateProjectDocumentRequest
	if !decodeProjectDocumentBody(w, r, &req) || !validateProjectDocumentFields(w, &req.Title, &req.Content) {
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to start transaction")
		return
	}
	defer tx.Rollback(r.Context())
	qtx := h.Queries.WithTx(tx)
	if _, err := qtx.LockWorkspaceForProjectDocumentCreate(r.Context(), project.WorkspaceID); err != nil {
		projectDocumentReadError(w, err)
		return
	}
	if _, err := qtx.LockProjectForDocumentCreate(r.Context(), db.LockProjectForDocumentCreateParams{
		ID: project.ID, WorkspaceID: project.WorkspaceID,
	}); err != nil {
		projectDocumentReadError(w, err)
		return
	}
	document, err := qtx.CreateProjectDocument(r.Context(), db.CreateProjectDocumentParams{
		WorkspaceID: project.WorkspaceID, ProjectID: project.ID, Title: req.Title, Content: req.Content,
		IsPinned: req.IsPinned, Position: req.Position, ActorID: member.UserID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create project document")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit project document")
		return
	}
	h.publishProjectDocument(protocol.EventProjectDocumentCreated, document, member)
	writeJSON(w, http.StatusCreated, projectDocumentToResponse(document))
}

func (h *Handler) UpdateProjectDocument(w http.ResponseWriter, r *http.Request) {
	project, member, ok := h.loadProjectForDocument(w, r, true)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "docId"), "document id")
	if !ok {
		return
	}
	var req UpdateProjectDocumentRequest
	if !decodeProjectDocumentBody(w, r, &req) || !validateProjectDocumentFields(w, req.Title, req.Content) {
		return
	}
	if req.Revision < 1 || (req.Title == nil && req.Content == nil && req.IsPinned == nil && req.Position == nil) {
		writeError(w, http.StatusBadRequest, "positive revision and at least one document field are required")
		return
	}
	params := db.UpdateProjectDocumentParams{
		ID: id, WorkspaceID: project.WorkspaceID, ProjectID: project.ID, Revision: req.Revision, ActorID: member.UserID,
	}
	if req.Title != nil {
		params.Title = pgtype.Text{String: *req.Title, Valid: true}
	}
	if req.Content != nil {
		params.Content = pgtype.Text{String: *req.Content, Valid: true}
	}
	if req.IsPinned != nil {
		params.IsPinned = pgtype.Bool{Bool: *req.IsPinned, Valid: true}
	}
	if req.Position != nil {
		params.Position = pgtype.Int4{Int32: *req.Position, Valid: true}
	}
	document, err := h.Queries.UpdateProjectDocument(r.Context(), params)
	if errors.Is(err, pgx.ErrNoRows) {
		h.projectDocumentConflict(w, r, project, id)
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update project document")
		return
	}
	h.publishProjectDocument(protocol.EventProjectDocumentUpdated, document, member)
	writeJSON(w, http.StatusOK, projectDocumentToResponse(document))
}

func (h *Handler) projectDocumentConflict(w http.ResponseWriter, r *http.Request, project db.Project, id pgtype.UUID) {
	document, err := h.Queries.GetProjectDocument(r.Context(), db.GetProjectDocumentParams{
		ID: id, WorkspaceID: project.WorkspaceID, ProjectID: project.ID,
	})
	if err != nil {
		projectDocumentReadError(w, err)
		return
	}
	writeJSON(w, http.StatusConflict, map[string]any{
		"error": "document changed; reload before saving or deleting", "code": "project_document_conflict",
		"current_revision": document.Revision,
	})
}

func canDeleteProjectDocument(project db.Project, document db.ProjectDocument, member db.Member) bool {
	return roleAllowed(member.Role, "owner", "admin") || document.CreatedBy == member.UserID ||
		(project.LeadType.Valid && project.LeadType.String == "member" && project.LeadID == member.UserID)
}

func (h *Handler) DeleteProjectDocument(w http.ResponseWriter, r *http.Request) {
	project, member, ok := h.loadProjectForDocument(w, r, true)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "docId"), "document id")
	if !ok {
		return
	}
	revision, err := strconv.ParseInt(r.URL.Query().Get("revision"), 10, 64)
	if err != nil || revision < 1 {
		writeError(w, http.StatusBadRequest, "positive revision query parameter is required")
		return
	}
	document, err := h.Queries.GetProjectDocument(r.Context(), db.GetProjectDocumentParams{
		ID: id, WorkspaceID: project.WorkspaceID, ProjectID: project.ID,
	})
	if err != nil {
		projectDocumentReadError(w, err)
		return
	}
	if !canDeleteProjectDocument(project, document, member) {
		writeError(w, http.StatusForbidden, "only the document creator, project lead, or workspace admin can delete this document")
		return
	}
	deleted, err := h.Queries.DeleteProjectDocument(r.Context(), db.DeleteProjectDocumentParams{
		ID: id, WorkspaceID: project.WorkspaceID, ProjectID: project.ID, Revision: revision,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		h.projectDocumentConflict(w, r, project, id)
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete project document")
		return
	}
	h.publishProjectDocument(protocol.EventProjectDocumentDeleted, deleted, member)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) publishProjectDocument(event string, document db.ProjectDocument, member db.Member) {
	// Invalidation-only events avoid sending document bodies to idle clients.
	h.publish(event, uuidToString(document.WorkspaceID), "member", uuidToString(member.UserID), map[string]any{
		"project_id": uuidToString(document.ProjectID), "document_id": uuidToString(document.ID), "revision": document.Revision,
	})
}
