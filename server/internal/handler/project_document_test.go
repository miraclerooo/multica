package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func documentTestProject(t *testing.T) string {
	t.Helper()
	id := dbfx.Project(t, "Specs & Docs")
	t.Cleanup(func() {
		testutil.Call(t, testHandler.DeleteProject, testutil.WithURLParams(newRequest("DELETE", "/api/projects/"+id, nil), "id", id)).Want(204)
	})
	return id
}

func documentTestRequest(method, projectID, documentID string, input any) *http.Request {
	req := newRequest(method, "/api/projects/"+projectID+"/documents/"+documentID, input)
	return testutil.WithURLParams(req, "id", projectID, "documentId", documentID)
}

func createTestDocument(t *testing.T, projectID, title, kind string) ProjectDocumentResponse {
	t.Helper()
	var doc ProjectDocumentResponse
	testutil.Call(t, testHandler.CreateProjectDocument, documentTestRequest("POST", projectID, "", map[string]any{"title": title, "kind": kind})).Want(201).JSON(&doc)
	return doc
}

func TestProjectDocumentLifecycle(t *testing.T) {
	projectID := documentTestProject(t)
	doc := createTestDocument(t, projectID, "Living Spec", "spec")
	if doc.Version != 1 || doc.BaseVersion != 0 || doc.AuthorType != "member" || doc.AuthorID != testUserID || doc.AuthorName == "" {
		t.Fatalf("unexpected initial snapshot: %+v", doc)
	}
	for _, required := range []string{"REQ-01", "WHEN", "THEN", "- [ ]"} {
		if !strings.Contains(doc.Body, required) {
			t.Errorf("template missing %q", required)
		}
	}
	if doc.ResourceURI != fmt.Sprintf("multica://project/%s/documents/%s", projectID, doc.ID) {
		t.Fatalf("invalid resource URI: %s", doc.ResourceURI)
	}
	plain := createTestDocument(t, projectID, "Guide", "document")
	if plain.Body != "" {
		t.Errorf("blank document body = %q", plain.Body)
	}
	var resources struct {
		Resources []ProjectResourceResponse `json:"resources"`
	}
	testutil.Call(t, testHandler.ListProjectResources, documentTestRequest("GET", projectID, "", nil)).Want(200).JSON(&resources)
	var resourceID string
	for _, resource := range resources.Resources {
		var ref struct {
			DocumentID string `json:"document_id"`
		}
		_ = json.Unmarshal(resource.ResourceRef, &ref)
		if ref.DocumentID == doc.ID {
			resourceID = resource.ID
		}
	}
	if resourceID == "" {
		t.Fatal("document resource was not created")
	}
	req := testutil.WithURLParams(newRequest("GET", "/content", nil), "id", projectID, "resourceId", resourceID)
	var resolved ProjectDocumentResponse
	testutil.Call(t, testHandler.GetProjectResourceContent, req).Want(200).JSON(&resolved)
	if resolved.ID != doc.ID || resolved.Version != 1 {
		t.Fatalf("resource resolved wrong snapshot: %+v", resolved)
	}

	var saved ProjectDocumentResponse
	testutil.Call(t, testHandler.SaveProjectDocument, documentTestRequest("PUT", projectID, doc.ID, map[string]any{"base_version": 1, "title": "Renamed spec", "body": "## REQ-02\n\n- [x] Verified"})).Want(200).JSON(&saved)
	if saved.Version != 2 || saved.BaseVersion != 1 || saved.Title != "Renamed spec" {
		t.Fatalf("unexpected saved snapshot: %+v", saved)
	}
	var history struct {
		Revisions []ProjectDocumentResponse `json:"revisions"`
	}
	testutil.Call(t, testHandler.ListProjectDocumentRevisions, documentTestRequest("GET", projectID, doc.ID, nil)).Want(200).JSON(&history)
	if len(history.Revisions) != 2 || history.Revisions[0].Title != saved.Title || history.Revisions[1].Title != doc.Title || history.Revisions[1].Body != doc.Body || history.Revisions[0].BaseVersion != 1 {
		t.Fatalf("history did not preserve title/body/base: %+v", history.Revisions)
	}
	testutil.Call(t, testHandler.GetProjectResourceContent, req).Want(200).JSON(&resolved)
	if resolved.Title != saved.Title || resolved.Body != saved.Body || resolved.Version != 2 {
		t.Fatalf("resource did not resolve latest: %+v", resolved)
	}
	testutil.Call(t, testHandler.UpdateProjectResource, testutil.WithURLParams(newRequest("PUT", "/resource", map[string]any{"label": "wrong"}), "id", projectID, "resourceId", resourceID)).Want(400)
	testutil.Call(t, testHandler.DeleteProjectResource, testutil.WithURLParams(newRequest("DELETE", "/resource", nil), "id", projectID, "resourceId", resourceID)).Want(400)
}

