package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/pipeline"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type AssociateDocumentInput struct {
	DocumentID     string `json:"document_id"`
	CreateDocument *struct {
		Title string  `json:"title"`
		Body  *string `json:"body,omitempty"`
		Kind  string  `json:"kind,omitempty"`
	} `json:"create_document,omitempty"`
	BaseVersion    int32           `json:"base_version"`
	IdempotencyKey string          `json:"idempotency_key"`
	Source         *DocumentSource `json:"source,omitempty"`
	Label          string          `json:"label,omitempty"`
	Description    string          `json:"description,omitempty"`
}

type AssociateDocumentResponse struct {
	Document ProjectDocumentResponse `json:"document"`
	Inserted bool                    `json:"inserted"`
	Replayed bool                    `json:"replayed"`
	Linked   bool                    `json:"linked"`
}

func (h *Handler) documentIssue(w http.ResponseWriter, r *http.Request) (db.Issue, bool) {
	if _, ok := h.requireWorkspaceMember(w, r, h.resolveWorkspaceID(r), "workspace not found"); !ok {
		return db.Issue{}, false
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return issue, false
	}
	if !issue.ProjectID.Valid {
		writeJSON(w, 409, map[string]string{"code": "issue_project_required", "error": "assign the issue to a project before associating documents"})
		return issue, false
	}
	return issue, true
}

func documentRevisionResponse(d db.ProjectDocument, rev db.ProjectDocumentRevision) ProjectDocumentResponse {
	out := projectDocumentToResponse(d)
	out.Title, out.Body, out.Version, out.BaseVersion = rev.Title, rev.Body, rev.Version, rev.BaseVersion
	out.AuthorType, out.AuthorID, out.AuthorName = rev.AuthorType, uuidToString(rev.AuthorID), rev.AuthorName
	out.UpdatedAt = timestampToString(rev.CreatedAt)
	return out
}

func (h *Handler) GetProjectDocumentRevision(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireWorkspaceMember(w, r, h.resolveWorkspaceID(r), "workspace not found"); !ok {
		return
	}
	d, ok := h.loadProjectDocument(w, r)
	if !ok {
		return
	}
	version, err := strconv.ParseInt(chi.URLParam(r, "version"), 10, 32)
	if err != nil || version < 1 {
		writeError(w, 400, "version must be positive")
		return
	}
	rev, err := h.Queries.GetProjectDocumentRevision(r.Context(), db.GetProjectDocumentRevisionParams{DocumentID: d.ID, WorkspaceID: d.WorkspaceID, ProjectID: d.ProjectID, Version: int32(version)})
	if err != nil {
		writeError(w, 404, "document revision not found")
		return
	}
	if strings.HasSuffix(r.URL.Path, "/content") {
		w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(rev.Body))
		return
	}
	writeJSON(w, 200, documentRevisionResponse(d, rev))
}

