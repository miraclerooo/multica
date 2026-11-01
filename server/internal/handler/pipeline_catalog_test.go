package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/pipeline"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type catalogResult struct {
	Pipeline struct {
		ID         string  `json:"id"`
		Name       string  `json:"name"`
		Revision   int64   `json:"revision"`
		Executable *string `json:"executable_definition_id"`
	} `json:"pipeline"`
	Definition struct {
		ID         string `json:"id"`
		PipelineID string `json:"pipeline_id"`
		Revision   int64  `json:"revision"`
		Source     string `json:"source"`
		Kind       string `json:"kind"`
	} `json:"definition"`
}

func catalogFixture(t *testing.T) *pipelineFixture {
	t.Helper()
	f := newPipelineFixture(t, pipelineTestGitlab)
	f.h.IssueService = service.NewIssueService(f.h.Queries, f.h.TxStarter, f.h.Bus, nil, f.h.TaskService)
	dbfx.Exec(t, "UPDATE workspace SET issue_counter=GREATEST(issue_counter,(SELECT COALESCE(MAX(number),0) FROM issue WHERE workspace_id=$1)) WHERE id=$1", testWorkspaceID)
	build := protocol.BuildInfo{Version: "0.7.2-ipoke.test-new", Commit: strings.Repeat("b", 40), Capabilities: protocol.PipelineClientCapabilities(), ReleaseChannel: "ipoke", UpgradeGuideURL: "https://deployment.example.test/upgrade"}
	setPipelineBuild(t, f, protocol.RuntimeBuildReport{Daemon: build, Disk: &build})
	return f
}
func setPipelineBuild(t *testing.T, f *pipelineFixture, report protocol.RuntimeBuildReport) {
	t.Helper()
	data, _ := json.Marshal(map[string]any{"build_report": report, "build_report_at": time.Now().UTC().Format(time.RFC3339Nano)})
	dbfx.Exec(t, "UPDATE agent_runtime SET metadata=$2,status='online',last_seen_at=now() WHERE id=(SELECT runtime_id FROM agent WHERE id=$1)", f.agent, data)
}
func createCatalog(t *testing.T, f *pipelineFixture, name, key, source string) catalogResult {
	t.Helper()
	var out catalogResult
	testutil.Call(t, f.h.CreatePipelineCatalog, newRequest("POST", "/api/pipelines/catalog", map[string]any{"squad_id": f.squad, "name": name, "source": source, "idempotency_key": key})).Want(201).JSON(&out)
	return out
}
func createSelectedIssue(t *testing.T, f *pipelineFixture, title string, selection any, key string) IssueResponse {
	t.Helper()
	body := map[string]any{"title": t.Name() + title, "assignee_type": "squad", "assignee_id": f.squad, "idempotency_key": key}
	if selection != nil {
		body["execution"] = selection
	}
	var out IssueResponse
	testutil.Call(t, f.h.CreateIssue, newRequest("POST", "/api/issues", body)).Want(201).JSON(&out)
	cleanupExecutionIssue(t, out.ID)
	return out
}
func cleanupExecutionIssue(t *testing.T, id string) {
	t.Helper()
	for _, table := range []string{"issue", "issue_create_request", "pipeline_run", "agent_task_queue", "comment"} {
		field := "issue_id"
		if table == "issue" {
			field = "id"
		}
		dbfx.Cleanup(t, "DELETE FROM "+table+" WHERE "+field+"=$1", id)
	}
}
func executionRequest(method, id string) *http.Request {
	return testutil.WithURLParams(newRequest(method, "/api/issues/"+id+"/execution", nil), "id", id)
}

