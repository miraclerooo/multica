package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/multica-ai/multica/server/internal/cli"
)

const documentCLIProject = "11111111-1111-4111-8111-111111111111"
const documentCLIId = "22222222-2222-4222-8222-222222222222"

func TestProjectDocumentURI(t *testing.T) {
	uri := "multica://project/" + documentCLIProject + "/documents/" + documentCLIId + "#REQ-01"
	id, err := projectDocumentID(documentCLIProject, uri)
	if err != nil || id != documentCLIId {
		t.Fatalf("resolve URI = %q, %v", id, err)
	}
	for _, invalid := range []string{"bad", "multica://project/33333333-3333-4333-8333-333333333333/documents/" + documentCLIId, "multica://project/" + documentCLIProject + "/specs/SPEC-01.md"} {
		if _, err := projectDocumentID(documentCLIProject, invalid); err == nil {
			t.Errorf("accepted invalid reference %q", invalid)
		}
	}
}

func TestProjectDocumentCLIContract(t *testing.T) {
	body := "## REQ-01\n\n中文文档\n\n- [x] Verified\n"
	file := filepath.Join(t.TempDir(), "document.md")
	if err := os.WriteFile(file, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	for _, status := range []int{200, 409} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			writes := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" && r.URL.Path == "/api/projects/"+documentCLIProject {
					_ = json.NewEncoder(w).Encode(map[string]any{"id": documentCLIProject, "title": "Test"})
					return
				}
				if r.Method != "PUT" || r.URL.Path != "/api/projects/"+documentCLIProject+"/documents/"+documentCLIId {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					w.WriteHeader(404)
					return
				}
				writes++
				var input map[string]any
				if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
					t.Error(err)
				}
				if input["title"] != "Local renamed title" || input["body"] != body || input["base_version"] != float64(7) {
					t.Errorf("wrong snapshot: %+v", input)
				}
				if _, ok := input["author_id"]; ok {
					t.Error("client chose author")
				}
				w.WriteHeader(status)
				if status == 409 {
					_, _ = w.Write([]byte(`{"code":"document_version_conflict","error":"newer revision","latest":{"version":8}}`))
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"id": documentCLIId, "version": 8, "title": input["title"], "body": input["body"]})
			}))
			defer server.Close()
			setCLITestServerEnv(t, server.URL)
			t.Setenv("MULTICA_TOKEN", "mat_test-document-token")
			cmd := newProjectDocumentCommand()
			cmd.PersistentFlags().String("profile", "", "")
			output := &bytes.Buffer{}
			cmd.SetOut(output)
			cmd.SetErr(&bytes.Buffer{})
			cmd.SetArgs([]string{"update", documentCLIProject, "multica://project/" + documentCLIProject + "/documents/" + documentCLIId, "--base-version", "7", "--title", "Local renamed title", "--body-file", file})
			err := cmd.Execute()
			if writes != 1 {
				t.Fatalf("expected one write, got %d", writes)
			}
			if status == 409 {
				var httpError *cli.HTTPError
				if !errors.As(err, &httpError) || httpError.StatusCode != 409 {
					t.Fatalf("conflict not propagated: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var result map[string]any
			if err := json.Unmarshal(output.Bytes(), &result); err != nil {
				t.Fatalf("JSON output invalid: %v", err)
			}
			if result["body"] != body || result["version"] != float64(8) {
				t.Fatalf("invalid saved response: %+v", result)
			}
		})
	}
}

func TestProjectDocumentCLICreateAndDiscover(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		base := "/api/projects/" + documentCLIProject
		switch {
		case r.Method == "GET" && r.URL.Path == base:
			_ = json.NewEncoder(w).Encode(map[string]any{"id": documentCLIProject, "title": "Test"})
		case r.Method == "POST" && r.URL.Path == base+"/documents":
			var input map[string]any
			_ = json.NewDecoder(r.Body).Decode(&input)
			if input["kind"] != "spec" || input["title"] != "New Spec" {
				t.Errorf("wrong create: %+v", input)
			}
			if _, ok := input["body"]; ok {
				t.Error("template should be supplied by the server when no body file is passed")
			}
			w.WriteHeader(201)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": documentCLIId, "version": 1})
		case r.Method == "GET" && r.URL.Path == base+"/documents":
			_ = json.NewEncoder(w).Encode(map[string]any{"documents": []any{map[string]any{"id": documentCLIId}}, "total": 1})
		case r.Method == "GET" && r.URL.Path == base+"/documents/"+documentCLIId:
			_ = json.NewEncoder(w).Encode(map[string]any{"title": "Saved title", "body": "Saved Markdown"})
		case r.Method == "GET" && r.URL.Path == base+"/documents/"+documentCLIId+"/revisions":
			_ = json.NewEncoder(w).Encode(map[string]any{"revisions": []any{map[string]any{"version": 1}}, "total": 1})
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	setCLITestServerEnv(t, server.URL)
	t.Setenv("MULTICA_TOKEN", "mat_test-document-token")
	for _, args := range [][]string{
		{"create", documentCLIProject, "--kind", "spec", "--title", "New Spec"},
		{"list", documentCLIProject}, {"get", documentCLIProject, documentCLIId, "--output", "markdown"}, {"history", documentCLIProject, documentCLIId},
	} {
		cmd := newProjectDocumentCommand()
		cmd.PersistentFlags().String("profile", "", "")
		cmd.SetOut(&bytes.Buffer{})
		cmd.SetArgs(args)
		if err := cmd.Execute(); err != nil {
			t.Fatal(err)
		}
	}
}
