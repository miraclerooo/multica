package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/handler"
	"github.com/multica-ai/multica/server/internal/pipeline"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestPipelineSelectionAuthenticatedHTTPWaitingAndResume(t *testing.T) {
	f := testutil.New(testPool, testWorkspaceID, testUserID)
	runtime := f.Runtime(t, "Selection HTTP fake runtime")
	agent := f.Agent(t, "Selection HTTP fake executor", runtime)
	squad := f.Squad(t, "Selection HTTP squad", agent)
	f.SquadMember(t, squad, "agent", agent, testutil.Cols{"role": "custom"})
	for _, table := range []string{"squad_pipeline", "pipeline_definition"} {
		f.Cleanup(t, "DELETE FROM "+table+" WHERE squad_id=$1", squad)
	}
	call := func(method, path, token string, body any, want int, out any) {
		t.Helper()
		data, _ := json.Marshal(body)
		req, err := http.NewRequest(method, testServer.URL+path, bytes.NewReader(data))
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
		data, err = io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != want {
			t.Fatalf("%s %s: got %d want %d: %s", method, path, resp.StatusCode, want, data)
		}
		if out != nil {
			if err = json.Unmarshal(data, out); err != nil {
				t.Fatal(err)
			}
		}
	}
	call("GET", "/api/pipelines/catalog?squad_id="+squad, "", nil, 401, nil)
	source := "kind: hermes_yaml\nroles: {custom: {}}\ngates: {review: {type: manual}}\nstates:\n  gather: {by: custom, entry: Keep my exact instruction., gate: review}\n"
	var created struct {
		Pipeline struct {
			ID string `json:"id"`
		} `json:"pipeline"`
		Definition struct {
			ID     string `json:"id"`
			Source string `json:"source"`
		} `json:"definition"`
	}
	call("POST", "/api/pipelines/catalog", testToken, map[string]any{"name": "HTTP named pipeline", "squad_id": squad, "source": source, "idempotency_key": "http-catalog"}, 201, &created)
	if created.Definition.Source != source {
		t.Fatal("original dialect changed")
	}
	call("POST", "/api/issues", testToken, map[string]any{"title": "Reject misspelled version", "assignee_type": "squad", "assignee_id": squad, "execution": map[string]any{"mode": "pipeline", "pipeline_id": created.Pipeline.ID, "pipeline_definition_id": created.Definition.ID}}, 400, nil)
	old := protocol.RuntimeBuildReport{Daemon: protocol.BuildInfo{Version: "0.7.2-ipoke.3de828da5", Capabilities: []string{}, ReleaseChannel: "ipoke"}, DiskReason: "disk_probe_unavailable"}
	call("POST", "/api/daemon/runtimes/"+runtime+"/build-report", testToken, old, 200, nil)
	f.Exec(t, "UPDATE workspace SET issue_counter=GREATEST(issue_counter,(SELECT COALESCE(MAX(number),0) FROM issue WHERE workspace_id=$1)) WHERE id=$1", testWorkspaceID)
	body := map[string]any{"title": "HTTP frozen selection", "assignee_type": "squad", "assignee_id": squad, "execution": map[string]any{"mode": "pipeline", "pipeline_id": created.Pipeline.ID, "definition_id": created.Definition.ID}, "idempotency_key": "http-selected-issue"}
	var issue handler.IssueResponse
	call("POST", "/api/issues", testToken, body, 201, &issue)
	for _, table := range []string{"issue", "issue_create_request", "pipeline_run", "agent_task_queue", "comment"} {
		field := "issue_id"
		if table == "issue" {
			field = "id"
		}
		f.Cleanup(t, "DELETE FROM "+table+" WHERE "+field+"=$1", issue.ID)
	}
	if issue.Execution == nil || issue.Execution.State != "waiting_runtime" || issue.Execution.DefinitionID != created.Definition.ID || issue.Execution.Readiness.Runtimes[0].Disk != nil {
		t.Fatalf("false execution result: %+v", issue.Execution)
	}
	var replay handler.IssueResponse
	call("POST", "/api/issues", testToken, body, 201, &replay)
	if replay.ID != issue.ID || f.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue.ID) != 0 {
		t.Fatal("waiting/replay created work")
	}
	var waiting map[string]any
	call("POST", "/api/issues/"+issue.ID+"/execution/start", testToken, map[string]any{}, 409, &waiting)
	if waiting["code"] != "runtime_not_ready" {
		t.Fatal("unstable runtime error")
	}
	ready := old
	ready.Daemon.Version = "dev-v1.5-http-fixture"
	ready.Daemon.Capabilities = protocol.PipelineClientCapabilities()
	ready.Disk = &ready.Daemon
	ready.DiskReason = ""
	call("POST", "/api/daemon/runtimes/"+runtime+"/build-report", testToken, ready, 200, nil)
	var started struct {
		Run pipeline.Run `json:"run"`
	}
	path := "/api/issues/" + issue.ID + "/execution/start"
	call("POST", path, testToken, map[string]any{}, 200, &started)
	first := started.Run.ID
	call("POST", path, testToken, map[string]any{}, 200, &started)
	if first != started.Run.ID || started.Run.DefinitionID != created.Definition.ID || f.Count(t, "SELECT count(*) FROM pipeline_run WHERE issue_id=$1", issue.ID) != 1 || f.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue.ID) != 1 {
		t.Fatal("resume changed version or duplicated work")
	}
	task := started.Run.Job("gather").Current().TaskID
	token := mintAgentTaskToken(t, agent, task, testUserID)
	call("POST", path, token, map[string]any{}, 403, nil)
	t.Logf("authenticated HTTP: issue=%s pipeline=%s definition=%s run=%s; exactly one fake task; initial disk unknown, then observed CLI capability", issue.ID, created.Pipeline.ID, created.Definition.ID, first)
}