func TestProjectDocumentConcurrentHTTPWrites(t *testing.T) {
	projectID := documentTestProject(t)
	doc := createTestDocument(t, projectID, "Race", "document")
	router := chi.NewRouter()
	router.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Header.Set("X-User-ID", testUserID)
			r.Header.Set("X-Workspace-ID", testWorkspaceID)
			next.ServeHTTP(w, r)
		})
	})
	router.Put("/api/projects/{id}/documents/{documentId}", testHandler.SaveProjectDocument)
	server := httptest.NewServer(router)
	defer server.Close()
	path := server.URL + "/api/projects/" + projectID + "/documents/" + doc.ID
	type result struct {
		status int
		body   []byte
		err    error
	}
	results := make(chan result, 2)
	start := make(chan struct{})
	var ready sync.WaitGroup
	ready.Add(2)
	for _, title := range []string{"member A", "member B"} {
		go func(title string) {
			raw, _ := json.Marshal(map[string]any{"base_version": 1, "title": title, "body": title + " body"})
			req, _ := http.NewRequest("PUT", path, bytes.NewReader(raw))
			req.Header.Set("Content-Type", "application/json")
			ready.Done()
			<-start
			resp, err := server.Client().Do(req)
			if err != nil {
				results <- result{err: err}
				return
			}
			defer resp.Body.Close()
			body, err := io.ReadAll(resp.Body)
			results <- result{status: resp.StatusCode, body: body, err: err}
		}(title)
	}
	ready.Wait()
	close(start)
	statuses := map[int]int{}
	for range 2 {
		result := <-results
		if result.err != nil {
			t.Fatal(result.err)
		}
		statuses[result.status]++
		if result.status == 409 {
			var conflict struct {
				Code   string                  `json:"code"`
				Latest ProjectDocumentResponse `json:"latest"`
			}
			if err := json.Unmarshal(result.body, &conflict); err != nil {
				t.Fatal(err)
			}
			if conflict.Code != "document_version_conflict" || conflict.Latest.Version != 2 {
				t.Fatalf("conflict = %s", result.body)
			}
		}
	}
	if statuses[200] != 1 || statuses[409] != 1 {
		t.Fatalf("competing writes statuses = %v", statuses)
	}
	var current ProjectDocumentResponse
	testutil.Call(t, testHandler.GetProjectDocument, documentTestRequest("GET", projectID, doc.ID, nil)).Want(200).JSON(&current)
	viewedVersion := current.Version
	testutil.Call(t, testHandler.SaveProjectDocument, documentTestRequest("PUT", projectID, doc.ID, map[string]any{"base_version": viewedVersion, "title": "Remote again", "body": "newer than viewed diff"})).Want(200)
	var conflict struct {
		Latest ProjectDocumentResponse `json:"latest"`
	}
	testutil.Call(t, testHandler.SaveProjectDocument, documentTestRequest("PUT", projectID, doc.ID, map[string]any{"base_version": viewedVersion, "title": "Stale confirmation", "body": "local draft"})).Want(409).JSON(&conflict)
	if conflict.Latest.Version != 3 || conflict.Latest.Title != "Remote again" {
		t.Fatalf("stale diff confirmation overwrote remote: %+v", conflict.Latest)
	}
	var history struct {
		Revisions []ProjectDocumentResponse `json:"revisions"`
	}
	testutil.Call(t, testHandler.ListProjectDocumentRevisions, documentTestRequest("GET", projectID, doc.ID, nil)).Want(200).JSON(&history)
	if len(history.Revisions) != 3 {
		t.Fatalf("rejected writes created revisions: %+v", history.Revisions)
	}
}

