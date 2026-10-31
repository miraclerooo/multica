package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPipelineCLISourceAndJSONContract(t *testing.T) {
	source := "kind: hermes_yaml\nstates:\n  custom: {entry: Keep all original text.}\n"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/pipelines/validate":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["source"] != source || body["squad_id"] != "custom-squad" {
				t.Errorf("source changed: %+v", body)
			}
			_, _ = w.Write([]byte(`{"kind":"hermes_yaml","syntax_valid":true,"binding_valid":true,"diagnostics":[],"plan":null}`))
		case r.Method == "GET" && r.URL.Path == "/api/pipelines/definitions/version":
			_ = json.NewEncoder(w).Encode(map[string]any{"source": source, "kind": "hermes_yaml"})
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	setCLITestServerEnv(t, server.URL)
	t.Setenv("MULTICA_TOKEN", "mat_fake-test-token")
	for _, args := range [][]string{{"validate", "-", "--squad", "custom-squad"}, {"get", "version", "--output", "yaml"}} {
		cmd := newPipelineCommand()
		cmd.PersistentFlags().String("profile", "", "")
		out := &bytes.Buffer{}
		cmd.SetOut(out)
		cmd.SetErr(&bytes.Buffer{})
		cmd.SetIn(strings.NewReader(source))
		cmd.SetArgs(args)
		if err := cmd.Execute(); err != nil {
			t.Fatal(err)
		}
		if args[0] == "get" {
			if out.String() != source {
				t.Fatal("get --output yaml changed source")
			}
		} else if !json.Valid(out.Bytes()) {
			t.Fatalf("stdout is not JSON: %q", out.String())
		}
	}
}

func TestPipelineCLIErrorCodeAndFailedRunQuery(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			_, _ = w.Write([]byte(`{"id":"run","status":"failed"}`))
			return
		}
		w.WriteHeader(409)
		_, _ = w.Write([]byte(`{"code":"revision_conflict","error":"node revision changed"}`))
	}))
	defer server.Close()
	setCLITestServerEnv(t, server.URL)
	t.Setenv("MULTICA_TOKEN", "mat_fake-test-token")
	for _, args := range [][]string{{"run", "get", "run"}, {"job", "approve", "run", "custom-node", "--expected-revision", "4", "--idempotency-key", "one"}} {
		cmd := newPipelineCommand()
		cmd.SilenceErrors = true
		cmd.SilenceUsage = true
		cmd.PersistentFlags().String("profile", "", "")
		out, stderr := &bytes.Buffer{}, &bytes.Buffer{}
		cmd.SetOut(out)
		cmd.SetErr(stderr)
		cmd.SetArgs(args)
		err := cmd.Execute()
		if args[0] == "run" {
			if err != nil || !json.Valid(out.Bytes()) {
				t.Fatalf("failed run query failed: %v %q", err, out.String())
			}
		} else {
			if err == nil || out.Len() != 0 || !json.Valid(stderr.Bytes()) || !strings.Contains(stderr.String(), "revision_conflict") {
				t.Fatalf("unstable error contract: %v stdout=%q stderr=%q", err, out.String(), stderr.String())
			}
		}
	}
}
