package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/pipeline"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const pipelineTestGitlab = `kind: gitlab_yaml
stages: [research, publish, confirm]
read_sources:
  stage: research
  tags: [资料研究]
  instructions: Read the exact source.
make_notes:
  stage: publish
  tags: [资料研究]
  needs: [read_sources]
  instructions: Write the notes.
human_check:
  stage: confirm
  when: manual
  needs: [make_notes]
`
const pipelineTestHermes = `kind: hermes_yaml
roles: {资料研究: {}}
gates: {human_check: {type: manual}}
states:
  read_sources:
    by: 资料研究
    entry: Read the exact source.
  make_notes:
    by: 资料研究
    entry: Write the notes.
    gate: human_check
edges:
  - {from: read_sources, to: make_notes, type: forward}
`

type pipelineFixture struct {
	h                                    *Handler
	squad, agent, issue, definition, run string
}

func newPipelineFixture(t *testing.T, source string) *pipelineFixture {
	t.Helper()
	runtime := dbfx.Runtime(t, "fake pipeline runtime")
	agent := dbfx.Agent(t, "custom-role executor", runtime)
	squad := dbfx.Squad(t, "configurable pipeline", agent)
	dbfx.SquadMember(t, squad, "agent", agent, testutil.Cols{"role": "资料研究"})
	issue := dbfx.Issue(t, "pipeline research", testutil.Cols{"assignee_type": "squad", "assignee_id": squad})
	h := *testHandler
	h.Bus = events.New()
	h.TaskService = service.NewTaskService(h.Queries, h.TxStarter, h.Hub, h.Bus, nil)
	h.AutopilotService = service.NewAutopilotService(h.Queries, h.TxStarter, h.Bus, h.TaskService)
	h.initPipelines(nil)
	f := &pipelineFixture{h: &h, squad: squad, agent: agent, issue: issue}
	dbfx.Cleanup(t, "DELETE FROM pipeline_definition WHERE squad_id=$1", squad)
	dbfx.Cleanup(t, "DELETE FROM pipeline_run WHERE issue_id=$1", issue)
	dbfx.Cleanup(t, "DELETE FROM agent_task_queue WHERE issue_id=$1", issue)
	dbfx.Cleanup(t, "DELETE FROM comment WHERE issue_id=$1", issue)
	var d struct {
		ID string `json:"id"`
	}
	testutil.Call(t, h.CreatePipelineDefinition, newRequest("POST", "/api/pipelines/definitions", map[string]any{"squad_id": squad, "source": source, "idempotency_key": "definition-v1", "activate": true, "expected_revision": 1})).Want(201).JSON(&d)
	f.definition = d.ID
	return f
}
func (f *pipelineFixture) request(method, job string, body any) *http.Request {
	return testutil.WithURLParams(newRequest(method, "/api/pipeline-runs/"+f.run, body), "id", f.run, "job", job)
}
func (f *pipelineFixture) start(t *testing.T) pipeline.Run {
	t.Helper()
	var r pipeline.Run
	testutil.Call(t, f.h.CreatePipelineRun, newRequest("POST", "/api/pipeline-runs", map[string]any{"issue_id": f.issue, "squad_id": f.squad, "idempotency_key": "run-1"})).Want(201).JSON(&r)
	f.run = r.ID
	return r
}
func (f *pipelineFixture) read(t *testing.T) pipeline.Run {
	t.Helper()
	var r pipeline.Run
	testutil.Call(t, f.h.GetPipelineRun, f.request("GET", "", nil)).Want(200).JSON(&r)
	return r
}
func (f *pipelineFixture) row(t *testing.T) db.PipelineRun {
	t.Helper()
	r, e := f.h.Queries.GetPipelineRun(context.Background(), db.GetPipelineRunParams{ID: parseUUID(f.run), WorkspaceID: parseUUID(testWorkspaceID)})
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func (f *pipelineFixture) reconcile(t *testing.T) {
	t.Helper()
	if e := f.h.Pipelines.Reconcile(context.Background(), f.row(t)); e != nil {
		t.Fatal(e)
	}
}
func (f *pipelineFixture) report(t *testing.T, job, result string, artifacts []pipeline.Artifact) string {
	t.Helper()
	r := f.read(t)
	a := r.Job(job).Current()
	if a == nil {
		t.Fatal("no registered attempt")
	}
	dbfx.Exec(t, "UPDATE agent_task_queue SET status='running',started_at=now() WHERE id=$1", a.TaskID)
	req := f.request("POST", job, map[string]any{"attempt": a.Number, "result": result, "report": "fake executor: " + result, "artifacts": artifacts, "idempotency_key": fmt.Sprintf("report-%s-%d", job, a.Number)})
	req.Header.Set("X-Agent-ID", f.agent)
	req.Header.Set("X-Task-ID", a.TaskID)
	testutil.Call(t, f.h.ReportPipelineJob, req).Want(200)
	return a.TaskID
}
func (f *pipelineFixture) complete(t *testing.T, id string) {
	t.Helper()
	if _, err := f.h.TaskService.CompleteTask(context.Background(), parseUUID(id), []byte(`{"output":"Fake executor completed"}`), "", "", "", false, "", ""); err != nil {
		t.Fatal(err)
	}
}

func TestPipelineBothDialectsPersistentExecution(t *testing.T) {
	for kind, source := range map[string]string{"gitlab_yaml": pipelineTestGitlab, "hermes_yaml": pipelineTestHermes} {
		t.Run(kind, func(t *testing.T) {
			f := newPipelineFixture(t, source)
			r := f.start(t)
			if r.Plan.Kind != kind || len(r.Jobs) != 3 || r.Job("make_notes").Status != "pending" {
				t.Fatalf("incorrect custom graph: %+v", r)
			}
			first := f.report(t, "read_sources", "succeeded", nil)
			f.complete(t, first)
			r = f.read(t)
			if r.Job("make_notes").Status != "queued" {
				t.Fatalf("second node not queued: %+v", r)
			}
			if r.Job("make_notes").ExecutorID != f.agent {
				t.Fatal("same-role executor changed")
			}
			f.h.initPipelines(nil)
			f.reconcile(t)
			if got := len(f.job(t, "make_notes").Attempts); got != 1 {
				t.Fatalf("restart duplicated attempts: %d", got)
			}
			second := f.report(t, "make_notes", "succeeded", nil)
			f.complete(t, second)
			r = f.read(t)
			gate := "human_check"
			if kind == "hermes_yaml" {
				gate = "make_notes.gate.human_check"
			}
			j := r.Job(gate)
			if j.Status != "waiting_approval" || r.Status != "waiting_approval" {
				t.Fatalf("missing real gate: %+v", r)
			}
			var issueStatus string
			dbfx.QueryRow(t, "SELECT status FROM issue WHERE id=$1", f.issue).Scan(&issueStatus)
			if issueStatus != "in_review" {
				t.Fatalf("issue status = %s", issueStatus)
			}
			request := f.request("POST", gate, map[string]any{"decision": "approve", "expected_revision": j.Revision, "idempotency_key": "accept"})
			testutil.Call(t, f.h.DecidePipelineJob, request).Want(200)
			if r = f.read(t); r.Status != "succeeded" || r.Job(gate).Decision.ActorID != testUserID {
				t.Fatalf("approval not durable: %+v", r)
			}
			testutil.Call(t, f.h.DecidePipelineJob, f.request("POST", gate, map[string]any{"decision": "reject", "reason": "overwrite", "expected_revision": j.Revision, "idempotency_key": "different"})).Want(409)
			if n := dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", f.issue); n != 2 {
				t.Fatalf("expected exactly two tasks, got %d", n)
			}
		})
	}
}

func TestPipelineMissingAndFailedResultsCannotPassApproval(t *testing.T) {
	for _, result := range []string{"missing", "failed", "blocked"} {
		t.Run(result, func(t *testing.T) {
			f := newPipelineFixture(t, pipelineTestGitlab)
			r := f.start(t)
			id := r.Job("read_sources").Current().TaskID
			if result == "missing" {
				dbfx.Exec(t, "UPDATE agent_task_queue SET status='running',started_at=now() WHERE id=$1", id)
			} else {
				id = f.report(t, "read_sources", result, nil)
			}
			f.complete(t, id)
			r = f.read(t)
			if r.Job("read_sources").Status == "succeeded" || r.Job("human_check").Status == "waiting_approval" || len(r.Job("make_notes").Attempts) != 0 {
				t.Fatalf("unsafe advance: %+v", r)
			}
			testutil.Call(t, f.h.DecidePipelineJob, f.request("POST", "human_check", map[string]any{"decision": "approve", "expected_revision": r.Job("human_check").Revision, "idempotency_key": "bad-approval"})).Want(409)
		})
	}
}

func TestPipelineStartRetryAndCallbackIdempotency(t *testing.T) {
	f := newPipelineFixture(t, pipelineTestGitlab)
	r := f.start(t)
	same := f.start(t)
	if r.ID != same.ID {
		t.Fatal("start duplicated run")
	}
	id := f.report(t, "read_sources", "failed", nil)
	f.complete(t, id)
	r = f.read(t)
	rev := r.Job("read_sources").Revision
	for range 2 {
		testutil.Call(t, f.h.RetryPipelineJob, f.request("POST", "read_sources", map[string]any{"expected_revision": rev, "idempotency_key": "retry-1"})).Want(200)
	}
	r = f.read(t)
	if len(r.Job("read_sources").Attempts) != 2 {
		t.Fatalf("retry history missing: %+v", r)
	}
	f.complete(t, id)
	if len(f.job(t, "read_sources").Attempts) != 2 {
		t.Fatal("duplicate completion created new attempt")
	}
	testutil.Call(t, f.h.RetryPipelineJob, f.request("POST", "read_sources", map[string]any{"expected_revision": rev, "idempotency_key": "retry-stale"})).Want(409)
}

func TestPipelineApprovalRaceAndHumanIdentity(t *testing.T) {
	f := newPipelineFixture(t, pipelineTestGitlab)
	f.start(t)
	for _, job := range []string{"read_sources", "make_notes"} {
		id := f.report(t, job, "succeeded", nil)
		f.complete(t, id)
	}
	r := f.read(t)
	rev := r.Job("human_check").Revision
	forged := f.request("POST", "human_check", map[string]any{"decision": "approve", "expected_revision": rev, "idempotency_key": "agent-approval"})
	forged.Header.Set("X-Actor-Source", "task_token")
	forged.Header.Set("X-Agent-ID", f.agent)
	testutil.Call(t, f.h.DecidePipelineJob, forged).Want(403)
	testutil.Call(t, f.h.DecidePipelineJob, f.request("POST", "human_check", map[string]any{"decision": "reject", "reason": "  \n", "expected_revision": rev, "idempotency_key": "empty"})).Want(422)
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for i := range 2 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			req := f.request("POST", "human_check", map[string]any{"decision": "approve", "expected_revision": rev, "idempotency_key": fmt.Sprintf("concurrent-%d", i)})
			rec := testutil.Call(t, f.h.DecidePipelineJob, req)
			codes <- rec.Code
		}(i)
	}
	wg.Wait()
	close(codes)
	counts := map[int]int{}
	for c := range codes {
		counts[c]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatalf("concurrent decisions: %v", counts)
	}
}

func TestPipelinePublishedArtifactsRequireCurrentAttemptAndAccessibleContent(t *testing.T) {
	source := strings.Replace(pipelineTestGitlab, "  instructions: Read the exact source.", "  instructions: Read the exact source.\n  artifacts: {paths: [reports/context.md]}", 1)
	for _, accessible := range []bool{false, true} {
		t.Run(fmt.Sprint(accessible), func(t *testing.T) {
			f := newPipelineFixture(t, source)
			r := f.start(t)
			a := r.Job("read_sources").Current()
			f.h.Pipelines.ArtifactAvailable = func(context.Context, db.Attachment) bool { return accessible }
			attachment := dbfx.Insert(t, "attachment", testutil.Cols{"workspace_id": testWorkspaceID, "issue_id": f.issue, "task_id": a.TaskID, "uploader_type": "agent", "uploader_id": f.agent, "filename": "context.md", "url": "/fake/context.md", "content_type": "text/markdown", "size_bytes": 12})
			id := f.report(t, "read_sources", "succeeded", []pipeline.Artifact{{Path: "reports/context.md", AttachmentID: attachment}})
			f.complete(t, id)
			r = f.read(t)
			if accessible {
				j := r.Job("make_notes")
				if j.Status != "queued" || len(j.Current().Inputs) != 1 || j.Current().Inputs[0].Attempt != 1 || j.Current().Inputs[0].AttachmentID != attachment {
					t.Fatalf("artifact not pinned: %+v", r)
				}
			} else if r.Job("read_sources").Status != "blocked" || len(r.Job("make_notes").Attempts) != 0 {
				t.Fatalf("unavailable artifact did not block: %+v", r)
			}
		})
	}
}

func TestPipelineSnapshotsModesCommentsAndCancellation(t *testing.T) {
	f := newPipelineFixture(t, pipelineTestGitlab)
	r := f.start(t)
	oldID := r.DefinitionID
	testutil.Call(t, f.h.UpdateSquad, testutil.WithURLParams(newRequest("PUT", "/api/squads/"+f.squad, map[string]any{"name": "renamed by old client"}), "id", f.squad, "workspaceId", testWorkspaceID)).Want(200)
	var squad SquadResponse
	testutil.Call(t, f.h.GetSquad, testutil.WithURLParams(newRequest("GET", "/api/squads/"+f.squad, nil), "id", f.squad, "workspaceId", testWorkspaceID)).Want(200).JSON(&squad)
	if squad.InstructionsMode != "pipeline" || *squad.PipelineDefinitionID != oldID {
		t.Fatal("old client cleared pipeline configuration")
	}
	testutil.Call(t, f.h.UpdateSquad, testutil.WithURLParams(newRequest("PUT", "/api/squads/"+f.squad, map[string]any{"instructions_mode": "markdown", "expected_revision": squad.Revision}), "id", f.squad, "workspaceId", testWorkspaceID)).Want(200)
	f.reconcile(t)
	r = f.read(t)
	if r.DefinitionID != oldID || r.Status != "running" {
		t.Fatal("mode change modified live snapshot")
	}
	issue, e := f.h.Queries.GetIssue(context.Background(), parseUUID(f.issue))
	if e != nil {
		t.Fatal(e)
	}
	if !f.h.pipelineOwnsComments(context.Background(), issue, parseUUID(r.Job("read_sources").Current().TaskID)) {
		t.Fatal("pipeline comments can trigger legacy dispatch")
	}
	testutil.Call(t, f.h.CancelPipelineRun, f.request("POST", "", map[string]any{"reason": "user stop", "idempotency_key": "stop"})).Want(200)
	r = f.read(t)
	if r.Status != "cancelled" || r.Job("make_notes").Status != "cancelled" {
		t.Fatalf("cancel did not settle: %+v", r)
	}
	if e = f.h.Pipelines.Reconcile(context.Background(), f.row(t)); e != nil {
		t.Fatal(e)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", f.issue); n != 1 {
		t.Fatalf("cancel scheduled downstream: %d", n)
	}
}

func TestPipelineBindingPermissionsAndDefinitionOwnership(t *testing.T) {
	f := newPipelineFixture(t, pipelineTestGitlab)
	other := dbfx.Squad(t, "other squad", f.agent)
	req := testutil.WithURLParams(newRequest("PUT", "/api/squads/"+other, map[string]any{"instructions_mode": "pipeline", "pipeline_definition_id": f.definition, "expected_revision": 1}), "id", other, "workspaceId", testWorkspaceID)
	testutil.Call(t, f.h.UpdateSquad, req).Want(404)
	second := dbfx.Agent(t, "ambiguous executor", "", testutil.Cols{})
	dbfx.SquadMember(t, f.squad, "agent", second, testutil.Cols{"role": " 资料研究 "})
	var validation pipeline.Validation
	testutil.Call(t, f.h.ValidatePipeline, newRequest("POST", "/api/pipelines/validate", map[string]any{"source": pipelineTestGitlab, "squad_id": f.squad})).Want(200).JSON(&validation)
	if validation.BindingValid == nil || *validation.BindingValid {
		t.Fatal("ambiguous role accepted")
	}
	dbfx.Exec(t, "DELETE FROM squad_member WHERE squad_id=$1 AND member_id=$2", f.squad, second)
	f.h.Pipelines.CanInvoke = func(context.Context, db.Agent, string, string) bool { return false }
	testutil.Call(t, f.h.CreatePipelineRun, newRequest("POST", "/api/pipeline-runs", map[string]any{"issue_id": f.issue, "squad_id": f.squad, "idempotency_key": "forbidden"})).Want(403)
	if n := dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", f.issue); n != 0 {
		t.Fatal("forbidden executor queued")
	}
}

func TestPipelineReassignmentStopsOldScheduling(t *testing.T) {
	f := newPipelineFixture(t, pipelineTestGitlab)
	r := f.start(t)
	dbfx.Exec(t, "UPDATE issue SET assignee_id=NULL,assignee_type=NULL WHERE id=$1", f.issue)
	f.reconcile(t)
	r = f.read(t)
	if r.Status != "cancelled" || r.Reason != "issue_context_changed" || len(r.Job("make_notes").Attempts) != 0 {
		t.Fatalf("stale assignment kept running: %+v", r)
	}
}

func TestPipelineDefinitionOriginalSourceAndVersion(t *testing.T) {
	f := newPipelineFixture(t, pipelineTestHermes)
	var original map[string]any
	testutil.Call(t, f.h.GetPipelineDefinition, testutil.WithURLParams(newRequest("GET", "/api/pipelines/definitions/"+f.definition, nil), "id", f.definition)).Want(200).JSON(&original)
	if original["source"] != pipelineTestHermes || original["kind"] != "hermes_yaml" {
		t.Fatal("source was converted")
	}
	raw, _ := json.Marshal(original["plan"])
	var p pipeline.Plan
	_ = json.Unmarshal(raw, &p)
	if p.Nodes[0].Instructions != "Read the exact source." {
		t.Fatal("entry was rewritten")
	}
}

func (f *pipelineFixture) job(t *testing.T, id string) *pipeline.Job {
	t.Helper()
	r := f.read(t)
	return r.Job(id)
}

func TestPipelineLeaderFallbackAndPermissionRecheck(t *testing.T) {
	source := strings.ReplaceAll(pipelineTestGitlab, "  tags: [资料研究]\n", "")
	f := newPipelineFixture(t, source)
	r := f.start(t)
	if r.Job("read_sources").ExecutorID != f.agent {
		t.Fatal("missing tags did not use leader_id")
	}
	task, err := f.h.Queries.GetAgentTask(context.Background(), parseUUID(r.Job("read_sources").Current().TaskID))
	if err != nil {
		t.Fatal(err)
	}
	f.h.Pipelines.CanInvoke = func(context.Context, db.Agent, string, string) bool { return false }
	if err = f.h.Pipelines.CheckTask(context.Background(), task); err == nil {
		t.Fatal("revoked invocation permission survived claim")
	}
}

func TestPipelineRejectCancelsConcurrentAttempt(t *testing.T) {
	source := `kind: gitlab_yaml