func TestPipelineCatalogIndependentHistoriesAndDefaults(t *testing.T) {
	f := catalogFixture(t)
	a := createCatalog(t, f, "Research", "catalog-a", pipelineTestGitlab)
	b := createCatalog(t, f, "Publish", "catalog-b", pipelineTestHermes)
	if a.Pipeline.ID == b.Pipeline.ID || a.Definition.Revision != 1 || b.Definition.Revision != 1 || a.Definition.Kind == b.Definition.Kind {
		t.Fatalf("histories not independent: %+v %+v", a, b)
	}
	a2source := strings.Replace(pipelineTestGitlab, "Write the notes.", "Keep this exact new instruction.", 1)
	body := map[string]any{"squad_id": f.squad, "pipeline_id": a.Pipeline.ID, "source": a2source, "idempotency_key": "a-v2", "expected_pipeline_revision": a.Pipeline.Revision}
	var a2 map[string]any
	testutil.Call(t, f.h.CreatePipelineDefinition, newRequest("POST", "/api/pipelines/definitions", body)).Want(201).JSON(&a2)
	if a2["pipeline_id"] != a.Pipeline.ID || a2["revision"] != float64(2) || a2["source"] != a2source {
		t.Fatalf("wrong version: %+v", a2)
	}
	testutil.Call(t, f.h.CreatePipelineDefinition, newRequest("POST", "/api/pipelines/definitions", body)).Want(201)
	body["idempotency_key"] = "stale-a"
	testutil.Call(t, f.h.CreatePipelineDefinition, newRequest("POST", "/api/pipelines/definitions", body)).Want(409)
	var versions struct {
		Items []map[string]any `json:"items"`
	}
	testutil.Call(t, f.h.ListPipelineDefinitions, newRequest("GET", "/api/pipelines/definitions?squad_id="+f.squad+"&pipeline_id="+b.Pipeline.ID, nil)).Want(200).JSON(&versions)
	if len(versions.Items) != 1 || versions.Items[0]["source"] != pipelineTestHermes || versions.Items[0]["revision"] != float64(1) {
		t.Fatal("updating A changed B")
	}
	request := testutil.WithURLParams(newRequest("PATCH", "/api/pipelines/catalog/"+b.Pipeline.ID, map[string]any{"name": "Renamed publish", "expected_revision": b.Pipeline.Revision}), "pipelineId", b.Pipeline.ID)
	testutil.Call(t, f.h.RenamePipelineCatalog, request).Want(200)
	// Replaying creation after a rename returns its original identity without
	// replacing the human's new name or allocating another version.
	replay := createCatalog(t, f, "Publish", "catalog-b", pipelineTestHermes)
	if replay.Pipeline.ID != b.Pipeline.ID || replay.Pipeline.Name != "Renamed publish" || replay.Definition.ID != b.Definition.ID {
		t.Fatal("creation replay overwrote a rename")
	}
	var squad SquadResponse
	testutil.Call(t, f.h.GetSquad, testutil.WithURLParams(newRequest("GET", "/api/squads/"+f.squad, nil), "id", f.squad, "workspaceId", testWorkspaceID)).Want(200).JSON(&squad)
	testutil.Call(t, f.h.UpdateSquad, testutil.WithURLParams(newRequest("PUT", "/api/squads/"+f.squad, map[string]any{"pipeline_id": b.Pipeline.ID, "expected_revision": squad.Revision}), "id", f.squad, "workspaceId", testWorkspaceID)).Want(200).JSON(&squad)
	if squad.PipelineDefinitionID == nil || *squad.PipelineDefinitionID != b.Definition.ID {
		t.Fatal("logical default not resolved atomically")
	}
	// An old caller still appends to the one legacy history, preserving the
	// original definition IDs and independent named version sequences.
	var legacy map[string]any
	testutil.Call(t, f.h.CreatePipelineDefinition, newRequest("POST", "/api/pipelines/definitions", map[string]any{"squad_id": f.squad, "source": pipelineTestGitlab, "idempotency_key": "legacy-v2"})).Want(201).JSON(&legacy)
	if legacy["revision"] != float64(2) || legacy["pipeline_id"] == a.Pipeline.ID || legacy["pipeline_id"] == b.Pipeline.ID {
		t.Fatalf("legacy history split: %+v", legacy)
	}
}

