package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/pipeline"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestPipelineV17CandidatesAndBindingAuthorization(t *testing.T) {
	f := catalogFixture(t)
	for _, name := range []string{"Executor", "Cassia", "Designer"} {
		agent := dbfx.Agent(t, name, dbfx.Runtime(t, name+" runtime"))
		dbfx.SquadMember(t, f.squad, "agent", agent)
	}
	var candidates struct {
		Current struct {
			UserID string `json:"user_id"`
			Name   string `json:"name"`
		} `json:"current_user"`
		Default string           `json:"default_owner_user_id"`
		Humans  []map[string]any `json:"humans"`
		Agents  []struct {
			ID        string `json:"agent_id"`
			Role      string `json:"role"`
			CanInvoke bool   `json:"can_invoke"`
		} `json:"agents"`
	}
	testutil.Call(t, f.h.PipelineCandidates, newRequest("GET", "/api/pipelines/candidates?squad_id="+f.squad, nil)).Want(200).JSON(&candidates)
	if candidates.Current.UserID != testUserID || candidates.Default != testUserID || len(candidates.Agents) != 4 || len(candidates.Humans) == 0 {
		t.Fatalf("incorrect candidates: %+v", candidates)
	}
	noRole := 0
	for _, a := range candidates.Agents {
		if a.Role == "" {
			noRole++
		}
		if !a.CanInvoke {
			t.Fatal("authorized agent disabled")
		}
	}
	if noRole != 3 {
		t.Fatalf("no-role candidates lost: %+v", candidates.Agents)
	}
	if dbfx.Count(t, "SELECT count(*) FROM squad_member WHERE squad_id=$1 AND member_type='member'", f.squad) != 0 {
		t.Fatal("fixture should contain no human squad role")
	}
	foreign := dbfx.User(t, "Foreign person", fmt.Sprintf("v17foreign-%d@example.test", time.Now().UnixNano()))
	testutil.Call(t, f.h.PipelineCandidates, newRequestAs(foreign, "GET", "/api/pipelines/candidates?squad_id="+f.squad, nil)).Want(404)
	otherWorkspace := dbfx.Workspace(t, "Foreign workspace", "v17-foreign-"+strings.ReplaceAll(f.squad, "-", ""))
	other := dbfx.Squad(t, "Other workspace squad", f.agent, testutil.Cols{"workspace_id": otherWorkspace})
	testutil.Call(t, f.h.PipelineCandidates, newRequest("GET", "/api/pipelines/candidates?squad_id="+other, nil)).Want(404)
	squad, e := f.h.Queries.GetSquadInWorkspace(context.Background(), db.GetSquadInWorkspaceParams{ID: parseUUID(f.squad), WorkspaceID: parseUUID(testWorkspaceID)})
	if e != nil {
		t.Fatal(e)
	}
	base := "kind: gitlab_yaml\nstages: [work]\nnode:\n  stage: work\n  instructions: Entire instruction.\n  agent_id: %s\n  owner_user_id: %s\n"
	valid := fmt.Sprintf(base, candidates.Agents[1].ID, testUserID)
	v := pipeline.Compile(valid)
	bindings, diags := f.h.Pipelines.Bindings(context.Background(), f.h.Queries, squad, *v.Plan, testUserID)
	if len(diags) != 0 || bindings["node"] != candidates.Agents[1].ID || bindings["owner:node"] != testUserID {
		t.Fatalf("identity binding: %v %+v", bindings, diags)
	}
	outsider := dbfx.Agent(t, "Not in squad", dbfx.Runtime(t, "outsider runtime"))
	allowedHuman := dbfx.User(t, "Authorized human", fmt.Sprintf("v17allowed-%d@example.test", time.Now().UnixNano()))
	dbfx.Member(t, testWorkspaceID, allowedHuman, "member")
	allowed := pipeline.Compile(fmt.Sprintf(base, candidates.Agents[1].ID, allowedHuman))
	allowedBindings, allowedDiags := f.h.Pipelines.Bindings(context.Background(), f.h.Queries, squad, *allowed.Plan, testUserID)
	if len(allowedDiags) != 0 || allowedBindings["owner:node"] != allowedHuman {
		t.Fatal("human outside the agent squad was not selectable")
	}
	foreignAgent := dbfx.Agent(t, "Foreign workspace executor", dbfx.Runtime(t, "Foreign agent runtime"), testutil.Cols{"workspace_id": otherWorkspace})
	dbfx.SquadMember(t, f.squad, "agent", foreignAgent)
	cases := []struct{ name, source, code string }{
		{"cross squad", fmt.Sprintf(base, outsider, testUserID), "agent_not_in_squad"},
		{"foreign human", fmt.Sprintf(base, candidates.Agents[1].ID, foreign), "owner_unavailable"},
		{"cross workspace executor", fmt.Sprintf(base, foreignAgent, testUserID), "role_unbound"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var out pipeline.Validation
			testutil.Call(t, f.h.ValidatePipeline, newRequest("POST", "/api/pipelines/validate", map[string]any{"source": tc.source, "squad_id": f.squad})).Want(200).JSON(&out)
			if out.BindingValid == nil || *out.BindingValid || len(out.Diagnostics) == 0 || out.Diagnostics[0].Code != tc.code {
				t.Fatalf("bad diagnostic: %+v", out)
			}
			definitions := dbfx.Count(t, "SELECT count(*) FROM pipeline_definition WHERE squad_id=$1", f.squad)
			var rejected pipeline.Error
			testutil.Call(t, f.h.CreatePipelineDefinition, newRequest("POST", "/api/pipelines/definitions", map[string]any{"squad_id": f.squad, "source": tc.source, "idempotency_key": tc.name, "activate": true, "expected_revision": squad.Revision})).Want(409).JSON(&rejected)
			if rejected.Code != tc.code || dbfx.Count(t, "SELECT count(*) FROM pipeline_definition WHERE squad_id=$1", f.squad) != definitions || dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", f.issue) != 0 {
				t.Fatal("binding rejection saved or dispatched work")
			}
		})
	}
	chosen := candidates.Agents[1].ID
	dbfx.Exec(t, "UPDATE agent SET archived_at=now() WHERE id=$1", chosen)
	_, diags = f.h.Pipelines.Bindings(context.Background(), f.h.Queries, squad, *v.Plan, testUserID)
	if len(diags) == 0 {
		t.Fatal("archived agent accepted")
	}
	dbfx.Exec(t, "UPDATE agent SET archived_at=NULL WHERE id=$1", chosen)
	f.h.Pipelines.CanInvoke = func(context.Context, db.Agent, string, string) bool { return false }
	_, diags = f.h.Pipelines.Bindings(context.Background(), f.h.Queries, squad, *v.Plan, testUserID)
	if len(diags) == 0 || diags[0].Code != "invocation_forbidden" {
		t.Fatalf("invocation permission ignored: %+v", diags)
	}
	testutil.Call(t, f.h.PipelineCandidates, newRequest("GET", "/api/pipelines/candidates?squad_id="+f.squad, nil)).Want(200).JSON(&candidates)
	for _, a := range candidates.Agents {
		if a.CanInvoke {
			t.Fatal("candidate ignored invocation permission")
		}
	}
}

