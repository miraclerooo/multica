package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// TestMain isolates the application home and cwd. Keep the compiler's original
// environment so this build can reuse the module/toolchain caches, while every
// application subprocess below keeps the isolated home and fake credentials.
var cliProcessBuildEnv = os.Environ()

func TestPipelineJSONErrorProcess(t *testing.T) {
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate CLI source")
	}
	binary := filepath.Join(t.TempDir(), "multica")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	build := exec.CommandContext(ctx, "go", "build", "-o", binary, ".")
	build.Dir, build.Env = filepath.Dir(source), cliProcessBuildEnv
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build real CLI: %v\n%s", err, out)
	}

	const id = "33333333-3333-4333-8333-333333333333"
	const project = "11111111-1111-4111-8111-111111111111"
	associate := func(output string) []string {
		args := []string{"project", "document", "associate", "PROJ-7", "--document", id, "--base-version", "5", "--idempotency-key", "one"}
		if output != "" {
			args = append(args, "--output", output)
		}
		return args
	}
	squad := []string{"squad", "update", id, "--instructions-mode", "pipeline", "--expected-revision", "1"}
	const documentConflict = `{"code":"document_version_conflict","error":"Document changed","latest":{"version":6},"revision":9007199254740993}`
	const definitionError = `{"code":"definition_not_owned","error":"Definition must belong to this squad"}`
	const approvalConflict = `{"code":"revision_conflict","error":"Node revision changed","revision":7}`
	largeConflict := fmt.Sprintf(`{"code":"document_version_conflict","error":"Document changed","latest":{"body":%q,"version":6}}`, strings.Repeat("x", 8192))

	cases := []struct {
		name    string
		args    []string
		status  int
		body    string
		exit    int
		code    string
		text    bool
		stdout  string
		path    string
		method  string
		request string
	}{
		{name: "association_conflict", args: associate("json"), status: 409, body: documentConflict, exit: 1, code: "document_version_conflict"},
		{name: "association_default_json", args: associate(""), status: 409, body: documentConflict, exit: 1, code: "document_version_conflict"},
		{name: "association_large_latest", args: associate("json"), status: 409, body: largeConflict, exit: 1, code: "document_version_conflict"},
		{name: "association_debug_stays_json", args: append(associate("json"), "--debug"), status: 409, body: documentConflict, exit: 1, code: "document_version_conflict"},
		{name: "references_forbidden", args: []string{"project", "document", "references", "PROJ-7", "--output=json"}, status: 403, body: `{"code":"source_forbidden","error":"Source access denied","revision":7}`, exit: 3, code: "source_forbidden"},
		{name: "unlink_missing_document", args: []string{"project", "document", "unlink", "PROJ-7", id, "--output", "json"}, status: 404, body: `{"code":"document_not_found","error":"Document missing"}`, exit: 4, code: "document_not_found"},
		{name: "document_query", args: []string{"project", "document", "get", project, id, "--output=json"}, status: 404, body: `{"code":"document_not_found","error":"Document missing"}`, exit: 4, code: "document_not_found"},
		{name: "squad_definition_ownership", args: append(append([]string{}, squad...), "--output", "json"), status: 404, body: definitionError, exit: 4, code: "definition_not_owned"},
		{name: "squad_revision_conflict", args: append(append([]string{}, squad...), "--output=json"), status: 409, body: approvalConflict, exit: 1, code: "revision_conflict"},
		{name: "pipeline_approval_control", args: []string{"pipeline", "job", "approve", "run", "custom", "--expected-revision", "4", "--idempotency-key", "one"}, status: 409, body: approvalConflict, exit: 1, code: "revision_conflict"},
		{name: "pipeline_query_error", args: []string{"pipeline", "run", "get", "run", "--output=json"}, status: 404, body: definitionError, exit: 1, code: "definition_not_owned"},
		{name: "pipeline_logs_error", args: []string{"pipeline", "job", "logs", "run", "custom"}, status: 403, body: definitionError, exit: 1, code: "definition_not_owned"},
		{name: "pipeline_artifact_query_error", args: []string{"pipeline", "artifact", "list", "run"}, status: 403, body: definitionError, exit: 1, code: "definition_not_owned"},
		{name: "pipeline_artifact_download_error", args: []string{"pipeline", "artifact", "download", "run/custom/1/report.md"}, status: 404, body: definitionError, exit: 1, code: "definition_not_owned"},
		{name: "pipeline_definition_error", args: []string{"pipeline", "create", "-", "--squad", id, "--idempotency-key", "one"}, status: 422, body: `{"code":"invalid_definition","error":"Invalid source","diagnostics":[{"line":2}]}`, exit: 1, code: "invalid_definition"},
		{name: "http_object_without_code", args: []string{"project", "document", "references", "PROJ-7"}, status: 403, body: `{"error":"Forbidden","details":{"reason":"scope"}}`, exit: 3, code: "command_failed"},
		{name: "http_text_fallback", args: append(append([]string{}, squad...), "--output=json"), status: 502, body: "upstream unavailable", exit: 1, code: "command_failed"},
		{name: "missing_pipeline_flags", args: []string{"pipeline", "run", "create", "--output", "json"}, exit: 1, code: "pipeline_command_failed"},
		{name: "missing_association_flag", args: []string{"project", "document", "associate", "PROJ-7", "--new-title", "Notes", "--output=json"}, exit: 1, code: "command_failed"},
		{name: "missing_pipeline_argument", args: []string{"pipeline", "run", "get", "--output=json"}, exit: 1, code: "pipeline_command_failed"},
		{name: "missing_unlink_argument", args: []string{"project", "document", "unlink", "PROJ-7", "--output=json"}, exit: 1, code: "command_failed"},
		{name: "missing_squad_argument", args: []string{"squad", "update", "--instructions-mode", "pipeline", "--output=json"}, exit: 1, code: "command_failed"},
		{name: "unknown_pipeline_flag", args: []string{"pipeline", "run", "get", "run", "--unknown-option", "--output=json"}, exit: 1, code: "pipeline_command_failed"},
		{name: "invalid_squad_flag_before_output", args: []string{"squad", "update", id, "--instructions-mode", "pipeline", "--output=table", "--expected-revision", "nope", "--output=json"}, exit: 1, code: "command_failed"},
		{name: "invalid_document_flag", args: []string{"project", "document", "associate", "PROJ-7", "--new-title", "Notes", "--base-version", "nope", "--output=json"}, exit: 1, code: "command_failed"},
		{name: "invalid_document_uuid", args: []string{"project", "document", "unlink", "PROJ-7", "invalid", "--output=json"}, exit: 1, code: "command_failed"},
		{name: "invalid_document_selection", args: []string{"project", "document", "associate", "PROJ-7", "--document", id, "--new-title", "Notes", "--idempotency-key", "one", "--output=json"}, exit: 1, code: "command_failed"},
		{name: "missing_local_file", args: []string{"pipeline", "create", "does-not-exist.yaml", "--squad", id, "--idempotency-key", "one"}, exit: 1, code: "pipeline_command_failed"},
		{name: "association_text_unchanged", args: associate("table"), status: 409, body: documentConflict, exit: 1, text: true},
		{name: "squad_text_unchanged", args: append(append([]string{}, squad...), "--output=table"), status: 404, body: definitionError, exit: 4, text: true},
		{name: "pipeline_non_json_exit_unchanged", args: []string{"pipeline", "run", "get", "run", "--output=yaml"}, status: 404, body: definitionError, exit: 4, text: true},
		{name: "non_json_positional_help_unchanged", args: []string{"project", "document", "get", project, "--output=table"}, exit: 1, text: true, stdout: "help"},
		{name: "output_like_file_value_is_not_a_flag", args: []string{"pipeline", "job", "reject", "run", "custom", "--output=yaml", "--expected-revision", "4", "--idempotency-key", "one", "--reason-file", "--output=json"}, exit: 1, text: true},
		{name: "output_after_terminator_is_not_a_flag", args: []string{"pipeline", "validate", "--output=yaml", "--", "--output=json"}, exit: 1, text: true},
		{name: "unrelated_command_unchanged", args: []string{"issue", "get", id, "--output=json"}, status: 404, body: definitionError, exit: 4, text: true},
		{name: "failed_run_query_control", args: []string{"pipeline", "run", "get", "run"}, status: 200, body: `{"id":"run","status":"failed"}`, stdout: "json"},
		{name: "association_success", args: associate("json"), status: 200, body: `{"document":{"id":"doc","version":6},"inserted":true,"linked":true}`, stdout: "json"},
		{name: "references_success", args: []string{"project", "document", "references", "PROJ-7"}, status: 200, body: `{"documents":[],"references":[],"total":0}`, stdout: "json"},
		{name: "unlink_success", args: []string{"project", "document", "unlink", "PROJ-7", id}, status: 204, stdout: "json"},
		{name: "squad_success", args: append(append([]string{}, squad...), "--output=json"), status: 200, body: `{"id":"squad","instructions_mode":"pipeline","revision":2}`, stdout: "json"},
		{name: "catalog_create", args: []string{"pipeline", "catalog", "create", "-", "--squad", id, "--name", "Named pipeline", "--idempotency-key", "one"}, status: 201, body: `{"pipeline":{"id":"p"},"definition":{"id":"d"}}`, stdout: "json", path: "/api/pipelines/catalog", method: "POST"},
		{name: "catalog_list", args: []string{"pipeline", "catalog", "list", "--squad", id}, status: 200, body: `{"items":[],"limit":50,"offset":0}`, stdout: "json", path: "/api/pipelines/catalog", method: "GET"},
		{name: "catalog_rename_conflict", args: []string{"pipeline", "catalog", "rename", id, "--name", "New name", "--expected-revision", "2"}, status: 409, body: documentConflict, exit: 1, code: "document_version_conflict", path: "/api/pipelines/catalog/" + id, method: "PATCH", request: `{"name":"New name","expected_revision":2}`},
		{name: "catalog_get_forbidden", args: []string{"pipeline", "catalog", "get", id}, status: 403, body: `{"code":"invocation_forbidden","error":"Denied"}`, exit: 1, code: "invocation_forbidden", path: "/api/pipelines/catalog/" + id, method: "GET"},
		{name: "catalog_missing_required", args: []string{"pipeline", "catalog", "create", "-", "--output=json"}, exit: 1, code: "pipeline_command_failed"},
		{name: "catalog_bad_position", args: []string{"pipeline", "catalog", "rename", "--name", "n", "--expected-revision", "1"}, exit: 1, code: "pipeline_command_failed"},
		{name: "catalog_append_version", args: []string{"pipeline", "create", "-", "--squad", id, "--pipeline", project, "--idempotency-key", "two", "--expected-pipeline-revision", "2"}, status: 409, body: approvalConflict, exit: 1, code: "revision_conflict", path: "/api/pipelines/definitions", method: "POST"},
		{name: "catalog_filter_versions", args: []string{"pipeline", "list", "--squad", id, "--pipeline", project}, status: 200, body: `{"items":[]}`, stdout: "json", path: "/api/pipelines/definitions", method: "GET"},
		{name: "preflight_unknown_is_business_result", args: []string{"pipeline", "preflight", "--squad", id, "--execution", "pipeline", "--pipeline", project}, status: 200, body: `{"state":"waiting_runtime","readiness":{"ready":false,"runtimes":[{"status":"unknown"}]}}`, stdout: "json", path: "/api/pipelines/preflight", method: "POST", request: `{"squad_id":"33333333-3333-4333-8333-333333333333","execution":{"mode":"pipeline","pipeline_id":"11111111-1111-4111-8111-111111111111"}}`},
		{name: "preflight_invalid_selection", args: []string{"pipeline", "preflight", "--squad", id, "--execution", "markdown", "--pipeline", project}, exit: 1, code: "invalid_execution_selection"},
		{name: "execution_waiting", args: []string{"pipeline", "execution", "start", "PROJ-7"}, status: 409, body: `{"code":"runtime_not_ready","error":"Waiting","execution":{"definition_id":"frozen","readiness":{"ready":false}}}`, exit: 1, code: "runtime_not_ready", path: "/api/issues/PROJ-7/execution/start", method: "POST"},
		{name: "execution_query", args: []string{"pipeline", "execution", "get", "PROJ-7"}, status: 200, body: `{"execution":{"state":"waiting_runtime"}}`, stdout: "json", path: "/api/issues/PROJ-7/execution", method: "GET"},
		{name: "new_default_owned_error", args: []string{"squad", "update", id, "--pipeline", project, "--expected-revision", "2"}, status: 404, body: definitionError, exit: 4, code: "definition_not_owned", path: "/api/squads/" + id, method: "PUT", request: `{"pipeline_id":"11111111-1111-4111-8111-111111111111","expected_revision":2}`},
		{name: "issue_create_missing_title", args: []string{"issue", "create", "--output=json"}, exit: 1, code: "command_failed"},
		{name: "issue_create_bad_selection", args: []string{"issue", "create", "--title", "One", "--execution", "pipeline"}, exit: 1, code: "invalid_execution_selection"},
		{name: "issue_create_bad_flag", args: []string{"issue", "create", "--not-a-flag", "--output=json"}, exit: 1, code: "command_failed"},
		{name: "issue_create_pipeline_owned_error", args: []string{"issue", "create", "--title", "One", "--assignee-id", id, "--execution", "pipeline", "--pipeline", project, "--idempotency-key", "issue-one"}, status: 404, body: definitionError, exit: 4, code: "definition_not_owned", path: "/api/issues", method: "POST", request: `{"title":"One","assignee_type":"squad","assignee_id":"33333333-3333-4333-8333-333333333333","execution":{"mode":"pipeline","pipeline_id":"11111111-1111-4111-8111-111111111111"},"idempotency_key":"issue-one"}`},
		{name: "issue_create_duplicate_keeps_code", args: []string{"issue", "create", "--title", "One"}, status: 409, body: `{"code":"active_duplicate_issue","error":"Duplicate","issue":{"id":"old","identifier":"PROJ-7","title":"One"}}`, exit: 1, code: "active_duplicate_issue", path: "/api/issues", method: "POST"},
		{name: "issue_create_pipeline_success", args: []string{"issue", "create", "--title", "One", "--assignee-id", id, "--execution", "pipeline", "--pipeline", project}, status: 201, body: `{"id":"issue-one","execution":{"requested_mode":"pipeline","pipeline_id":"11111111-1111-4111-8111-111111111111","definition_id":"fixed","state":"waiting_runtime"}}`, stdout: "json", path: "/api/issues", method: "POST"},
		{name: "issue_create_requires_snapshot_ack", args: []string{"issue", "create", "--title", "One", "--assignee-id", id, "--execution", "markdown"}, status: 201, body: `{"id":"issue-one"}`, exit: 1, code: "execution_snapshot_missing", path: "/api/issues", method: "POST"},
		{name: "issue_create_old_server_refused", args: []string{"issue", "create", "--title", "One", "--execution", "markdown"}, status: 200, body: `{}`, exit: 1, code: "unsupported_capability"},
		{name: "version_reports_build_capabilities", args: []string{"version", "--output=json"}, stdout: "json"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Header.Get("Authorization") != "Bearer mat_process_fake" {
					t.Error("CLI did not use fake process credential")
				}
				w.Header().Set("Content-Type", "application/json")
				if len(tc.args) > 1 && tc.args[0] == "issue" && tc.args[1] == "create" && tc.status != 0 {
					switch r.URL.Path {
					case "/api/pipelines/capabilities":
						if tc.name == "issue_create_old_server_refused" {
							fmt.Fprint(w, `{"features":{}}`)
						} else {
							fmt.Fprint(w, `{"features":{"task_execution_selection":true}}`)
						}
						return
					case "/api/squads":
						fmt.Fprintf(w, `[{"id":%q,"name":"Fake squad"}]`, id)
						return
					case "/api/agents", "/api/workspaces/" + project + "/members":
						fmt.Fprint(w, `[]`)
						return
					}
				}
				if r.URL.Path == "/api/projects/"+project {
					_, _ = fmt.Fprintf(w, `{"id":%q,"title":"Test project"}`, project)
					return
				}
				if tc.status == 0 {
					t.Errorf("local failure made HTTP request: %s %s", r.Method, r.URL)
					w.WriteHeader(500)
					return
				}
				if tc.path != "" && (r.URL.Path != tc.path || r.Method != tc.method) {
					t.Errorf("wrong request %s %s", r.Method, r.URL)
				}
				if tc.request != "" {
					var got, want any
					if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
						t.Error(err)
					}
					_ = json.Unmarshal([]byte(tc.request), &want)
					a, _ := json.Marshal(got)
					b, _ := json.Marshal(want)
					if !bytes.Equal(a, b) {
						t.Errorf("request %s want %s", a, b)
					}
				}
				w.WriteHeader(tc.status)
				if tc.status != 204 {
					_, _ = fmt.Fprint(w, tc.body)
				}
			}))
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, binary, tc.args...)
			cmd.Dir = t.TempDir()
			for _, env := range os.Environ() {
				if !strings.HasPrefix(env, "MULTICA_") && !strings.HasPrefix(env, "LANG=") && !strings.HasPrefix(env, "LC_ALL=") {
					cmd.Env = append(cmd.Env, env)
				}
			}
			cmd.Env = append(cmd.Env, "MULTICA_SERVER_URL="+server.URL, "MULTICA_TOKEN=mat_process_fake", "MULTICA_WORKSPACE_ID="+project, cli.TaskConfigRootEnv+"="+filepath.Join(cmd.Dir, "config"), "LANG=C", "LC_ALL=C")
			cmd.Stdin = strings.NewReader("kind: gitlab_yaml\nstages: [custom]\nwork: {stage: custom, instructions: Preserve me.}\n")
			var stdout, stderr bytes.Buffer
			cmd.Stdout, cmd.Stderr = &stdout, &stderr
			err := cmd.Run()
			exit := 0
			if err != nil {
				var failure *exec.ExitError
				if !errors.As(err, &failure) {
					t.Fatalf("run CLI: %v", err)
				}
				exit = failure.ExitCode()
			}
			if ctx.Err() != nil {
				t.Fatalf("CLI timed out: %v", ctx.Err())
			}
			t.Logf("exit=%d stdout=%d bytes stderr=%d bytes", exit, stdout.Len(), stderr.Len())
			if exit != tc.exit {
				t.Fatalf("exit=%d want %d; stderr=%.200s", exit, tc.exit, stderr.String())
			}
			if tc.stdout == "" && stdout.Len() != 0 {
				t.Fatalf("error polluted stdout: %.200s", stdout.String())
			}
			if tc.status == 0 && calls.Load() != 0 {
				t.Fatal("local error reached HTTP")
			}
			if tc.text {
				if stderr.Len() == 0 || json.Valid(stderr.Bytes()) {
					t.Fatalf("non-JSON error changed: %.200s", stderr.String())
				}
				if tc.stdout == "help" && stdout.Len() == 0 {
					t.Fatal("non-JSON positional error lost help")
				}
				return
			}
			if exit == 0 {
				if stderr.Len() != 0 || !json.Valid(stdout.Bytes()) {
					t.Fatalf("success streams: stdout=%.200s stderr=%.200s", stdout.String(), stderr.String())
				}
				if tc.name == "failed_run_query_control" && !strings.Contains(stdout.String(), `"status": "failed"`) {
					t.Fatal("failed run state changed")
				}
				if tc.name == "version_reports_build_capabilities" {
					var build protocol.BuildInfo
					if err := json.Unmarshal(stdout.Bytes(), &build); err != nil {
						t.Fatal(err)
					}
					if build.Version == "" || !build.Supports(protocol.CapabilityPipelineSelectionV1) || build.ReleaseChannel == "" {
						t.Fatalf("incomplete actual CLI report %+v", build)
					}
				}
				return
			}
			var payload map[string]json.RawMessage
			if err = json.Unmarshal(stderr.Bytes(), &payload); err != nil {
				t.Fatalf("stderr is not one JSON object: %v; %.200s", err, stderr.String())
			}
			if string(payload["code"]) != strconv.Quote(tc.code) || len(payload["error"]) == 0 {
				t.Fatalf("missing stable error fields: %.200s", stderr.String())
			}
			var original map[string]json.RawMessage
			if tc.status >= 400 && json.Unmarshal([]byte(tc.body), &original) == nil {
				for key, want := range original {
					var gotJSON, wantJSON bytes.Buffer
					_ = json.Compact(&gotJSON, payload[key])
					_ = json.Compact(&wantJSON, want)
					if !bytes.Equal(gotJSON.Bytes(), wantJSON.Bytes()) {
						t.Fatalf("HTTP field %s was lost or changed", key)
					}
				}
			}
		})
	}
}
