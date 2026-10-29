package handler

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func documentRequest(method, projectID, documentID string, body any) *http.Request {
	req := testutil.JSONRequest(method, "/api/projects/"+projectID+"/documents/"+documentID, body)
	return testutil.WithURLParams(testutil.WithHeaders(req, "X-User-ID", testUserID,
		"X-Workspace-ID", testWorkspaceID), "id", projectID, "docId", documentID)
}

func documentFixture(t *testing.T, projectID string, over ...testutil.Cols) string {
	t.Helper()
	cols := testutil.Cols{
		"workspace_id": testWorkspaceID, "project_id": projectID, "title": "Spec",
		"content": "# Original", "created_by": testUserID, "updated_by": testUserID,
	}
	for _, overrides := range over {
		for k, v := range overrides {
			cols[k] = v
		}
	}
	return dbfx.Insert(t, "project_document", cols)
}

func TestProjectDocumentLifecycleAndEvents(t *testing.T) {
	h := *testHandler
	h.Bus = events.New()
	var emitted []events.Event
	h.Bus.SubscribeAll(func(e events.Event) { emitted = append(emitted, e) })
	projectID := dbfx.Project(t, "Document lifecycle")
	markdown := "# 规范\n\n| a | b |\n|---|---|\n\n```go\nfmt.Println(\"hello\")\n```\n"
	var created ProjectDocumentResponse
	testutil.Call(t, h.CreateProjectDocument, documentRequest("POST", projectID, "", map[string]any{
		"title": "  Architecture  ", "content": markdown, "is_pinned": true, "position": 4,
	})).Want(201).JSON(&created)
	t.Cleanup(func() { testPool.Exec(context.Background(), "DELETE FROM project_document WHERE id=$1", created.ID) })
	if created.Title != "Architecture" || created.Content != markdown || created.Revision != 1 || created.CreatedBy != testUserID {
		t.Fatalf("create = %+v", created)
	}
	var loaded ProjectDocumentResponse
	testutil.Call(t, h.GetProjectDocument, documentRequest("GET", projectID, created.ID, nil)).Want(200).JSON(&loaded)
	if loaded != created {
		t.Fatalf("persisted document = %+v, want %+v", loaded, created)
	}
	var updated ProjectDocumentResponse
	testutil.Call(t, h.UpdateProjectDocument, documentRequest("PATCH", projectID, created.ID,
		map[string]any{"revision": 1, "title": "New title"})).Want(200).JSON(&updated)
	if updated.Content != markdown || !updated.IsPinned || updated.Position != 4 || updated.Revision != 2 {
		t.Fatalf("partial update lost untouched fields: %+v", updated)
	}
	var conflict map[string]any
	testutil.Call(t, h.UpdateProjectDocument, documentRequest("PATCH", projectID, created.ID,
		map[string]any{"revision": 1, "content": "stale"})).Want(409).JSON(&conflict)
	if conflict["code"] != "project_document_conflict" || conflict["current_revision"] != float64(2) {
		t.Fatalf("conflict = %#v", conflict)
	}
	staleDelete := documentRequest("DELETE", projectID, created.ID, nil)
	staleDelete.URL.RawQuery = "revision=1"
	testutil.Call(t, h.DeleteProjectDocument, staleDelete).Want(409)
	if len(emitted) != 2 {
		t.Fatalf("failed mutations emitted events: %+v", emitted)
	}
	testutil.Call(t, h.UpdateProjectDocument, documentRequest("PATCH", projectID, created.ID,
		map[string]any{"revision": 2, "content": "", "is_pinned": false, "position": 0})).Want(200).JSON(&updated)
	if updated.Content != "" || updated.IsPinned || updated.Position != 0 || updated.Revision != 3 {
		t.Fatalf("zero values were not saved: %+v", updated)
	}
	deleteReq := documentRequest("DELETE", projectID, created.ID, nil)
	deleteReq.URL.RawQuery = "revision=3"
	testutil.Call(t, h.DeleteProjectDocument, deleteReq).Want(204)
	testutil.Call(t, h.GetProjectDocument, documentRequest("GET", projectID, created.ID, nil)).Want(404)
	if len(emitted) != 4 {
		t.Fatalf("event count = %d", len(emitted))
	}
	for i, eventType := range []string{protocol.EventProjectDocumentCreated, protocol.EventProjectDocumentUpdated,
		protocol.EventProjectDocumentUpdated, protocol.EventProjectDocumentDeleted} {
		e := emitted[i]
		payload := e.Payload.(map[string]any)
		if e.Type != eventType || e.WorkspaceID != testWorkspaceID || e.ActorID != testUserID || e.ActorType != "member" ||
			payload["project_id"] != projectID || payload["document_id"] != created.ID || len(payload) != 3 {
			t.Fatalf("event %d = %+v", i, e)
		}
		wantRevision := []int64{1, 2, 3, 3}[i]
		if payload["revision"] != wantRevision {
			t.Fatalf("event %d revision = %v, want %d", i, payload["revision"], wantRevision)
		}
	}
}