func TestIssueExecutionAtomicSelectionAndOmittedCompatibility(t *testing.T) {
	f := catalogFixture(t)
	a := createCatalog(t, f, "Explicit research", "selected-a", pipelineTestHermes)
	cases := []struct {
		name             string
		selection        any
		mode, definition string
	}{
		{"omitted", nil, "pipeline", f.definition},
		{"default", map[string]any{"mode": "default"}, "pipeline", f.definition},
		{"markdown", map[string]any{"mode": "markdown"}, "markdown", ""},
		{"specific", map[string]any{"mode": "pipeline", "pipeline_id": a.Pipeline.ID}, "pipeline", a.Definition.ID},
		{"uppercase ID", map[string]any{"mode": "pipeline", "pipeline_id": strings.ToUpper(a.Pipeline.ID), "definition_id": strings.ToUpper(a.Definition.ID)}, "pipeline", a.Definition.ID},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			issue := createSelectedIssue(t, f, tt.name, tt.selection, "create-"+tt.name)
			if issue.Execution == nil || issue.Execution.Mode != tt.mode || issue.Execution.DefinitionID != tt.definition {
				t.Fatalf("selection not saved: %+v", issue.Execution)
			}
			runs := dbfx.Count(t, "SELECT count(*) FROM pipeline_run WHERE issue_id=$1", issue.ID)
			tasks := dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue.ID)
			legacy := dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1 AND pipeline_run_id IS NULL", issue.ID)
			if tasks != 1 || (tt.mode == "pipeline" && (runs != 1 || legacy != 0)) || (tt.mode == "markdown" && (runs != 0 || legacy != 1)) {
				t.Fatalf("wrong or duplicate path: runs=%d tasks=%d leaders=%d", runs, tasks, legacy)
			}
			if tt.mode == "pipeline" && issue.Execution.State != "started" {
				t.Fatal("start was not acknowledged")
			}
		})
	}
	var defaultID string
	dbfx.QueryRow(t, "SELECT pipeline_definition_id FROM squad WHERE id=$1", f.squad).Scan(&defaultID)
	if defaultID != f.definition {
		t.Fatal("one issue changed squad default")
	}
	dbfx.Exec(t, "UPDATE squad SET instructions_mode='markdown',pipeline_definition_id=NULL WHERE id=$1", f.squad)
	explicit := createSelectedIssue(t, f, "explicit from guidance", map[string]any{"mode": "pipeline", "pipeline_id": a.Pipeline.ID, "definition_id": a.Definition.ID}, "explicit-guidance")
	if explicit.Execution.DefinitionID != a.Definition.ID || dbfx.Count(t, "SELECT count(*) FROM pipeline_run WHERE issue_id=$1", explicit.ID) != 1 {
		t.Fatal("guidance squad could not select a pipeline")
	}
	omitted := createSelectedIssue(t, f, "old guidance", nil, "old-guidance")
	if omitted.Execution.Mode != "markdown" || dbfx.Count(t, "SELECT count(*) FROM pipeline_run WHERE issue_id=$1", omitted.ID) != 0 {
		t.Fatal("omitted legacy guidance changed")
	}
}

