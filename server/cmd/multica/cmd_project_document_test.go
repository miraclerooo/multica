package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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

func TestProjectDocumentCLIBodyInputsAndPartialUpdates(t *testing.T) {
	body := "## 中文\n\n保留字面量 \\n 和 C:\\project\\docs\n"
	for _, tc := range []struct {
		name, op, title, wantBody string
		flags                     []string
		readBase                  bool
	}{
		{"inline create", "create", "New", body, []string{"--title", "New", "--body", body}, false},
		{"stdin create", "create", "New", body, []string{"--title", "New", "--body-file", "-"}, false},
		{"empty create", "create", "New", "", []string{"--title", "New", "--kind", "spec", "--body", ""}, false},
		{"body update", "update", "Original", body, []string{"--base-version", "7", "--body", body}, true},
		{"stdin update", "update", "Original", body, []string{"--base-version", "7", "--body-file", "-"}, true},
		{"rename", "update", "Renamed", "Original body", []string{"--base-version", "7", "--title", "Renamed"}, true},
		{"clear body", "update", "Original", "", []string{"--base-version", "7", "--body", ""}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			writes, baseReads := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				base := "/api/projects/" + documentCLIProject
				switch {
				case r.Method == "GET" && r.URL.Path == base:
					_ = json.NewEncoder(w).Encode(map[string]any{"id": documentCLIProject, "title": "Test"})
				case r.Method == "GET" && r.URL.Path == base+"/documents/"+documentCLIId+"/revisions/7":
					baseReads++
					_ = json.NewEncoder(w).Encode(map[string]any{"title": "Original", "body": "Original body", "version": 7})
				case (r.Method == "POST" && r.URL.Path == base+"/documents") || (r.Method == "PUT" && r.URL.Path == base+"/documents/"+documentCLIId):
					writes++
					var input map[string]any
					if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
						t.Error(err)
					}
					if input["title"] != tc.title || input["body"] != tc.wantBody {
						t.Errorf("unexpected document: %+v", input)
					}
					if tc.op == "update" && input["base_version"] != float64(7) {
						t.Errorf("lost explicit version: %+v", input)
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"id": documentCLIId, "body": input["body"], "title": input["title"], "version": 8})
				default:
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			setCLITestServerEnv(t, server.URL)
			t.Setenv("MULTICA_TOKEN", "mat_test-document-token")
			cmd := newProjectDocumentCommand()
			cmd.PersistentFlags().String("profile", "", "")
			cmd.SetOut(&bytes.Buffer{})
			cmd.SetIn(strings.NewReader(body))
			args := []string{tc.op, documentCLIProject}
			if tc.op == "update" {
				args = append(args, documentCLIId)
			}
			cmd.SetArgs(append(args, tc.flags...))
			if err := cmd.Execute(); err != nil {
				t.Fatal(err)
			}
			if writes != 1 || (baseReads == 1) != tc.readBase {
				t.Fatalf("writes=%d, base reads=%d", writes, baseReads)
			}
		})
	}
}

