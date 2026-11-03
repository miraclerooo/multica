package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/handler"
	"github.com/multica-ai/multica/server/internal/pipeline"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestPipelineMetadataAuthenticatedHTTP(t *testing.T) {
	f := testutil.New(testPool, testWorkspaceID, testUserID)
	runtime := f.Runtime(t, "Metadata fake runtime")
	leader := f.Agent(t, "PM", runtime)
	squad := f.Squad(t, "Metadata squad", leader)
	f.SquadMember(t, squad, "agent", leader, testutil.Cols{"role": "leader"})
	var chosen string
	for _, name := range []string{"Executor", "Cassia", "Designer"} {
		chosen = f.Agent(t, name, runtime)
		f.SquadMember(t, squad, "agent", chosen)
	}
	for _, table := range []string{"pipeline_definition", "squad_pipeline"} {
		f.Cleanup(t, "DELETE FROM "+table+" WHERE squad_id=$1", squad)
	}
	call := func(method, path, token string, body any, status int, out any) {
		t.Helper()
		data, _ := json.Marshal(body)
		req, e := http.NewRequest(method, testServer.URL+path, bytes.NewReader(data))
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("X-Workspace-ID", testWorkspaceID)
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer resp.Body.Close()
		data, e = io.ReadAll(resp.Body)
		if e != nil {
			t.Fatal(e)
		}
		if resp.StatusCode != status {
			t.Fatalf("%s %s: got %d want %d: %s", method, path, resp.StatusCode, status, data)
		}
		if out != nil {
			if e = json.Unmarshal(data, out); e != nil {
				t.Fatal(e)
			}
		}
	}
	call("GET", "/api/pipelines/candidates?squad_id="+squad, "", nil, 401, nil)
	var candidates struct {
		Current struct {
			ID string `json:"user_id"`
		} `json:"current_user"`
		Agents []map[string]any `json:"agents"`
	}
	call("GET", "/api/pipelines/candidates?squad_id="+squad, testToken, nil, 200, &candidates)
	if candidates.Current.ID != testUserID || len(candidates.Agents) != 4 {
		t.Fatalf("false candidate identity: %+v", candidates)
	}
	source := fmt.Sprintf("# Keep all original text.\nkind: gitlab_yaml\nstages: [work, review]\nstable_work:\n  title: Friendly work\n  stage: work\n  agent_id: %s\n  instructions: |\n    Full instruction.\n    Keep line two.\n  artifacts:\n    files:\n      - name: report.md\n        description: |+\n          First paragraph.\n\n          Second paragraph.\n\nreview:\n  stage: review\n  when: manual\n  owner_user_id: %s\n", chosen, testUserID)
	var catalog struct {
		Pipeline struct {
			ID string `json:"id"`
		} `json:"pipeline"`
		Definition struct {
			ID     string        `json:"id"`
			Source string        `json:"source"`
			Plan   pipeline.Plan `json:"plan"`
		} `json:"definition"`
	}
	call("POST", "/api/pipelines/catalog", testToken, map[string]any{"name": "Metadata catalog", "squad_id": squad, "source": source, "idempotency_key": "http-metadata"}, 201, &catalog)
	if catalog.Definition.Source != source || catalog.Definition.Plan.Nodes[0].AgentID != chosen || catalog.Definition.Plan.Nodes[0].Deliverables[0].Description != "First paragraph.\n\nSecond paragraph.\n\n" {
		t.Fatal("real source/plan round trip lost metadata")
	}
	build := protocol.BuildInfo{Version: "0.7.3-ipoke.test", Commit: strings.Repeat("c", 40), Capabilities: protocol.PipelineClientCapabilities(), ReleaseChannel: "ipoke"}
	call("POST", "/api/daemon/runtimes/"+runtime+"/build-report", testToken, protocol.RuntimeBuildReport{Daemon: build, Disk: &build}, 200, nil)
	f.Exec(t, "UPDATE workspace SET issue_counter=GREATEST(issue_counter,(SELECT COALESCE(MAX(number),0) FROM issue WHERE workspace_id=$1)) WHERE id=$1", testWorkspaceID)
	var issue handler.IssueResponse
	body := map[string]any{"title": "Metadata HTTP issue", "assignee_type": "squad", "assignee_id": squad, "execution": map[string]any{"mode": "pipeline", "pipeline_id": catalog.Pipeline.ID}, "idempotency_key": "http-metadata-issue"}
	call("POST", "/api/issues", testToken, body, 201, &issue)
	for _, table := range []string{"issue", "issue_create_request", "agent_task_queue", "pipeline_run"} {
		field := "issue_id"
		if table == "issue" {
			field = "id"
		}
		f.Cleanup(t, "DELETE FROM "+table+" WHERE "+field+"=$1", issue.ID)
	}
	var again handler.IssueResponse
	call("POST", "/api/issues", testToken, body, 201, &again)
	if again.ID != issue.ID || issue.Execution == nil || issue.Execution.Bindings["stable_work"] != chosen {
		t.Fatal("atomic HTTP selection did not freeze selected member")
	}
	var run struct {
		Items []pipeline.Run `json:"items"`
	}
	call("GET", "/api/pipeline-runs?issue_id="+issue.ID, testToken, nil, 200, &run)
	if len(run.Items) != 1 || run.Items[0].Job("stable_work").Current() == nil {
		t.Fatal("one actual registered job required")
	}
	task := run.Items[0].Job("stable_work").Current().TaskID
	var target string
	if e := testPool.QueryRow(context.Background(), "SELECT agent_id::text FROM agent_task_queue WHERE id=$1", task).Scan(&target); e != nil || target != chosen || target == leader {
		t.Fatalf("fake executor went to wrong member: %s %v", target, e)
	}
	token := mintAgentTaskToken(t, chosen, task, testUserID)
	call("GET", "/api/pipelines/candidates?squad_id="+squad, token, nil, 403, nil)
	call("POST", "/api/pipeline-runs/"+run.Items[0].ID+"/jobs/review/decisions", token, map[string]any{"decision": "approve", "expected_revision": 1, "idempotency_key": "cannot-approve"}, 403, nil)
	t.Log("real authenticated HTTP, four member candidates, stable nonleader target, immutable metadata, one fake task; no agent invocation")
}