func TestIssueExecutionWaitingRuntimeFrozenResumeAndConcurrentReplay(t *testing.T) {
	f := catalogFixture(t)
	a := createCatalog(t, f, "Frozen", "frozen", pipelineTestHermes)
	old := protocol.BuildInfo{Version: "0.7.2-ipoke.3de828da5", Capabilities: []string{"local-worktree-v1"}, ReleaseChannel: "ipoke"}
	upgraded := protocol.BuildInfo{Version: "0.7.2-ipoke.test-new", Commit: strings.Repeat("b", 40), Capabilities: protocol.PipelineClientCapabilities(), ReleaseChannel: "ipoke"}
	setPipelineBuild(t, f, protocol.RuntimeBuildReport{Daemon: old, Disk: &upgraded, ReloadPendingReason: "task still running; wait for idle"})
	issue := createSelectedIssue(t, f, "wait", map[string]any{"mode": "pipeline", "pipeline_id": a.Pipeline.ID}, "waiting-create")
	if issue.Execution.State != "waiting_runtime" || issue.Execution.Readiness.Runtimes[0].Status != "daemon_pending" {
		t.Fatalf("false readiness: %+v", issue.Execution)
	}
	if dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue.ID) != 0 || dbfx.Count(t, "SELECT count(*) FROM pipeline_run WHERE issue_id=$1", issue.ID) != 0 {
		t.Fatal("waiting task dispatched")
	}
	testutil.Call(t, f.h.StartIssueExecution, executionRequest("POST", issue.ID)).Want(409)
	testutil.Call(t, f.h.CreatePipelineRun, newRequest("POST", "/api/pipeline-runs", map[string]any{"issue_id": issue.ID, "squad_id": f.squad, "definition_id": f.definition, "idempotency_key": "cannot-replace-pending-choice"})).Want(409)
	testutil.Call(t, f.h.CreatePipelineDefinition, newRequest("POST", "/api/pipelines/definitions", map[string]any{"squad_id": f.squad, "pipeline_id": a.Pipeline.ID, "source": strings.Replace(pipelineTestHermes, "Write the notes.", "New draft instruction.", 1), "idempotency_key": "frozen-v2"})).Want(201)
	dbfx.Exec(t, "UPDATE squad SET instructions_mode='markdown',pipeline_definition_id=NULL,instructions='Changed guidance' WHERE id=$1", f.squad)
	setPipelineBuild(t, f, protocol.RuntimeBuildReport{Daemon: upgraded, Disk: &upgraded})
	var view struct {
		Execution *service.IssueExecution `json:"execution"`
	}
	testutil.Call(t, f.h.GetIssueExecution, executionRequest("GET", issue.ID)).Want(200).JSON(&view)
	if view.Execution.State != "ready" || view.Execution.DefinitionID != a.Definition.ID {
		t.Fatal("recheck changed frozen version")
	}
	const count = 6
	results := make(chan *httptest.ResponseRecorder, count)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rr := httptest.NewRecorder()
			f.h.StartIssueExecution(rr, executionRequest("POST", issue.ID))
			results <- rr
		}()
	}
	wg.Wait()
	close(results)
	runID := ""
	for rr := range results {
		if rr.Code != 200 {
			t.Fatalf("resume %d: %s", rr.Code, rr.Body)
		}
		var out struct {
			Run pipeline.Run `json:"run"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		if runID == "" {
			runID = out.Run.ID
		}
		if out.Run.ID != runID || out.Run.DefinitionID != a.Definition.ID || out.Run.Policy == "Changed guidance" {
			t.Fatal("resume duplicated or changed frozen context")
		}
	}
	if dbfx.Count(t, "SELECT count(*) FROM pipeline_run WHERE issue_id=$1", issue.ID) != 1 || dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue.ID) != 1 {
		t.Fatal("resume duplicated actual work")
	}
}

func TestIssueExecutionConcurrentCreateAndInvalidSelectionZeroDispatch(t *testing.T) {
	f := catalogFixture(t)
	a := createCatalog(t, f, "One", "one", pipelineTestGitlab)
	body := map[string]any{"title": t.Name(), "assignee_type": "squad", "assignee_id": f.squad, "execution": map[string]any{"mode": "pipeline", "pipeline_id": a.Pipeline.ID}, "idempotency_key": "same-create"}
	const count = 5
	responses := make(chan *httptest.ResponseRecorder, count)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rr := httptest.NewRecorder()
			f.h.CreateIssue(rr, newRequest("POST", "/api/issues", body))
			responses <- rr
		}()
	}
	wg.Wait()
	close(responses)
	id := ""
	for rr := range responses {
		if rr.Code != 201 {
			t.Fatalf("concurrent create %d: %s", rr.Code, rr.Body)
		}
		var issue IssueResponse
		if err := json.Unmarshal(rr.Body.Bytes(), &issue); err != nil {
			t.Fatal(err)
		}
		if id == "" {
			id = issue.ID
			cleanupExecutionIssue(t, id)
		}
		if issue.ID != id {
			t.Fatal("idempotent create produced two issues")
		}
	}
	if dbfx.Count(t, "SELECT count(*) FROM pipeline_run WHERE issue_id=$1", id) != 1 || dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", id) != 1 {
		t.Fatal("duplicate dispatch")
	}
	body["title"] = "different request"
	testutil.Call(t, f.h.CreateIssue, newRequest("POST", "/api/issues", body)).Want(409)
	other := *f
	other.squad = dbfx.Squad(t, "Other squad", f.agent)
	dbfx.SquadMember(t, other.squad, "agent", f.agent, testutil.Cols{"role": "资料研究"})
	dbfx.Cleanup(t, "DELETE FROM squad_pipeline WHERE squad_id=$1", other.squad)
	dbfx.Cleanup(t, "DELETE FROM pipeline_definition WHERE squad_id=$1", other.squad)
	foreign := createCatalog(t, &other, "Other", "other", pipelineTestGitlab)
	foreignWS := dbfx.Insert(t, "workspace", testutil.Cols{"name": "Foreign catalog", "slug": fmt.Sprintf("foreign-cat-%d", time.Now().UnixNano()), "issue_prefix": "FOR"})
	foreignAgent := dbfx.Agent(t, "Foreign executor", "", testutil.Cols{"workspace_id": foreignWS})
	foreignSquad := dbfx.Squad(t, "Foreign squad", foreignAgent, testutil.Cols{"workspace_id": foreignWS})
	foreignCatalog := dbfx.Insert(t, "squad_pipeline", testutil.Cols{"id": uuidToString(dbid.NewV7()), "workspace_id": foreignWS, "squad_id": foreignSquad, "name": "Foreign pipeline", "creator_id": testUserID, "idempotency_key": "foreign"})
	tests := []struct {
		name      string
		selection any
		status    int
	}{
		{"cross squad", map[string]any{"mode": "pipeline", "pipeline_id": foreign.Pipeline.ID}, 404},
		{"cross workspace", map[string]any{"mode": "pipeline", "pipeline_id": foreignCatalog}, 404},
		{"cross definition", map[string]any{"mode": "pipeline", "pipeline_id": a.Pipeline.ID, "definition_id": foreign.Definition.ID}, 404},
		{"stale id", map[string]any{"mode": "pipeline", "pipeline_id": uuidToString(dbid.NewV7())}, 404},
		{"invalid mode", map[string]any{"mode": "other"}, 422},
		{"unknown version field", map[string]any{"mode": "pipeline", "pipeline_id": a.Pipeline.ID, "pipeline_definition_id": a.Definition.ID}, 400},
		{"mismatched guidance", map[string]any{"mode": "markdown", "pipeline_id": a.Pipeline.ID}, 422},
	}
	before := dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", testWorkspaceID)
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			testutil.Call(t, f.h.CreateIssue, newRequest("POST", "/api/issues", map[string]any{"title": t.Name(), "assignee_type": "squad", "assignee_id": f.squad, "execution": tt.selection})).Want(tt.status)
		})
	}
	if after := dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", testWorkspaceID); after != before {
		t.Fatal("invalid selection created an issue")
	}
	canInvoke := f.h.Pipelines.CanInvoke
	f.h.Pipelines.CanInvoke = func(context.Context, db.Agent, string, string) bool { return false }
	testutil.Call(t, f.h.CreateIssue, newRequest("POST", "/api/issues", map[string]any{"title": "forbidden selection", "assignee_type": "squad", "assignee_id": f.squad, "execution": map[string]any{"mode": "pipeline", "pipeline_id": a.Pipeline.ID}})).Want(403)
	f.h.Pipelines.CanInvoke = canInvoke
	if after := dbfx.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1", testWorkspaceID); after != before {
		t.Fatal("forbidden selection created an issue")
	}
	// No executable version is distinct from runtime compatibility unknown.
	dbfx.Exec(t, "UPDATE squad_pipeline SET executable_definition_id=NULL WHERE id=$1", a.Pipeline.ID)
	testutil.Call(t, f.h.CreateIssue, newRequest("POST", "/api/issues", map[string]any{"title": "non executable", "assignee_type": "squad", "assignee_id": f.squad, "execution": map[string]any{"mode": "pipeline", "pipeline_id": a.Pipeline.ID}})).Want(409)
}

func TestPipelinePreflightActualTargetsAndCompatibility(t *testing.T) {
	f := catalogFixture(t)
	unused := dbfx.Runtime(t, "Unrelated offline runtime", testutil.Cols{"status": "offline"})
	_ = dbfx.Agent(t, "Unselected executor", unused)
	newBuild := protocol.BuildInfo{Version: "0.7.2-ipoke.next", Capabilities: protocol.PipelineClientCapabilities(), ReleaseChannel: "ipoke", UpgradeGuideURL: "https://deployment.example.test/upgrade"}
	for _, tt := range []struct {
		name         string
		report       protocol.RuntimeBuildReport
		want, action string
	}{
		{"supported", protocol.RuntimeBuildReport{Daemon: newBuild, Disk: &newBuild}, "supported", "deployment_guide"},
		{"disk unknown", protocol.RuntimeBuildReport{Daemon: newBuild}, "unknown", "deployment_guide"},
		{"disk insufficient", protocol.RuntimeBuildReport{Daemon: newBuild, Disk: &protocol.BuildInfo{Version: "0.7.2-ipoke.3de828da5", Capabilities: []string{}}}, "insufficient", "deployment_guide"},
		{"insufficient", protocol.RuntimeBuildReport{Daemon: protocol.BuildInfo{Version: "0.7.2-ipoke.3de828da5", Capabilities: []string{}, ReleaseChannel: "ipoke"}}, "insufficient", "channel_not_configured"},
		{"unknown", protocol.RuntimeBuildReport{Daemon: protocol.BuildInfo{Version: "unknown", ReleaseChannel: "unknown"}}, "unknown", "channel_not_configured"},
		{"pending", protocol.RuntimeBuildReport{Daemon: protocol.BuildInfo{Version: "0.7.2-ipoke.3de828da5", Capabilities: []string{}}, Disk: &newBuild}, "daemon_pending", "wait_idle_and_recheck"},
		{"official", protocol.RuntimeBuildReport{Daemon: protocol.BuildInfo{Version: "0.7.2", Capabilities: []string{}, ReleaseChannel: "official"}}, "insufficient", "official_update"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			setPipelineBuild(t, f, tt.report)
			var out service.IssueExecution
			testutil.Call(t, f.h.PreflightPipelineExecution, newRequest("POST", "/api/pipelines/preflight", map[string]any{"squad_id": f.squad, "execution": map[string]any{"mode": "default"}})).Want(200).JSON(&out)
			if len(out.Readiness.Runtimes) != 1 || out.Readiness.Runtimes[0].Status != tt.want || out.Readiness.Runtimes[0].UpgradeAction != tt.action || out.Readiness.Ready != (tt.want == "supported") {
				t.Fatalf("bad compatibility %+v", out.Readiness)
			}
			if tt.report.Disk == nil && out.Readiness.Runtimes[0].Disk != nil {
				t.Fatal("copied daemon version into disk")
			}
		})
	}
	if dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", f.issue) != 0 {
		t.Fatal("preflight dispatched work")
	}
	setPipelineBuild(t, f, protocol.RuntimeBuildReport{Daemon: newBuild, Disk: &newBuild})
	staleAt, _ := json.Marshal(time.Now().Add(-5 * time.Minute).UTC().Format(time.RFC3339Nano))
	dbfx.Exec(t, "UPDATE agent_runtime SET metadata=jsonb_set(metadata,'{build_report_at}',$2::jsonb) WHERE id=(SELECT runtime_id FROM agent WHERE id=$1)", f.agent, staleAt)
	var stale service.IssueExecution
	testutil.Call(t, f.h.PreflightPipelineExecution, newRequest("POST", "/api/pipelines/preflight", map[string]any{"squad_id": f.squad})).Want(200).JSON(&stale)
	if stale.Readiness.Ready || stale.Readiness.Runtimes[0].Reason != "build_report_stale" {
		t.Fatal("stale report declared support")
	}
	setPipelineBuild(t, f, protocol.RuntimeBuildReport{Daemon: newBuild, Disk: &newBuild})
	dbfx.Exec(t, "UPDATE agent_runtime SET status='offline' WHERE id=(SELECT runtime_id FROM agent WHERE id=$1)", f.agent)
	testutil.Call(t, f.h.PreflightPipelineExecution, newRequest("POST", "/api/pipelines/preflight", map[string]any{"squad_id": f.squad})).Want(200).JSON(&stale)
	if stale.Readiness.Ready || stale.Readiness.Runtimes[0].Reason != "runtime_offline" || stale.Readiness.Runtimes[0].UpgradeAction != "wait_online_and_recheck" {
		t.Fatal("selected offline runtime was not distinguished from upgrade")
	}
}

func TestIssueExecutionResumeRechecksInvocationPermission(t *testing.T) {
	f := catalogFixture(t)
	setPipelineBuild(t, f, protocol.RuntimeBuildReport{Daemon: protocol.BuildInfo{Version: "old", Capabilities: []string{}}})
	issue := createSelectedIssue(t, f, "permission wait", nil, "permission-wait")
	owner := dbfx.User(t, "Other executor owner", fmt.Sprintf("catalog-permission-%d@example.test", time.Now().UnixNano()))
	dbfx.Cleanup(t, "UPDATE agent SET owner_id=$2 WHERE id=$1", f.agent, testUserID)
	dbfx.Exec(t, "UPDATE agent SET permission_mode='private',owner_id=$2 WHERE id=$1", f.agent, owner)
	readyBuild := protocol.BuildInfo{Version: "new", Capabilities: protocol.PipelineClientCapabilities()}
	setPipelineBuild(t, f, protocol.RuntimeBuildReport{Daemon: readyBuild, Disk: &readyBuild})
	testutil.Call(t, f.h.StartIssueExecution, executionRequest("POST", issue.ID)).Want(403)
	if dbfx.Count(t, "SELECT count(*) FROM pipeline_run WHERE issue_id=$1", issue.ID) != 0 {
		t.Fatal("revoked invocation dispatched work")
	}
}

func TestPipelineCatalogDefaultRejectsUnexecutableAndReadOnlyWrites(t *testing.T) {
	f := catalogFixture(t)
	draft := createCatalog(t, f, "Unbound draft", "unbound-draft", strings.ReplaceAll(pipelineTestGitlab, "资料研究", "missing-role"))
	if draft.Pipeline.Executable != nil {
		t.Fatal("unbound draft declared executable")
	}
	var squad SquadResponse
	testutil.Call(t, f.h.GetSquad, testutil.WithURLParams(newRequest("GET", "/api/squads/"+f.squad, nil), "id", f.squad, "workspaceId", testWorkspaceID)).Want(200).JSON(&squad)
	update := func(body any) *http.Request {
		return testutil.WithURLParams(newRequest("PUT", "/api/squads/"+f.squad, body), "id", f.squad, "workspaceId", testWorkspaceID)
	}
	testutil.Call(t, f.h.UpdateSquad, update(map[string]any{"pipeline_id": draft.Pipeline.ID, "expected_revision": squad.Revision, "name": "Must roll back"})).Want(409)
	testutil.Call(t, f.h.UpdateSquad, update(map[string]any{"pipeline_id": draft.Pipeline.ID, "instructions_mode": "markdown", "expected_revision": squad.Revision})).Want(422)
	var after SquadResponse
	testutil.Call(t, f.h.GetSquad, testutil.WithURLParams(newRequest("GET", "/api/squads/"+f.squad, nil), "id", f.squad, "workspaceId", testWorkspaceID)).Want(200).JSON(&after)
	if after.Revision != squad.Revision || after.Name != squad.Name || after.PipelineDefinitionID == nil || *after.PipelineDefinitionID != f.definition {
		t.Fatal("failed switch partially changed squad default")
	}
	reader := dbfx.User(t, "Catalog reader", fmt.Sprintf("catalog-reader-%d@example.test", time.Now().UnixNano()))
	dbfx.Member(t, testWorkspaceID, reader, "member")
	testutil.Call(t, f.h.RenamePipelineCatalog, testutil.WithURLParams(newRequestAs(reader, "PATCH", "/api/pipelines/catalog/"+draft.Pipeline.ID, map[string]any{"name": "Forbidden rename", "expected_revision": draft.Pipeline.Revision}), "pipelineId", draft.Pipeline.ID)).Want(403)
	testutil.Call(t, f.h.CreatePipelineCatalog, newRequestAs(reader, "POST", "/api/pipelines/catalog", map[string]any{"name": "Forbidden pipeline", "squad_id": f.squad, "source": pipelineTestGitlab, "idempotency_key": "forbidden"})).Want(403)
}

func TestIssueExecutionCreateReplayKeepsAuthoritativeLabels(t *testing.T) {
	f := catalogFixture(t)
	label := dbfx.Insert(t, "issue_label", testutil.Cols{"workspace_id": testWorkspaceID, "resource_type": "issue", "name": "Atomic selection label", "color": "#123456"})
	body := map[string]any{"title": t.Name(), "status": "backlog", "assignee_type": "squad", "assignee_id": f.squad, "execution": map[string]any{"mode": "markdown"}, "label_ids": []string{label}, "idempotency_key": "labeled-create"}
	var first, replay IssueResponse
	testutil.Call(t, f.h.CreateIssue, newRequest("POST", "/api/issues", body)).Want(201).JSON(&first)
	cleanupExecutionIssue(t, first.ID)
	testutil.Call(t, f.h.CreateIssue, newRequest("POST", "/api/issues", body)).Want(201).JSON(&replay)
	if first.ID != replay.ID || first.Labels == nil || replay.Labels == nil || len(*replay.Labels) != 1 || (*replay.Labels)[0].ID != label {
		t.Fatal("idempotent replay lost labels")
	}
	body["label_ids"] = []string{}
	testutil.Call(t, f.h.CreateIssue, newRequest("POST", "/api/issues", body)).Want(409)
	if dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", first.ID) != 0 {
		t.Fatal("parked issue replay dispatched work")
	}
}

func TestPipelineCatalogLegacyMigrationKeepsReferences(t *testing.T) {
	ctx := context.Background()
	tx, err := testPool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	schema := fmt.Sprintf("catalog_migration_%d", time.Now().UnixNano())
	if _, err = tx.Exec(ctx, "CREATE SCHEMA "+schema+"; SET LOCAL search_path TO "+schema); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `CREATE TABLE squad(id uuid,workspace_id uuid,instructions text);CREATE TABLE issue(id uuid);CREATE TABLE agent_task_queue(id uuid)`); err != nil {
		t.Fatal(err)
	}
	old, err := os.ReadFile("../../migrations/601_pipeline.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, string(old)); err != nil {
		t.Fatal(err)
	}
	ws, s1, s2, s3, user, d1, d2, run := dbid.NewV7(), dbid.NewV7(), dbid.NewV7(), dbid.NewV7(), dbid.NewV7(), dbid.NewV7(), dbid.NewV7(), dbid.NewV7()
	if _, err = tx.Exec(ctx, "INSERT INTO squad(id,workspace_id,instructions,instructions_mode,pipeline_definition_id) VALUES ($1,$4,'keep','pipeline',$5),($2,$4,'guidance','markdown',NULL),($3,$4,'empty','markdown',NULL)", s1, s2, s3, ws, d1); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO pipeline_definition(id,workspace_id,squad_id,revision,kind,source,source_hash,compiler_version,plan,creator_id,idempotency_key) VALUES ($1,$3,$4,1,'gitlab_yaml','original one','hash','v1','{}',$5,'one'),($2,$3,$4,2,'hermes_yaml','original two','hash2','v1','{}',$5,'two')`, d1, d2, ws, s1, user); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO pipeline_run(id,workspace_id,issue_id,squad_id,definition_id,creator_id,idempotency_key,request_hash,status,state) VALUES ($1,$2,$1,$3,$4,$5,'run','hash','succeeded','{"frozen":"original"}')`, run, ws, s1, d1, user); err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("../../migrations/613_pipeline_catalog.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}
	creationHash, err := os.ReadFile("../../migrations/618_pipeline_catalog_creation_hash.up.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, string(creationHash)); err != nil {
		t.Fatal(err)
	}
	q := db.New(tx)
	rows, err := q.ListSquadPipelines(ctx, db.ListSquadPipelinesParams{WorkspaceID: ws, SquadID: s1, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].ID != d1 || rows[0].ExecutableDefinitionID != d1 || !rows[0].Legacy {
		t.Fatalf("migration split or changed default %+v", rows)
	}
	third, err := q.CreatePipelineDefinition(ctx, db.CreatePipelineDefinitionParams{ID: dbid.NewV7(), WorkspaceID: ws, SquadID: s1, PipelineID: d1, Kind: "gitlab_yaml", Source: "third original", SourceHash: "h3", CompilerVersion: "v1", Plan: []byte(`{}`), CreatorID: user, IdempotencyKey: "three"})
	if err != nil || third.Revision != 3 || third.PipelineID != d1 {
		t.Fatalf("migrated sequence did not continue: %+v %v", third, err)
	}
	d, err := q.GetPipelineDefinition(ctx, db.GetPipelineDefinitionParams{ID: d2, WorkspaceID: ws})
	if err != nil || d.PipelineID != d1 || d.Revision != 2 || d.Source != "original two" {
		t.Fatalf("migration rewrote revision %+v %v", d, err)
	}
	var ref, state string
	if err = tx.QueryRow(ctx, "SELECT definition_id::text,state->>'frozen' FROM pipeline_run WHERE id=$1", run).Scan(&ref, &state); err != nil || ref != uuidToString(d1) || state != "original" {
		t.Fatal("historical run changed")
	}
	var count int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM squad_pipeline WHERE squad_id IN($1,$2)", s2, s3).Scan(&count); err != nil || count != 0 {
		t.Fatal("empty squads gained invalid defaults")
	}
}