func TestProjectDocumentListPaginationAndIsolation(t *testing.T) {
	projectID := dbfx.Project(t, "Document list")
	otherProject := dbfx.Project(t, "Other project")
	documentFixture(t, otherProject)
	otherWorkspace := dbfx.Workspace(t, "Document list isolation", "docs-list-isolation")
	documentFixture(t, projectID, testutil.Cols{"workspace_id": otherWorkspace})
	documentFixture(t, projectID, testutil.Cols{"position": -1})
	lastPinned := documentFixture(t, projectID, testutil.Cols{"is_pinned": true, "position": 1})
	firstPinned := documentFixture(t, projectID, testutil.Cols{"is_pinned": true, "position": 0, "content": strings.Repeat("文", 300)})
	var page struct {
		Documents []ProjectDocumentSummary `json:"documents"`
		Total     int                      `json:"total"`
		Limit     int                      `json:"limit"`
		Offset    int                      `json:"offset"`
	}
	req := documentRequest("GET", projectID, "", nil)
	req.URL.RawQuery = "limit=1"
	resp := testutil.Call(t, testHandler.ListProjectDocuments, req).Want(200).JSON(&page)
	if len(page.Documents) != 1 || page.Total != 3 || page.Documents[0].ID != firstPinned ||
		page.Documents[0].Excerpt != strings.Repeat("文", 240) || strings.Contains(resp.Body.String(), `"content"`) {
		t.Fatalf("first page = %s", resp.Body.String())
	}
	req.URL.RawQuery = "limit=1&offset=1"
	testutil.Call(t, testHandler.ListProjectDocuments, req).Want(200).JSON(&page)
	if page.Documents[0].ID != lastPinned || page.Offset != 1 || page.Limit != 1 {
		t.Fatalf("second page = %+v", page)
	}
	for _, query := range []string{"limit=0", "limit=101", "offset=-1", "limit=nope"} {
		req.URL.RawQuery = query
		testutil.Call(t, testHandler.ListProjectDocuments, req).Want(400)
	}
	emptyProject := dbfx.Project(t, "Empty docs")
	resp = testutil.Call(t, testHandler.ListProjectDocuments, documentRequest("GET", emptyProject, "", nil)).Want(200)
	if !strings.Contains(resp.Body.String(), `"documents":[]`) {
		t.Fatalf("empty list = %s", resp.Body.String())
	}
}

func TestProjectDocumentAccessBoundaries(t *testing.T) {
	projectID := dbfx.Project(t, "Tenant docs")
	docID := documentFixture(t, projectID)
	wrongProject := dbfx.Project(t, "Wrong parent")
	otherWorkspace := dbfx.Workspace(t, "Other document workspace", "docs-other-workspace")
	dbfx.Member(t, otherWorkspace, testUserID, "owner")
	nonmember := dbfx.User(t, "Document outsider", "docs-outsider@example.test")
	foreignDoc := documentFixture(t, projectID, testutil.Cols{"workspace_id": otherWorkspace})
	for _, endpoint := range []struct {
		name        string
		method      string
		httpHandler http.HandlerFunc
		body        any
	}{
		{"list", "GET", testHandler.ListProjectDocuments, nil},
		{"get", "GET", testHandler.GetProjectDocument, nil},
		{"create", "POST", testHandler.CreateProjectDocument, map[string]any{"title": "New"}},
		{"update", "PATCH", testHandler.UpdateProjectDocument, map[string]any{"revision": 1, "title": "New"}},
		{"delete", "DELETE", testHandler.DeleteProjectDocument, nil},
	} {
		t.Run(endpoint.name, func(t *testing.T) {
			for _, boundary := range []string{"workspace", "nonmember", "anonymous", "malformed_project", "wrong_parent", "foreign_document"} {
				if (boundary == "wrong_parent" || boundary == "foreign_document") && (endpoint.name == "list" || endpoint.name == "create") {
					continue
				}
				req := documentRequest(endpoint.method, projectID, docID, endpoint.body)
				req.URL.RawQuery = "revision=1"
				want := 404
				switch boundary {
				case "workspace":
					req.Header.Set("X-Workspace-ID", otherWorkspace)
				case "nonmember":
					req.Header.Set("X-User-ID", nonmember)
				case "anonymous":
					req.Header.Del("X-User-ID")
					want = 401
				case "malformed_project":
					req = testutil.WithURLParams(req, "id", "bad", "docId", docID)
					want = 400
				case "wrong_parent":
					req = testutil.WithURLParams(req, "id", wrongProject, "docId", docID)
				case "foreign_document":
					req = testutil.WithURLParams(req, "id", projectID, "docId", foreignDoc)
				}
				testutil.Call(t, endpoint.httpHandler, req).Want(want)
			}
		})
	}
}