func TestPipelineV17FrozenMemberAndRealDispatch(t *testing.T) {
	f := catalogFixture(t)
	contact := dbfx.User(t, "Frozen human contact", fmt.Sprintf("v17contact-%d@example.test", time.Now().UnixNano()))
	dbfx.Member(t, testWorkspaceID, contact, "member")
	executor := dbfx.Agent(t, "No role actual executor", dbfx.Runtime(t, "No role actual runtime"))
	dbfx.SquadMember(t, f.squad, "agent", executor)
	// The second environment is deliberately unknown until the saved task resumes.
	source := fmt.Sprintf("# Keep original comment.\nkind: gitlab_yaml\nstages: [work]\nfirst:\n  title: Human-friendly name\n  stage: work\n  agent_id: %s\n  instructions: |\n    Full instruction.\n    Keep this line.\nsecond:\n  stage: work\n  needs: [first]\n  instructions: Dynamic leader.\nthird:\n  stage: work\n  needs: [second]\n  tags: [资料研究]\n  instructions: Legacy role.\nconfirm:\n  title: Human confirmation\n  stage: work\n  needs: [third]\n  when: manual\n  owner_user_id: %s\n", executor, contact)
	catalog := createCatalog(t, f, "Real bindings", "v17-frozen", source)
	issue := createSelectedIssue(t, f, "v17 waiting", map[string]any{"mode": "pipeline", "pipeline_id": catalog.Pipeline.ID, "definition_id": catalog.Definition.ID}, "v17-frozen-create")
	if issue.Execution == nil || issue.Execution.State != "waiting_runtime" || len(issue.Execution.Readiness.Runtimes) != 2 || dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue.ID) != 0 {
		t.Fatalf("incorrect readiness: %+v", issue.Execution)
	}
	if issue.Execution.Bindings["first"] != executor || issue.Execution.Bindings["second"] != f.agent || issue.Execution.Bindings["third"] != f.agent || issue.Execution.Bindings["owner:confirm"] != contact {
		t.Fatalf("incorrect frozen bindings: %+v", issue.Execution.Bindings)
	}
	setPipelineBuild(t, &pipelineFixture{agent: executor}, pipelineBuildReportV17())
	dbfx.Exec(t, "DELETE FROM member WHERE workspace_id=$1 AND user_id=$2", testWorkspaceID, contact)
	dbfx.Exec(t, "UPDATE squad SET leader_id=$2 WHERE id=$1", f.squad, executor)
	dbfx.Exec(t, "DELETE FROM squad_member WHERE squad_id=$1 AND member_id=$2", f.squad, executor)
	dbfx.Exec(t, "UPDATE squad_member SET role='renamed-role' WHERE squad_id=$1 AND member_id=$2", f.squad, f.agent)
	var started struct {
		Execution service.IssueExecution `json:"execution"`
		Run       pipeline.Run           `json:"run"`
	}
	testutil.Call(t, f.h.StartIssueExecution, executionRequest("POST", issue.ID)).Want(200).JSON(&started)
	testutil.Call(t, f.h.StartIssueExecution, executionRequest("POST", issue.ID)).Want(200)
	if started.Run.DefinitionID != catalog.Definition.ID || started.Run.Job("first").ExecutorID != executor || started.Run.Job("second").ExecutorID != f.agent || started.Run.Job("third").ExecutorID != f.agent {
		t.Fatalf("configuration changed frozen targets: %+v", started.Run)
	}
	f.issue, f.run, f.agent = issue.ID, started.Run.ID, executor
	job := started.Run.Job("first")
	if job.Current() == nil {
		t.Fatalf("not dispatched: %+v", job)
	}
	task, e := f.h.Queries.GetAgentTask(context.Background(), parseUUID(job.Current().TaskID))
	if e != nil || uuidToString(task.AgentID) != executor || !strings.Contains(task.HandoffNote.String, "Keep this line.") {
		t.Fatalf("actual task target: %+v %v", task, e)
	}
	first := f.report(t, "first", "succeeded", nil)
	f.complete(t, first)
	r := f.read(t)
	second := r.Job("second")
	task, e = f.h.Queries.GetAgentTask(context.Background(), parseUUID(second.Current().TaskID))
	if e != nil || uuidToString(task.AgentID) != issue.Execution.Bindings["second"] {
		t.Fatal("dynamic leader was rebound after freezing")
	}
	if dbfx.Count(t, "SELECT count(*) FROM pipeline_run WHERE issue_id=$1", issue.ID) != 1 || dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue.ID) != 2 {
		t.Fatal("resume duplicated work")
	}
	dbfx.Cleanup(t, "DELETE FROM inbox_item WHERE issue_id=$1", issue.ID)
	f.agent = issue.Execution.Bindings["second"]
	for _, id := range []string{"second", "third"} {
		task := f.report(t, id, "succeeded", nil)
		f.complete(t, task)
	}
	r = f.read(t)
	if r.Job("confirm").OwnerID != contact || r.Job("confirm").OwnerNotificationReason != "owner_unavailable" || dbfx.Count(t, "SELECT count(*) FROM inbox_item WHERE issue_id=$1", issue.ID) != 0 || dbfx.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id=$1", issue.ID) != 3 {
		t.Fatal("invalid frozen owner was replaced or received a notification")
	}
}

