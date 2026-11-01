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

func TestDocumentAssociationCLIContract(t *testing.T) {
	sourceFile := filepath.Join(t.TempDir(), "source.json")
	if err := os.WriteFile(sourceFile, []byte(`{"kind":"document","document_id":"33333333-3333-4333-8333-333333333333","document_version":4}`), 0600); err != nil {
		t.Fatal(err)
	}
	for _, status := range []int{200, 409} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			writes := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" || r.URL.Path != "/api/issues/PROJ-7/documents" {
					t.Errorf("request: %s %s", r.Method, r.URL)
					w.WriteHeader(404)
					return
				}
				var in map[string]any
				if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
					t.Error(err)
				}
				writes++
				source, _ := in["source"].(map[string]any)
				if in["document_id"] != documentCLIId || in["base_version"] != float64(5) || in["idempotency_key"] != "one-association" || source["document_version"] != float64(4) || in["description"] != "Rationale" {
					t.Errorf("association: %+v", in)
				}
				w.WriteHeader(status)
				if status == 409 {
					_, _ = w.Write([]byte(`{"code":"document_version_conflict","latest":{"version":6},"error":"newer document"}`))
					return
				}
				_, _ = w.Write([]byte(`{"document":{"id":"saved","version":6},"inserted":true,"replayed":false,"linked":true}`))
			}))
			defer server.Close()
			setCLITestServerEnv(t, server.URL)
			t.Setenv("MULTICA_TOKEN", "mat_document-association-test")
			cmd := newProjectDocumentCommand()
			cmd.SilenceUsage = true
			cmd.SilenceErrors = true
			cmd.PersistentFlags().String("profile", "", "")
			out := &bytes.Buffer{}
			cmd.SetOut(out)
			cmd.SetErr(&bytes.Buffer{})
			cmd.SetArgs([]string{"associate", "PROJ-7", "--document", documentCLIId, "--base-version", "5", "--idempotency-key", "one-association", "--source-file", sourceFile, "--label", "Design", "--description", "Rationale"})
			err := cmd.Execute()
			if writes != 1 {
				t.Fatalf("writes: %d", writes)
			}
			if status == 409 {
				var httpErr *cli.HTTPError
				if !errors.As(err, &httpErr) || httpErr.StatusCode != 409 {
					t.Fatalf("conflict lost: %v", err)
				}
				if out.Len() > 0 {
					t.Fatal("conflict emitted a success acknowledgement")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var result map[string]any
			if err = json.Unmarshal(out.Bytes(), &result); err != nil || result["inserted"] != true {
				t.Fatalf("JSON: %s %v", out, err)
			}
		})
	}
}

func TestDocumentReferencesUnlinkAndPinnedRevisionCLI(t *testing.T) {
	calls := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.RequestURI())
		if r.Method == "DELETE" {
			w.WriteHeader(204)
			return
		}
		if r.URL.Path == "/api/projects/"+documentCLIProject {
			_ = json.NewEncoder(w).Encode(map[string]any{"id": documentCLIProject, "title": "Project"})
			return
		}
		_, _ = w.Write([]byte(`{"documents":[],"references":[],"total":0}`))
	}))
	defer server.Close()
	setCLITestServerEnv(t, server.URL)
	t.Setenv("MULTICA_TOKEN", "mat_document-reference-test")
	for _, args := range [][]string{{"references", "PROJ-7"}, {"unlink", "PROJ-7", documentCLIId}, {"get", documentCLIProject, documentCLIId, "--version", "2"}, {"sources", documentCLIProject, documentCLIId}, {"list", documentCLIProject, "--issue", "PROJ-7", "--search", "Renamed task"}} {
		cmd := newProjectDocumentCommand()
		cmd.SilenceUsage = true
		cmd.SilenceErrors = true
		cmd.PersistentFlags().String("profile", "", "")
		cmd.SetOut(&bytes.Buffer{})
		cmd.SetErr(&bytes.Buffer{})
		cmd.SetArgs(args)
		if err := cmd.Execute(); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
	}
	for _, want := range []string{"GET /api/issues/PROJ-7/documents", "DELETE /api/issues/PROJ-7/documents/" + documentCLIId, "GET /api/projects/" + documentCLIProject + "/documents/" + documentCLIId + "/revisions/2", "GET /api/projects/" + documentCLIProject + "/documents/" + documentCLIId + "/sources"} {
		found := false
		for _, call := range calls {
			if call == want {
				found = true
			}
		}
		if !found {
			t.Errorf("missing %s in %v", want, calls)
		}
	}
}
