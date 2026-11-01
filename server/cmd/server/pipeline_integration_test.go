package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/pipeline"
	"github.com/multica-ai/multica/server/internal/testutil"
)

func TestPipelineAuthenticatedHTTPResultAndHumanGate(t *testing.T) {
	f := testutil.New(testPool, testWorkspaceID, testUserID)
	runtime := f.Runtime(t, "HTTP fake executor")
	agent := f.Agent(t, "HTTP pipeline agent", runtime)
	squad := f.Squad(t, "HTTP pipeline squad", agent)
	f.SquadMember(t, squad, "agent", agent, testutil.Cols{"role": "custom"})
	issue := f.Issue(t, "HTTP pipeline issue", testutil.Cols{"assignee_type": "squad", "assignee_id": squad})
	f.Cleanup(t, "DELETE FROM pipeline_definition WHERE squad_id=$1", squad)
	f.Cleanup(t, "DELETE FROM pipeline_run WHERE issue_id=$1", issue)
	f.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", issue)
	f.Cleanup(t, "DELETE FROM comment WHERE issue_id=$1", issue)
	call := func(method, path, token string, body any, want int, out any) {
		t.Helper()
		var data []byte
		if body != nil {
			data, _ = json.Marshal(body)
		}
		req, err := http.NewRequest(method, testServer.URL+path, bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-Workspace-ID", testWorkspaceID)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, _ = io.ReadAll(resp.Body)
		if resp.StatusCode != want {
			t.Fatalf("%s %s got %d, want %d: %s", method, path, resp.StatusCode, want, data)
		}
		if out != nil {
			if err = json.Unmarshal(data, out); err != nil {
				t.Fatal(err)
			}
		}
	}
	source := "kind: hermes_yaml\nroles: {custom: {}}\ngates: {check: {type: manual}}\nstates:\n  gather: {by: custom, entry: Preserve this original instruction., gate: check}\n"
	var definition map[string]any
	call("POST", "/api/squads/"+squad+"/pipeline-versions", testToken, map[string]any{"source": source, "idempotency_key": "http-definition", "activate": true, "expected_revision": 1}, 201, &definition)
	if definition["kind"] != "hermes_yaml" || definition["source"] != source {
		t.Fatal("source was converted")
	}
	var run pipeline.Run
	call("POST", "/api/pipeline-runs", testToken, map[string]any{"issue_id": issue, "squad_id": squad, "idempotency_key": "http-run"}, 201, &run)
	task := run.Job("gather").Current().TaskID
	f.Exec(t, "UPDATE agent_task_queue SET status='running',started_at=now() WHERE id=$1", task)
	token := mintAgentTaskToken(t, agent, task, testUserID)
	base := "/api/pipeline-runs/" + run.ID
	call("POST", base+"/jobs/gather/report", token, map[string]any{"attempt": 1, "result": "succeeded", "report": "fake executor report", "artifacts": []any{}, "idempotency_key": "http-report"}, 200, nil)
	call("POST", base+"/jobs/gather.gate.check/decisions", token, map[string]any{"decision": "approve", "expected_revision": 1, "idempotency_key": "agent-cannot-approve"}, 403, nil)
	call("POST", "/api/daemon/tasks/"+task+"/complete", testToken, map[string]any{"output": "fake executor completed"}, 200, nil)
	call("GET", base, testToken, nil, 200, &run)
	gate := run.Job("gather.gate.check")
	if gate.Status != "waiting_approval" {
		t.Fatalf("gate not ready: %+v", run)
	}
	call("POST", base+"/jobs/"+gate.Node.ID+"/decisions", testToken, map[string]any{"decision": "approve", "expected_revision": gate.Revision, "idempotency_key": "human-approve"}, 200, &run)
	if run.Status != "succeeded" || run.Job(gate.Node.ID).Decision.ActorID != testUserID {
		t.Fatalf("human decision missing: %+v", run)
	}
}