func pipelineBuildReportV17() protocol.RuntimeBuildReport {
	b := protocol.BuildInfo{Version: "0.7.3-ipoke.test", Commit: strings.Repeat("a", 40), Capabilities: protocol.PipelineClientCapabilities(), ReleaseChannel: "ipoke"}
	return protocol.RuntimeBuildReport{Daemon: b, Disk: &b}
}

func TestPipelineV17MaterialsMultilineAndHumanNotification(t *testing.T) {
	description := "  Keep leading spaces.\n\nSecond paragraph.\n\n"
	source := fmt.Sprintf("# Original source.\nkind: gitlab_yaml\nstages: [work, review]\nproduce:\n  title: Prepare evidence\n  stage: work\n  instructions: Produce both files.\n  artifacts:\n    files:\n      - name: report.md\n        path: reports/report.md\n        description: |2+\n            Keep leading spaces.\n\n          Second paragraph.\n\n      - name: report.md\n        path: alternate/report.md\n        description: Alternate evidence.\nreview:\n  title: Human review\n  stage: review\n  needs: [produce]\n  when: manual\n  owner_user_id: %s\n", testUserID)
	f := newPipelineFixture(t, source)
	project := documentTestProject(t)
	dbfx.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", f.issue, project)
	f.h.Pipelines.RepositoryFile = func(context.Context, string, string, string, string, string) (string, []byte, error) {
		return strings.Repeat("a", 40), []byte("Actual test evidence."), nil
	}
	r := f.start(t)
	if r.Job("produce").Node.Deliverables[0].Description != description {
		t.Fatalf("YAML paragraphs lost: %q", r.Job("produce").Node.Deliverables[0].Description)
	}
	task, e := f.h.Queries.GetAgentTask(context.Background(), parseUUID(r.Job("produce").Current().TaskID))
	if e != nil || !strings.Contains(task.HandoffNote.String, description) {
		t.Fatal("registered task brief did not preserve explanation paragraphs")
	}
	dbfx.Cleanup(t, "DELETE FROM inbox_item WHERE issue_id=$1", f.issue)
	if dbfx.Count(t, "SELECT count(*) FROM inbox_item WHERE issue_id=$1", f.issue) != 0 {
		t.Fatal("early human notification")
	}
	first := f.report(t, "produce", "succeeded", []pipeline.Artifact{
		{Path: "reports/report.md", Name: "forged name", Description: "forged description", Repo: "test/project", Ref: "main"},
		{Path: "alternate/report.md", Repo: "test/project", Ref: "main"},
	})
	f.complete(t, first)
	r = f.read(t)
	a := r.Job("produce").Current().Report.Artifacts
	if len(a) != 2 || a[0].Description != description || a[0].Name != "report.md" || a[0].SHA != strings.Repeat("a", 40) || a[0].Status != "accessible" || a[0].ID == a[1].ID || r.Job("review").OwnerID != testUserID {
		t.Fatalf("false material identity: %+v", r)
	}
	if dbfx.Count(t, "SELECT count(*) FROM inbox_item WHERE issue_id=$1 AND recipient_id=$2 AND type='pipeline_job'", f.issue, testUserID) != 1 {
		t.Fatal("real human owner did not receive one notification")
	}
	f.reconcile(t)
	if dbfx.Count(t, "SELECT count(*) FROM inbox_item WHERE issue_id=$1", f.issue) != 1 {
		t.Fatal("reconcile duplicated notification")
	}
	doc := createTestDocument(t, project, "Materials", "document")
	input := issueDocumentInput(doc.ID, 1, "v17-material", map[string]any{"kind": "pipeline_artifact", "run_id": f.run, "job_id": "produce", "attempt": 1, "path": "reports/report.md"})
	var associated AssociateDocumentResponse
	testutil.Call(t, f.h.AssociateIssueDocument, issueDocumentRequest("POST", f.issue, "", input)).Want(200).JSON(&associated)
	if !associated.Inserted || !strings.Contains(associated.Document.Body, "[report.md]") || !strings.Contains(associated.Document.Body, "Keep leading spaces.  \n  \nSecond paragraph.  \n  \n") {
		t.Fatalf("MD flattened paragraphs: %q", associated.Document.Body)
	}
	testutil.Call(t, f.h.AssociateIssueDocument, issueDocumentRequest("POST", f.issue, "", input)).Want(200)
	if dbfx.Count(t, "SELECT count(*) FROM project_document_source WHERE document_id=$1", doc.ID) != 1 {
		t.Fatal("duplicate material association")
	}
	var original map[string]any
	testutil.Call(t, f.h.GetPipelineDefinition, testutil.WithURLParams(newRequest("GET", "/api/pipelines/definitions/"+f.definition, nil), "id", f.definition)).Want(200).JSON(&original)
	if original["source"] != source {
		t.Fatal("save regenerated original source")
	}
	newSource := strings.Replace(source, "Second paragraph.", "Replacement description.", 1)
	testutil.Call(t, f.h.CreatePipelineDefinition, newRequest("POST", "/api/pipelines/definitions", map[string]any{"squad_id": f.squad, "source": newSource, "idempotency_key": "v17-material-update"})).Want(201)
	historical := f.read(t)
	if historical.Job("produce").Node.Deliverables[0].Description != description {
		t.Fatal("new definition changed historical material")
	}
	var sources []byte
	if e := testPool.QueryRow(context.Background(), "SELECT source FROM project_document_source WHERE document_id=$1", doc.ID).Scan(&sources); e != nil {
		t.Fatal(e)
	}
	var saved DocumentSourceResponse
	if e := json.Unmarshal(sources, &saved); e != nil || saved.Description != description || saved.Artifact.Path != "reports/report.md" {
		t.Fatalf("source relationship lost exact description: %q %v", sources, e)
	}
}