func TestProjectDocumentDeletePermissions(t *testing.T) {
	for _, role := range []string{"creator", "lead", "admin", "owner", "member", "agent_lead"} {
		t.Run(role, func(t *testing.T) {
			user := dbfx.User(t, "Document "+role, "docs-"+role+"@example.test")
			workspaceRole := role
			if role != "admin" && role != "owner" {
				workspaceRole = "member"
			}
			dbfx.Member(t, testWorkspaceID, user, workspaceRole)
			project := dbfx.Project(t, "Delete permission")
			if role == "lead" || role == "agent_lead" {
				leadType := "member"
				if role == "agent_lead" {
					leadType = "agent"
				}
				dbfx.Exec(t, "UPDATE project SET lead_type=$1, lead_id=$2 WHERE id=$3", leadType, user, project)
			}
			creator := testUserID
			if role == "creator" {
				creator = user
			}
			doc := documentFixture(t, project, testutil.Cols{"created_by": creator})
			if role == "creator" {
				req := documentRequest("POST", project, "", map[string]any{"title": "Member-created document"})
				req.Header.Set("X-User-ID", user)
				var created ProjectDocumentResponse
				testutil.Call(t, testHandler.CreateProjectDocument, req).Want(201).JSON(&created)
				t.Cleanup(func() { testPool.Exec(context.Background(), "DELETE FROM project_document WHERE id=$1", created.ID) })
				doc = created.ID
			}
			update := documentRequest("PATCH", project, doc, map[string]any{"revision": 1, "title": "Member edit"})
			update.Header.Set("X-User-ID", user)
			var updated ProjectDocumentResponse
			testutil.Call(t, testHandler.UpdateProjectDocument, update).Want(200).JSON(&updated)
			if updated.UpdatedBy != user || updated.CreatedBy != creator {
				t.Fatalf("attribution = %+v", updated)
			}
			req := documentRequest("DELETE", project, doc, nil)
			req.URL.RawQuery = "revision=2"
			req.Header.Set("X-User-ID", user)
			want := 204
			if role == "member" || role == "agent_lead" {
				want = 403
			}
			testutil.Call(t, testHandler.DeleteProjectDocument, req).Want(want)
		})
	}
}

func TestProjectDocumentMachineCredentialsReadOnly(t *testing.T) {
	project := dbfx.Project(t, "Machine access")
	doc := documentFixture(t, project)
	for _, source := range []string{"task_token", "cloud_pat"} {
		for _, endpoint := range []struct {
			method string
			fn     http.HandlerFunc
			body   any
			want   int
		}{
			{"GET", testHandler.GetProjectDocument, nil, 200},
			{"GET", testHandler.ListProjectDocuments, nil, 200},
			{"POST", testHandler.CreateProjectDocument, map[string]any{"title": "Agent write"}, 403},
			{"PATCH", testHandler.UpdateProjectDocument, map[string]any{"revision": 1, "title": "Agent write"}, 403},
			{"DELETE", testHandler.DeleteProjectDocument, nil, 403},
		} {
			req := documentRequest(endpoint.method, project, doc, endpoint.body)
			req.URL.RawQuery = "revision=1"
			req.Header.Set("X-Actor-Source", source)
			testutil.Call(t, endpoint.fn, req).Want(endpoint.want)
		}
	}
}