func TestProjectDocumentCLIDelete(t *testing.T) {
	for _, status := range []int{204, 404, 409} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			writes := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				base := "/api/projects/" + documentCLIProject
				if r.Method == "GET" && r.URL.Path == base {
					_ = json.NewEncoder(w).Encode(map[string]any{"id": documentCLIProject, "title": "Test"})
					return
				}
				if r.Method != "DELETE" || r.URL.Path != base+"/documents/"+documentCLIId {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
					w.WriteHeader(404)
					return
				}
				writes++
				var input struct {
					BaseVersion int `json:"base_version"`
				}
				if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.BaseVersion != 7 {
					t.Errorf("delete version = %+v, %v", input, err)
				}
				w.WriteHeader(status)
				if status != 204 {
					_, _ = w.Write([]byte(`{"code":"document_version_conflict","error":"changed","latest":{"version":8}}`))
				}
			}))
			defer server.Close()
			setCLITestServerEnv(t, server.URL)
			t.Setenv("MULTICA_TOKEN", "mat_test-document-token")
			cmd := newProjectDocumentCommand()
			cmd.PersistentFlags().String("profile", "", "")
			out := &bytes.Buffer{}
			cmd.SilenceUsage = true
			cmd.SetOut(out)
			cmd.SetErr(&bytes.Buffer{})
			cmd.SetArgs([]string{"delete", documentCLIProject, "multica://project/" + documentCLIProject + "/documents/" + documentCLIId, "--base-version", "7"})
			err := cmd.Execute()
			if writes != 1 {
				t.Fatalf("delete requests = %d; do not retry a rejected deletion", writes)
			}
			if status != 204 {
				var httpErr *cli.HTTPError
				if !errors.As(err, &httpErr) || httpErr.StatusCode != status || out.Len() != 0 {
					t.Fatalf("failed delete = %v, stdout=%q", err, out.String())
				}
				return
			}
			var result map[string]any
			if err != nil || json.Unmarshal(out.Bytes(), &result) != nil || result["id"] != documentCLIId || result["deleted"] != true {
				t.Fatalf("delete = %v, stdout=%q", err, out.String())
			}
		})
	}
}

func TestProjectDocumentCLIRejectsInvalidWrites(t *testing.T) {
	writes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			writes++
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": documentCLIProject, "title": "Test"})
	}))
	defer server.Close()
	setCLITestServerEnv(t, server.URL)
	t.Setenv("MULTICA_TOKEN", "mat_test-document-token")
	for _, args := range [][]string{
		{"create", documentCLIProject, "--title", "New", "--body", "one", "--body-file", "-"},
		{"update", documentCLIProject, documentCLIId, "--base-version", "1"},
		{"update", documentCLIProject, documentCLIId, "--base-version", "0", "--body", "new"},
		{"update", documentCLIProject, documentCLIId, "--base-version", "1", "--title", ""},
		{"delete", documentCLIProject, documentCLIId},
		{"delete", documentCLIProject, documentCLIId, "--base-version", "0"},
		{"delete", documentCLIProject, "multica://project/33333333-3333-4333-8333-333333333333/documents/" + documentCLIId, "--base-version", "1"},
	} {
		cmd := newProjectDocumentCommand()
		cmd.PersistentFlags().String("profile", "", "")
		cmd.SetOut(&bytes.Buffer{})
		cmd.SetErr(&bytes.Buffer{})
		cmd.SetArgs(args)
		if err := cmd.Execute(); err == nil {
			t.Fatalf("accepted invalid args %v", args)
		}
	}
	if writes != 0 {
		t.Fatalf("invalid input made %d writes", writes)
	}
}

func TestProjectDocumentCLIPartialUpdateRejectsMalformedBase(t *testing.T) {
	for _, base := range []string{
		`{"title":"Original","version":7}`,
		`{"body":"Original body","version":7}`,
		`{"title":"Original","body":null,"version":7}`,
		`{"title":"Original","body":"Original body","version":8}`,
	} {
		t.Run(base, func(t *testing.T) {
			writes := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" {
					writes++
				}
				_, _ = w.Write([]byte(base))
			}))
			defer server.Close()
			setCLITestServerEnv(t, server.URL)
			t.Setenv("MULTICA_TOKEN", "mat_test-document-token")
			cmd := newProjectDocumentCommand()
			cmd.PersistentFlags().String("profile", "", "")
			cmd.SetOut(&bytes.Buffer{})
			cmd.SetErr(&bytes.Buffer{})
			cmd.SetArgs([]string{"update", documentCLIProject, documentCLIId, "--base-version", "7", "--title", "Renamed"})
			if err := cmd.Execute(); err == nil || writes != 0 {
				t.Fatalf("malformed snapshot was accepted: error=%v, writes=%d", err, writes)
			}
		})
	}
}