stages: [concurrent]
long_task: {stage: concurrent, instructions: Work.}
review: {stage: concurrent, when: manual}
`
	f := newPipelineFixture(t, source)
	r := f.start(t)
	if r.Job("review").Status != "waiting_approval" {
		t.Fatal("independent gate not ready")
	}
	testutil.Call(t, f.h.DecidePipelineJob, f.request("POST", "review", map[string]any{"decision": "reject", "reason": "needs changes", "expected_revision": r.Job("review").Revision, "idempotency_key": "reject"})).Want(200)
	r = f.read(t)
	if r.Status != "rejected" || r.Job("long_task").Status != "cancelled" {
		t.Fatalf("rejection left work active: %+v", r)
	}
}

func TestPipelineOwnerNotificationAndUnpricedUsage(t *testing.T) {
	source := strings.Replace(pipelineTestGitlab, "  when: manual", "  when: manual\n  owner: 人工复核", 1)
	f := newPipelineFixture(t, pipelineTestGitlab)
	dbfx.SquadMember(t, f.squad, "member", testUserID, testutil.Cols{"role": "人工复核"})
	d, err := f.h.Pipelines.SaveDefinition(context.Background(), testWorkspaceID, f.squad, testUserID, source, "v2", true, 2)
	if err != nil {
		t.Fatal(err)
	}
	f.definition = uuidToString(d.ID)
	f.start(t)
	for _, job := range []string{"read_sources", "make_notes"} {
		id := f.report(t, job, "succeeded", nil)
		if job == "read_sources" {
			dbfx.Insert(t, "task_usage", testutil.Cols{"task_id": id, "provider": "fake", "model": "unknown-price", "input_tokens": 42, "output_tokens": 11, "cache_read_tokens": 0, "cache_write_tokens": 0})
		}
		f.complete(t, id)
	}
	f.reconcile(t)
	f.reconcile(t)
	if n := dbfx.Count(t, "SELECT count(*) FROM inbox_item WHERE issue_id=$1 AND type='pipeline_job'", f.issue); n != 1 {
		t.Fatalf("owner notified %d times", n)
	}
	dbfx.Cleanup(t, "DELETE FROM inbox_item WHERE issue_id=$1", f.issue)
	r := f.read(t)
	usage := r.Job("read_sources").Current().Usage
	if len(usage) != 1 || usage[0].InputTokens != 42 || usage[0].CostUSDTicks != nil {
		t.Fatalf("unknown price became free: %+v", usage)
	}
}

func TestPipelineWorkflowKeepsStepAndStopsWhenMoved(t *testing.T) {
	f := newPipelineFixture(t, pipelineTestGitlab)
	workflow := createTestWorkflow(t, "pipeline workflow "+workflowTestSuffix(), "todo", "in_progress", "in_review")
	project := dbfx.Project(t, "pipeline workflow project", testutil.Cols{"workflow_id": workflow.ID})
	dbfx.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", f.issue, project)
	r := f.start(t)
	if r.WorkflowID != workflow.ID || r.WorkflowStep != "todo" {
		t.Fatalf("workflow snapshot missing: %+v", r)
	}
	var status string
	dbfx.QueryRow(t, "SELECT status FROM issue WHERE id=$1", f.issue).Scan(&status)
	if status != "todo" {
		t.Fatal("pipeline overwrote workflow step")
	}
	dbfx.Exec(t, "UPDATE issue SET status='in_review' WHERE id=$1", f.issue)
	var next pipeline.Run
	testutil.Call(t, f.h.CreatePipelineRun, newRequest("POST", "/api/pipeline-runs", map[string]any{"issue_id": f.issue, "squad_id": f.squad, "idempotency_key": "new-workflow-step"})).Want(201).JSON(&next)
	if next.ID == r.ID || next.WorkflowStep != "in_review" {
		t.Fatal("workflow handoff did not create a fresh run")
	}
	if r = f.read(t); r.Status != "cancelled" || r.Reason != "issue_context_changed" {
		t.Fatalf("moved workflow kept running: %+v", r)
	}
}

func TestPipelineCrossWorkspaceDefinitionAndArtifactReport(t *testing.T) {
	f := newPipelineFixture(t, pipelineTestGitlab)
	r := f.start(t)
	task := r.Job("read_sources").Current().TaskID
	req := f.request("POST", "make_notes", map[string]any{"attempt": 1, "result": "succeeded", "report": "forged", "idempotency_key": "forged"})
	req.Header.Set("X-Agent-ID", f.agent)
	req.Header.Set("X-Task-ID", task)
	testutil.Call(t, f.h.ReportPipelineJob, req).Want(403)
	wrong := testutil.WithURLParams(newRequest("GET", "/api/pipelines/definitions/"+f.definition, nil), "id", f.definition)
	wrong.Header.Set("X-Workspace-ID", "99999999-9999-4999-8999-999999999999")
	testutil.Call(t, f.h.GetPipelineDefinition, wrong).Want(404)
}

func TestPipelineAutomationWaitsForAggregateAndRefusesRunOnly(t *testing.T) {
	f := newPipelineFixture(t, pipelineTestGitlab)
	r := f.start(t)
	ap := dbfx.Insert(t, "autopilot", testutil.Cols{"workspace_id": testWorkspaceID, "title": "pipeline automation", "assignee_type": "squad", "assignee_id": f.squad, "created_by_type": "member", "created_by_id": testUserID, "execution_mode": "create_issue"})
	ar := dbfx.Insert(t, "autopilot_run", testutil.Cols{"autopilot_id": ap, "source": "manual", "status": "issue_created", "issue_id": f.issue, "task_id": r.Job("read_sources").Current().TaskID})
	dbfx.Exec(t, "UPDATE issue SET origin_type='autopilot',origin_id=$2 WHERE id=$1", f.issue, ar)
	for _, job := range []string{"read_sources", "make_notes"} {
		id := f.report(t, job, "succeeded", nil)
		f.complete(t, id)
		var state string
		dbfx.QueryRow(t, "SELECT status FROM autopilot_run WHERE id=$1", ar).Scan(&state)
		if state != "issue_created" && state != "running" {
			t.Fatalf("automation settled on one node: %s", state)
		}
	}
	r = f.read(t)
	testutil.Call(t, f.h.DecidePipelineJob, f.request("POST", "human_check", map[string]any{"decision": "approve", "expected_revision": r.Job("human_check").Revision, "idempotency_key": "finish-auto"})).Want(200)
	var state string
	dbfx.QueryRow(t, "SELECT status FROM autopilot_run WHERE id=$1", ar).Scan(&state)
	if state != "completed" {
		t.Fatalf("automation not settled on aggregate: %s", state)
	}
	testutil.Call(t, f.h.CreateAutopilot, newRequest("POST", "/api/autopilots", map[string]any{"title": "unsupported", "assignee_type": "squad", "assignee_id": f.squad, "execution_mode": "run_only"})).Want(409)
}

func TestPipelineArtifactRemovedBeforeProcessCompletionCannotSucceed(t *testing.T) {
	source := "kind: gitlab_yaml\nstages: [custom]\nproduce:\n  stage: custom\n  instructions: Deliver.\n  artifacts: {paths: [report.md]}\n"
	f := newPipelineFixture(t, source)
	r := f.start(t)
	task := r.Job("produce").Current().TaskID
	available := true
	f.h.Pipelines.ArtifactAvailable = func(context.Context, db.Attachment) bool { return available }
	attachment := dbfx.Insert(t, "attachment", testutil.Cols{"workspace_id": testWorkspaceID, "issue_id": f.issue, "task_id": task, "uploader_type": "agent", "uploader_id": f.agent, "filename": "report.md", "url": "/fake/report.md", "content_type": "text/markdown", "size_bytes": 1})
	id := f.report(t, "produce", "succeeded", []pipeline.Artifact{{Path: "report.md", AttachmentID: attachment}})
	available = false
	f.complete(t, id)
	r = f.read(t)
	if r.Status != "blocked" || r.Job("produce").Status != "blocked" {
		t.Fatalf("missing output became success: %+v", r)
	}
}

func TestPipelineLegacyRerunCannotStartCoordinator(t *testing.T) {
	f := newPipelineFixture(t, pipelineTestGitlab)
	r := f.start(t)
	for _, body := range []map[string]any{{}, {"task_id": r.Job("read_sources").Current().TaskID}} {
		testutil.Call(t, f.h.RerunIssue, testutil.WithURLParams(newRequest("POST", "/api/issues/"+f.issue+"/rerun", body), "id", f.issue)).Want(409)
	}
	if count := dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", f.issue); count != 1 {
		t.Fatalf("legacy coordinator created: %d", count)
	}
}

func TestPipelineNewDefinitionLeavesLivePlanFrozen(t *testing.T) {
	f := newPipelineFixture(t, pipelineTestGitlab)
	old := f.start(t)
	source := strings.Replace(pipelineTestGitlab, "Read the exact source.", "Read a new source without rewriting the old run.", 1)
	d, err := f.h.Pipelines.SaveDefinition(context.Background(), testWorkspaceID, f.squad, testUserID, source, "new-definition", true, 2)
	if err != nil {
		t.Fatal(err)
	}
	if live := f.read(t); live.DefinitionID != old.DefinitionID || live.Plan.Nodes[0].Instructions != "Read the exact source." {
		t.Fatal("live plan was recompiled")
	}
	testutil.Call(t, f.h.CancelPipelineRun, f.request("POST", "", map[string]any{"reason": "new definition", "idempotency_key": "old-stop"})).Want(200)
	var next pipeline.Run
	testutil.Call(t, f.h.CreatePipelineRun, newRequest("POST", "/api/pipeline-runs", map[string]any{"issue_id": f.issue, "squad_id": f.squad, "idempotency_key": "run-2"})).Want(201).JSON(&next)
	if next.DefinitionID != uuidToString(d.ID) || next.Plan.Nodes[0].Instructions == old.Plan.Nodes[0].Instructions {
		t.Fatal("new run did not select the new version")
	}
}

func TestPipelineUnknownSquadModeDoesNotFallBackToLeader(t *testing.T) {
	f := newPipelineFixture(t, pipelineTestGitlab)
	dbfx.Exec(t, "UPDATE squad SET instructions_mode='future_mode' WHERE id=$1", f.squad)
	issue, err := f.h.Queries.GetIssue(context.Background(), parseUUID(f.issue))
	if err != nil {
		t.Fatal(err)
	}
	if f.h.enqueueSquadLeaderTask(context.Background(), issue, pgtype.UUID{}, "member", testUserID, "") {
		t.Fatal("unknown mode started the leader")
	}
	if _, err = f.h.TaskService.EnqueueTaskForSquadLeaderByActor(context.Background(), issue, parseUUID(f.agent), parseUUID(f.squad), parseUUID(testUserID)); err == nil {
		t.Fatal("unknown mode silently used markdown dispatch")
	}
	if count := dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", f.issue); count != 0 {
		t.Fatal("unknown mode queued a task")
	}
}
