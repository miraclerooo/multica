package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestDocumentAssociationAuthenticatedHTTP(t *testing.T) {
	f := testutil.New(testPool, testWorkspaceID, testUserID)
	project := f.Project(t, "HTTP Markdown project")
	issue := f.Issue(t, "HTTP document source", testutil.Cols{"project_id": project})
	f.Cleanup(t, "DELETE FROM project_resource WHERE project_id=$1", project)
	f.Cleanup(t, "DELETE FROM project_document WHERE project_id=$1", project)
	f.Cleanup(t, "DELETE FROM project_document_revision WHERE project_id=$1", project)
	f.Cleanup(t, "DELETE FROM project_document_source WHERE project_id=$1", project)
	f.Cleanup(t, "DELETE FROM project_document_operation WHERE project_id=$1", project)
	f.Cleanup(t, "DELETE FROM project_document_issue WHERE project_id=$1", project)
	call := func(method, path, token string, input any, want int) []byte {
		t.Helper()
		var raw []byte
		if input != nil {
			raw, _ = json.Marshal(input)
		}
		req, err := http.NewRequest(method, testServer.URL+path, bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		req.Header.Set("X-Workspace-ID", testWorkspaceID)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != want {
			t.Fatalf("%s %s = %d want %d: %s", method, path, resp.StatusCode, want, data)
		}
		return data
	}
	path := "/api/issues/" + issue + "/documents"
	call("GET", path, "", nil, 401)
	input := map[string]any{"create_document": map[string]any{"title": "HTTP delivery", "kind": "document", "body": "Human prose\n"}, "base_version": 0, "idempotency_key": "http-association", "source": map[string]any{"kind": "url", "url": "https://example.org/decision"}, "label": "Decision"}
	data := call("POST", path, testToken, input, 200)
	var result struct {
		Document struct {
			ID      string `json:"id"`
			Body    string `json:"body"`
			Version int    `json:"version"`
		} `json:"document"`
		Replayed bool `json:"replayed"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	id, originalBody := result.Document.ID, result.Document.Body
	if id == "" || result.Document.Version != 1 || !strings.Contains(originalBody, "[Decision](<https://example.org/decision>)") {
		t.Fatalf("creation: %s", data)
	}
	data = call("POST", path, testToken, input, 200)
	if err := json.Unmarshal(data, &result); err != nil || !result.Replayed || result.Document.ID != id {
		t.Fatalf("replay: %s", data)
	}
	docPath := "/api/projects/" + project + "/documents/" + id
	call("PUT", docPath, testToken, map[string]any{"title": "New title", "body": "Human edit", "base_version": 1}, 200)
	pinned := call("GET", docPath+"/revisions/1/content", testToken, nil, 200)
	if string(pinned) != originalBody {
		t.Fatalf("pinned content changed: %s", pinned)
	}
	call("GET", docPath+"/sources", testToken, nil, 200)
	grouped := call("GET", "/api/projects/"+project+"/documents?q=HTTP+document+source", testToken, nil, 200)
	if !bytes.Contains(grouped, []byte(`"issue_id":"`+issue+`"`)) {
		t.Fatalf("grouping: %s", grouped)
	}
	call("DELETE", path+"/"+id, testToken, nil, 204)
	if data = call("GET", path, testToken, nil, 200); !bytes.Contains(data, []byte(`"total":0`)) {
		t.Fatalf("unlink left relation: %s", data)
	}
	call("GET", docPath+"/revisions/1", testToken, nil, 200)
}