func TestProjectDocumentConcurrentSave(t *testing.T) {
	project := dbfx.Project(t, "Concurrent docs")
	doc := documentFixture(t, project)
	start := make(chan struct{})
	var wg sync.WaitGroup
	recorders := []*httptest.ResponseRecorder{httptest.NewRecorder(), httptest.NewRecorder()}
	for i := range recorders {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			req := documentRequest("PATCH", project, doc, map[string]any{"revision": 1, "content": fmt.Sprintf("Writer %d", i)})
			<-start
			testHandler.UpdateProjectDocument(recorders[i], req)
		}(i)
	}
	close(start)
	wg.Wait()
	winner := -1
	for i, recorder := range recorders {
		if recorder.Code == 200 {
			winner = i
		} else if recorder.Code != 409 {
			t.Fatalf("request %d: %d %s", i, recorder.Code, recorder.Body.String())
		}
	}
	if winner == -1 || recorders[1-winner].Code != 409 {
		t.Fatalf("expected one winner and one conflict: %d, %d", recorders[0].Code, recorders[1].Code)
	}
	var stored ProjectDocumentResponse
	testutil.Call(t, testHandler.GetProjectDocument, documentRequest("GET", project, doc, nil)).Want(200).JSON(&stored)
	if stored.Revision != 2 || stored.Content != fmt.Sprintf("Writer %d", winner) {
		t.Fatalf("stored = %+v", stored)
	}
}

func TestProjectDocumentValidation(t *testing.T) {
	project := dbfx.Project(t, "Validation docs")
	doc := documentFixture(t, project)
	for _, body := range []any{
		`null`, `[]`, `{`, `{} {}`, `{"title":null}`, `{"title":17}`, `{"title":""}`, `{"title":"  \n "}`,
		map[string]any{"title": strings.Repeat("文", 201)},
		map[string]any{"title": "x", "content": strings.Repeat("a", maxProjectDocumentContentBytes+1)},
		map[string]any{"title": "nul\x00"}, map[string]any{"title": "x", "content": "nul\x00"},
		map[string]any{"title": "x", "workspace_id": testWorkspaceID},
		map[string]any{"title": "x", "created_by": testUserID},
		map[string]any{"title": "x", "include_in_context": true},
		map[string]any{"title": "x", "position": 2147483648},
	} {
		testutil.Call(t, testHandler.CreateProjectDocument, documentRequest("POST", project, "", body)).Want(400)
	}
	for _, body := range []any{`{}`, `{"revision":1}`, `{"revision":0,"title":"x"}`, `{"title":"x"}`, `{"revision":1,"content":null}`, `{"revision":1,"project_id":"x"}`} {
		testutil.Call(t, testHandler.UpdateProjectDocument, documentRequest("PATCH", project, doc, body)).Want(400)
	}
	for _, revision := range []string{"", "0", "-1", "1.2", "9223372036854775808"} {
		req := documentRequest("DELETE", project, doc, nil)
		req.URL.RawQuery = "revision=" + revision
		testutil.Call(t, testHandler.DeleteProjectDocument, req).Want(400)
	}
	for _, fn := range []http.HandlerFunc{testHandler.GetProjectDocument, testHandler.UpdateProjectDocument, testHandler.DeleteProjectDocument} {
		testutil.Call(t, fn, documentRequest("GET", project, "bad-id", nil)).Want(400)
	}
}

func TestProjectDocumentParentDeletionCleanup(t *testing.T) {
	keptProject := dbfx.Project(t, "Keep docs")
	keptDoc := documentFixture(t, keptProject)
	for _, parent := range []string{"project", "workspace"} {
		t.Run(parent, func(t *testing.T) {
			ws := testWorkspaceID
			if parent == "workspace" {
				ws = dbfx.Workspace(t, "Delete docs workspace", "docs-delete-workspace")
				dbfx.Member(t, ws, testUserID, "owner")
			}
			project := dbfx.Project(t, "Delete docs parent", testutil.Cols{"workspace_id": ws})
			doc := documentFixture(t, project, testutil.Cols{"workspace_id": ws})
			fn := testHandler.DeleteProject
			id := project
			if parent == "workspace" {
				fn = testHandler.DeleteWorkspace
				id = ws
			}
			req := testutil.WithURLParams(newRequest("DELETE", "/", nil), "id", id)
			req.Header.Set("X-Workspace-ID", ws)
			testutil.Call(t, fn, req).Want(204)
			var count int
			dbfx.QueryRow(t, "SELECT count(*) FROM project_document WHERE id=$1", doc).Scan(&count)
			if count != 0 {
				t.Fatal("document outlived its parent")
			}
			dbfx.QueryRow(t, "SELECT count(*) FROM project_document WHERE id=$1", keptDoc).Scan(&count)
			if count != 1 {
				t.Fatal("another project's document was deleted")
			}
		})
	}
}