func TestProjectDocumentScopeValidationAndAgent(t *testing.T) {
	projectID := documentTestProject(t)
	other := documentTestProject(t)
	doc := createTestDocument(t, projectID, "Scoped", "document")
	testutil.Call(t, testHandler.GetProjectDocument, documentTestRequest("GET", other, doc.ID, nil)).Want(404)
	testutil.Call(t, testHandler.SaveProjectDocument, documentTestRequest("PUT", other, doc.ID, map[string]any{"base_version": 1, "title": "wrong project", "body": "no"})).Want(404)
	testutil.Call(t, testHandler.ListProjectDocumentRevisions, documentTestRequest("GET", other, doc.ID, nil)).Want(404)
	foreignWS, foreignProject := foreignWorkspaceWithProject(t, "doc-foreign", "PDF")
	_ = foreignWS
	testutil.Call(t, testHandler.ListProjectDocuments, documentTestRequest("GET", foreignProject, "", nil)).Want(404)
	testutil.Call(t, testHandler.GetProjectDocument, documentTestRequest("GET", projectID, "invalid-id", nil)).Want(400)
	for _, input := range []map[string]any{
		{"title": "", "kind": "spec"}, {"title": "bad", "kind": "unsupported"}, {"title": strings.Repeat("字", 301)},
	} {
		testutil.Call(t, testHandler.CreateProjectDocument, documentTestRequest("POST", projectID, "", input)).Want(400)
	}
	for _, input := range []map[string]any{
		{"title": "missing body", "base_version": 1}, {"title": "missing version", "body": "x"}, {"title": "x", "body": "x", "base_version": 0}, {"title": "x", "body": strings.Repeat("x", 1024*1024+1), "base_version": 1},
	} {
		testutil.Call(t, testHandler.SaveProjectDocument, documentTestRequest("PUT", projectID, doc.ID, input)).Want(400)
	}
	agentID := dbfx.Agent(t, "Spec maintainer", testRuntimeID)
	req := documentTestRequest("PUT", projectID, doc.ID, map[string]any{"title": "Agent revision", "body": "- [x] API verified", "base_version": 1})
	req.Header.Set("X-Actor-Source", "task_token")
	req.Header.Set("X-Agent-ID", agentID)
	var saved ProjectDocumentResponse
	testutil.Call(t, testHandler.SaveProjectDocument, req).Want(200).JSON(&saved)
	if saved.AuthorType != "agent" || saved.AuthorID != agentID || saved.AuthorName != "Spec maintainer" {
		t.Fatalf("wrong agent attribution: %+v", saved)
	}
	var read ProjectDocumentResponse
	testutil.Call(t, testHandler.GetProjectDocument, documentTestRequest("GET", projectID, doc.ID, nil)).Want(200).JSON(&read)
	if read != saved {
		t.Fatalf("web did not read agent revision: %+v vs %+v", read, saved)
	}
}

func TestProjectDocumentRevisionFailureRollsBack(t *testing.T) {
	projectID := documentTestProject(t)
	doc := createTestDocument(t, projectID, "Original", "document")
	dbfx.Insert(t, "project_document_revision", testutil.Cols{"document_id": doc.ID, "workspace_id": testWorkspaceID, "project_id": projectID, "title": "duplicate", "body": "fixture", "version": 2, "base_version": 1, "author_type": "member", "author_id": testUserID, "author_name": "Test"})
	testutil.Call(t, testHandler.SaveProjectDocument, documentTestRequest("PUT", projectID, doc.ID, map[string]any{"title": "Must roll back", "body": "not committed", "base_version": 1})).Want(500)
	var current ProjectDocumentResponse
	testutil.Call(t, testHandler.GetProjectDocument, documentTestRequest("GET", projectID, doc.ID, nil)).Want(200).JSON(&current)
	if current.Version != 1 || current.Title != doc.Title || current.Body != doc.Body {
		t.Fatalf("failed revision changed document: %+v", current)
	}
}

func TestProjectDocumentAvailableToProjectRuns(t *testing.T) {
	projectID := documentTestProject(t)
	doc := createTestDocument(t, projectID, "Shared requirement contract", "spec")
	project, err := testHandler.resolveClaimProjectContext(context.Background(), parseUUID(projectID), parseUUID(testWorkspaceID))
	if err != nil {
		t.Fatal(err)
	}
	if project.ProjectID != projectID || len(project.Resources) != 1 {
		t.Fatalf("run project context = %+v", project)
	}
	resource := project.Resources[0]
	var ref struct {
		DocumentID string `json:"document_id"`
	}
	if err := json.Unmarshal(resource.ResourceRef, &ref); err != nil {
		t.Fatal(err)
	}
	if resource.ResourceType != "project_document" || ref.DocumentID != doc.ID || resource.Label != doc.Title {
		t.Fatalf("document resource not discoverable from run: %+v", resource)
	}
}

func TestProjectDocumentWorkspaceDeletionCleansSnapshots(t *testing.T) {
	workspaceID := dbfx.Insert(t, "workspace", testutil.Cols{"name": "Document cleanup", "slug": "handler-doc-cleanup"})
	dbfx.Insert(t, "member", testutil.Cols{"workspace_id": workspaceID, "user_id": testUserID, "role": "owner"})
	projectID := dbfx.Project(t, "Project to remove", testutil.Cols{"workspace_id": workspaceID})
	req := documentTestRequest("POST", projectID, "", map[string]any{"title": "Workspace-owned Spec", "kind": "spec"})
	req.Header.Set("X-Workspace-ID", workspaceID)
	var doc ProjectDocumentResponse
	testutil.Call(t, testHandler.CreateProjectDocument, req).Want(201).JSON(&doc)
	testutil.Call(t, testHandler.DeleteWorkspace, testutil.WithURLParams(newRequest("DELETE", "/api/workspaces/"+workspaceID, nil), "id", workspaceID)).Want(204)
	for _, table := range []string{"project_document", "project_document_revision", "project_resource"} {
		var count int
		if err := testPool.QueryRow(context.Background(), "SELECT count(*) FROM "+table+" WHERE workspace_id = $1", workspaceID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Errorf("workspace deletion retained %d rows in %s", count, table)
		}
	}
}