func TestPipelineV17LongMultilineMarkdownDescription(t *testing.T) {
	project := documentTestProject(t)
	issue := dbfx.Issue(t, "Long material explanation", testutil.Cols{"project_id": project})
	doc := createTestDocument(t, project, "Long description", "document")
	description := "  Leading.\n\n" + strings.Repeat("Complete explanation. ", 300) + "\n\nLast.\n\n"
	input := issueDocumentInput(doc.ID, 1, "v17-long", map[string]any{"kind": "url", "url": "https://example.test/material"})
	input["description"] = description
	var out AssociateDocumentResponse
	testutil.Call(t, testHandler.AssociateIssueDocument, issueDocumentRequest("POST", issue, "", input)).Want(200).JSON(&out)
	if !strings.Contains(out.Document.Body, strings.ReplaceAll(description, "\n", "  \n")) {
		t.Fatal("long Markdown explanation was flattened or truncated")
	}
	var raw []byte
	if e := testPool.QueryRow(context.Background(), "SELECT source FROM project_document_source WHERE document_id=$1", doc.ID).Scan(&raw); e != nil {
		t.Fatal(e)
	}
	var saved DocumentSourceResponse
	if e := json.Unmarshal(raw, &saved); e != nil || saved.Description != description {
		t.Fatal("source relationship did not retain exact text")
	}
}