func (h *Handler) AssociateIssueDocument(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.documentIssue(w, r)
	if !ok {
		return
	}
	var in AssociateDocumentInput
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*1024*1024))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		writeError(w, 400, "invalid request body")
		return
	}
	if in.IdempotencyKey == "" || len(in.IdempotencyKey) > 200 || (in.DocumentID == "") == (in.CreateDocument == nil) || utf8.RuneCountInString(in.Label) > 300 || len(in.Description) > 2000 {
		writeError(w, 400, "choose document_id or create_document and provide an idempotency_key; label must be at most 300 characters and description at most 2000 bytes")
		return
	}
	var docID pgtype.UUID
	if in.DocumentID != "" {
		docID, ok = parseUUIDOrBadRequest(w, in.DocumentID, "document_id")
		if !ok {
			return
		}
	}
	if (in.CreateDocument == nil && in.BaseVersion < 1) || (in.CreateDocument != nil && in.BaseVersion != 0) {
		writeError(w, 400, "base_version must be positive for an existing document, or zero for creation")
		return
	}
	authorType, authorID, authorName, ok := h.projectDocumentAuthor(w, r, issue.WorkspaceID)
	if !ok {
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, 500, "failed to start association")
		return
	}
	defer tx.Rollback(r.Context())
	q := h.Queries.WithTx(tx)
	if _, err = q.LockWorkspaceForChatSessionCreate(r.Context(), issue.WorkspaceID); err != nil {
		writeError(w, 404, "workspace not found")
		return
	}
	if _, err = q.LockProjectForChatSessionCreate(r.Context(), db.LockProjectForChatSessionCreateParams{ID: issue.ProjectID, WorkspaceID: issue.WorkspaceID}); err != nil {
		writeError(w, 404, "project not found")
		return
	}
	current, err := q.LockPipelineIssue(r.Context(), db.LockPipelineIssueParams{ID: issue.ID, WorkspaceID: issue.WorkspaceID})
	if err != nil || current.ProjectID != issue.ProjectID {
		writeError(w, 409, "issue project changed; reload before retrying")
		return
	}
	hash := pipeline.Fingerprint(in)
	receipt, err := q.GetProjectDocumentOperation(r.Context(), db.GetProjectDocumentOperationParams{WorkspaceID: issue.WorkspaceID, IssueID: issue.ID, IdempotencyKey: in.IdempotencyKey})
	if err == nil {
		if receipt.RequestHash != hash {
			writeJSON(w, 409, map[string]string{"code": "idempotency_conflict", "error": "idempotency key already used for a different request"})
			return
		}
		d, e := q.GetProjectDocument(r.Context(), db.GetProjectDocumentParams{ID: receipt.DocumentID, WorkspaceID: issue.WorkspaceID, ProjectID: issue.ProjectID})
		if e != nil {
			writeError(w, 404, "document not found")
			return
		}
		rev, e := q.GetProjectDocumentRevision(r.Context(), db.GetProjectDocumentRevisionParams{DocumentID: d.ID, WorkspaceID: d.WorkspaceID, ProjectID: d.ProjectID, Version: receipt.DocumentVersion})
		if e != nil {
			writeError(w, 404, "revision not found")
			return
		}
		relations, e := q.ListProjectDocumentIssues(r.Context(), db.ListProjectDocumentIssuesParams{WorkspaceID: issue.WorkspaceID, ProjectID: issue.ProjectID})
		if e != nil {
			writeError(w, 500, "failed to read relationship")
			return
		}
		linked := false
		for _, rel := range relations {
			if rel.DocumentID == d.ID && rel.IssueID == issue.ID {
				linked = true
			}
		}
		writeJSON(w, 200, AssociateDocumentResponse{Document: documentRevisionResponse(d, rev), Inserted: receipt.Inserted, Replayed: true, Linked: linked})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		writeError(w, 500, "failed to read operation")
		return
	}
	var d db.ProjectDocument
	if in.CreateDocument != nil {
		kind := in.CreateDocument.Kind
		if kind == "" {
			kind = "document"
		}
		if kind != "document" && kind != "spec" {
			writeError(w, 400, "kind must be spec or document")
			return
		}
		body := ""
		if in.CreateDocument.Body != nil {
			body = *in.CreateDocument.Body
		} else if kind == "spec" {
			body = projectSpecTemplate
		}
		title := strings.TrimSpace(in.CreateDocument.Title)
		if !validProjectDocumentContent(w, title, body) {
			return
		}
		d, err = q.CreateProjectDocument(r.Context(), db.CreateProjectDocumentParams{WorkspaceID: issue.WorkspaceID, ProjectID: issue.ProjectID, Kind: kind, Title: title, Body: body, AuthorType: authorType, AuthorID: authorID, AuthorName: authorName})
	} else {
		d, err = q.GetProjectDocument(r.Context(), db.GetProjectDocumentParams{ID: docID, WorkspaceID: issue.WorkspaceID, ProjectID: issue.ProjectID})
	}
	if err != nil {
		writeError(w, 404, "document not found in issue project")
		return
	}
	inserted, changed := false, false
	if in.Source != nil {
		source, key, e := h.resolveDocumentSource(r.Context(), q, issue, requestUserID(r), *in.Source, in.Label, in.Description)
		if e != nil {
			writeJSON(w, 422, e)
			return
		}
		_, e = q.GetProjectDocumentSource(r.Context(), db.GetProjectDocumentSourceParams{WorkspaceID: issue.WorkspaceID, DocumentID: d.ID, SourceKey: key})
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			writeError(w, 500, "failed to read source")
			return
		}
		if errors.Is(e, pgx.ErrNoRows) {
			// A body link can survive unlinking and manual source imports. Preserve it.
			if !hasDocumentSourceLink(d.Body, source.Href) {
				if in.CreateDocument == nil && d.Version != in.BaseVersion {
					h.documentConflict(w, d)
					return
				}
				if d.Body != "" {
					d.Body += "\n\n"
				}
				d.Body += source.Markdown + "\n"
				inserted, changed = true, true
			}
			if !validProjectDocumentContent(w, d.Title, d.Body) {
				return
			}
			version := d.Version
			if changed && in.CreateDocument == nil {
				version++
			}
			raw, _ := json.Marshal(source)
			if err = q.CreateProjectDocumentSource(r.Context(), db.CreateProjectDocumentSourceParams{WorkspaceID: d.WorkspaceID, ProjectID: d.ProjectID, DocumentID: d.ID, IssueID: issue.ID, SourceKey: key, Source: raw, DocumentVersion: version}); err != nil {
				writeError(w, 500, "failed to save source")
				return
			}
		}
	} else if in.CreateDocument == nil && d.Version != in.BaseVersion {
		h.documentConflict(w, d)
		return
	}
	if in.CreateDocument == nil && changed {
		d, err = q.SaveProjectDocument(r.Context(), db.SaveProjectDocumentParams{ID: d.ID, WorkspaceID: d.WorkspaceID, ProjectID: d.ProjectID, Title: d.Title, Body: d.Body, BaseVersion: in.BaseVersion, AuthorType: authorType, AuthorID: authorID, AuthorName: authorName})
		if err != nil {
			writeError(w, 500, "failed to save associated document")
			return
		}
	} else if in.CreateDocument != nil && changed {
		// Creation and its first body link are one initial revision.
		if err = q.SetNewProjectDocumentBody(r.Context(), db.SetNewProjectDocumentBodyParams{ID: d.ID, WorkspaceID: d.WorkspaceID, ProjectID: d.ProjectID, Body: d.Body}); err != nil {
			writeError(w, 500, "failed to create initial document body")
			return
		}
	}
	var resource *db.ProjectResource
	if changed || in.CreateDocument != nil {
		if err = q.CreateProjectDocumentRevision(r.Context(), db.CreateProjectDocumentRevisionParams{ID: d.ID, WorkspaceID: d.WorkspaceID, ProjectID: d.ProjectID}); err != nil {
			writeError(w, 500, "failed to save document revision")
			return
		}
	}
	if in.CreateDocument != nil {
		ref, _ := json.Marshal(map[string]string{"document_id": uuidToString(d.ID)})
		userID, _ := h.parseUserUUIDOrZero(requestUserID(r))
		res, e := q.CreateProjectResource(r.Context(), db.CreateProjectResourceParams{WorkspaceID: d.WorkspaceID, ProjectID: d.ProjectID, ResourceType: "project_document", ResourceRef: ref, Label: pgtype.Text{String: d.Title, Valid: true}, CreatedBy: userID})
		if e != nil {
			writeError(w, 500, "failed to create document resource")
			return
		}
		resource = &res
	}
	if err = q.AssociateProjectDocumentIssue(r.Context(), db.AssociateProjectDocumentIssueParams{WorkspaceID: d.WorkspaceID, ProjectID: d.ProjectID, DocumentID: d.ID, IssueID: issue.ID, DocumentVersion: d.Version}); err != nil {
		writeError(w, 500, "failed to associate document")
		return
	}
	if err = q.CreateProjectDocumentOperation(r.Context(), db.CreateProjectDocumentOperationParams{WorkspaceID: d.WorkspaceID, ProjectID: d.ProjectID, IssueID: issue.ID, IdempotencyKey: in.IdempotencyKey, RequestHash: hash, DocumentID: d.ID, DocumentVersion: d.Version, Inserted: inserted}); err != nil {
		writeError(w, 500, "failed to save operation")
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		writeError(w, 500, "failed to commit association")
		return
	}
	if resource != nil {
		h.publish(protocol.EventProjectResourceCreated, uuidToString(d.WorkspaceID), authorType, uuidToString(authorID), map[string]any{"resource": projectResourceToResponse(*resource), "project_id": uuidToString(d.ProjectID)})
	}
	h.publishDocumentChange(d)
	writeJSON(w, 200, AssociateDocumentResponse{Document: projectDocumentToResponse(d), Inserted: inserted, Linked: true})
}

func (h *Handler) documentConflict(w http.ResponseWriter, d db.ProjectDocument) {
	writeJSON(w, 409, map[string]any{"code": "document_version_conflict", "error": "document has a newer revision; compare and retry with an explicit base_version", "latest": projectDocumentToResponse(d)})
}

func (h *Handler) UnlinkIssueDocument(w http.ResponseWriter, r *http.Request) {
	issue, ok := h.documentIssue(w, r)
	if !ok {
		return
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "documentId"), "document_id")
	if !ok {
		return
	}
	tx, err := h.TxStarter.Begin(r.Context())
	if err != nil {
		writeError(w, 500, "failed to start unlink")
		return
	}
	defer tx.Rollback(r.Context())
	q := h.Queries.WithTx(tx)
	if _, err = q.LockWorkspaceForChatSessionCreate(r.Context(), issue.WorkspaceID); err != nil {
		writeError(w, 404, "workspace not found")
		return
	}
	if _, err = q.LockProjectForChatSessionCreate(r.Context(), db.LockProjectForChatSessionCreateParams{ID: issue.ProjectID, WorkspaceID: issue.WorkspaceID}); err != nil {
		writeError(w, 404, "project not found")
		return
	}
	current, err := q.LockPipelineIssue(r.Context(), db.LockPipelineIssueParams{ID: issue.ID, WorkspaceID: issue.WorkspaceID})
	if err != nil || current.ProjectID != issue.ProjectID {
		writeError(w, 409, "issue project changed")
		return
	}
	d, err := q.GetProjectDocument(r.Context(), db.GetProjectDocumentParams{ID: id, WorkspaceID: issue.WorkspaceID, ProjectID: issue.ProjectID})
	if err != nil {
		writeError(w, 404, "document not found")
		return
	}
	if err = q.UnlinkProjectDocumentIssue(r.Context(), db.UnlinkProjectDocumentIssueParams{WorkspaceID: issue.WorkspaceID, ProjectID: issue.ProjectID, DocumentID: id, IssueID: issue.ID}); err != nil {
		writeError(w, 500, "failed to unlink document")
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		writeError(w, 500, "failed to commit unlink")
		return
	}
	h.publishDocumentChange(d)
	w.WriteHeader(204)
}
