package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/multica-ai/multica/server/internal/pipeline"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func issueDocumentRequest(method, issueID, docID string, input any) *http.Request {
	return testutil.WithURLParams(newRequest(method, "/api/issues/"+issueID+"/documents/"+docID, input), "id", issueID, "documentId", docID)
}
func issueDocumentInput(docID string, version int32, key string, source any) map[string]any {
	out := map[string]any{"document_id": docID, "base_version": version, "idempotency_key": key}
	if source != nil {
		out["source"] = source
	}
	return out
}

func TestDocumentAssociationIdempotencyGroupingAndUnlink(t *testing.T) {
	project := documentTestProject(t)
	issue := dbfx.Issue(t, "Research source task", testutil.Cols{"project_id": project})
	second := dbfx.Issue(t, "Reuse the same document", testutil.Cols{"project_id": project})
	legacy := createTestDocument(t, project, "Legacy project notes", "document")
	body := "## Human paragraph\n\nKeep trailing spaces.  \n"
	doc := createTestDocument(t, project, "Research decisions", "document")
	testutil.Call(t, testHandler.SaveProjectDocument, documentTestRequest("PUT", project, doc.ID, map[string]any{"title": doc.Title, "body": body, "base_version": 1})).Want(200)
	source := map[string]any{"kind": "url", "url": "https://example.org/decision?q=1#details"}
	input := issueDocumentInput(doc.ID, 2, "first", source)
	input["label"] = "Decision [source]"
	input["description"] = "Reasons and alternatives"
	var result AssociateDocumentResponse
	testutil.Call(t, testHandler.AssociateIssueDocument, issueDocumentRequest("POST", issue, "", input)).Want(200).JSON(&result)
	if !result.Inserted || result.Replayed || result.Document.Version != 3 || !strings.HasPrefix(result.Document.Body, body) || !strings.Contains(result.Document.Body, `[Decision \[source\]](<https://example.org/decision?q=1#details>) — Reasons and alternatives`) || !strings.Contains(result.Document.Body, "content unverified") {
		t.Fatalf("bad append: %+v", result)
	}
	saved := result.Document
	testutil.Call(t, testHandler.AssociateIssueDocument, issueDocumentRequest("POST", issue, "", input)).Want(200).JSON(&result)
	if !result.Replayed || result.Document != saved {
		t.Fatalf("replay changed snapshot: %+v", result)
	}
	input["idempotency_key"] = "same-source-new-key"
	input["label"] = "Changed label"
	testutil.Call(t, testHandler.AssociateIssueDocument, issueDocumentRequest("POST", issue, "", input)).Want(200).JSON(&result)
	if result.Inserted || result.Document.Version != 3 || result.Document.Body != saved.Body {
		t.Fatal("same source appended again")
	}
	input["label"] = "other body with reused key"
	testutil.Call(t, testHandler.AssociateIssueDocument, issueDocumentRequest("POST", issue, "", input)).Want(409)
	testutil.Call(t, testHandler.AssociateIssueDocument, issueDocumentRequest("POST", second, "", issueDocumentInput(doc.ID, 3, "reuse", nil))).Want(200)
	another := createTestDocument(t, project, "Another outcome", "document")
	testutil.Call(t, testHandler.AssociateIssueDocument, issueDocumentRequest("POST", issue, "", issueDocumentInput(another.ID, 1, "second-document", nil))).Want(200)
	dbfx.Exec(t, "UPDATE issue SET title='Renamed research source' WHERE id=$1", issue)
	var listing struct {
		Documents  []ProjectDocumentResponse `json:"documents"`
		Groups     []DocumentIssueGroup      `json:"groups"`
		References []DocumentReference       `json:"references"`
		Total      int                       `json:"total"`
	}
	req := documentTestRequest("GET", project, "", nil)
	req.URL.RawQuery = url.Values{"q": {"Renamed research"}}.Encode()
	testutil.Call(t, testHandler.ListProjectDocuments, req).Want(200).JSON(&listing)
	if listing.Total != 2 || len(listing.Groups) != 1 || *listing.Groups[0].IssueID != issue || listing.Groups[0].Count != 2 || listing.Groups[0].Title != "Renamed research source" {
		t.Fatalf("stable task grouping/search: %+v", listing)
	}
	testutil.Call(t, testHandler.ListProjectDocuments, documentTestRequest("GET", project, "", nil)).Want(200).JSON(&listing)
	unassociated := listing.Groups[len(listing.Groups)-1]
	if unassociated.IssueID != nil || unassociated.Count != 1 || unassociated.Documents[0].ID != legacy.ID {
		t.Fatalf("legacy grouping: %+v", listing)
	}
	testutil.Call(t, testHandler.ListIssueDocuments, issueDocumentRequest("GET", issue, "", nil)).Want(200).JSON(&listing)
	if len(listing.References) != 2 || listing.Total != 2 {
		t.Fatalf("reverse lookup: %+v", listing)
	}
	var provenance DocumentSourceResponse
	for _, ref := range listing.References {
		if len(ref.Sources) > 0 {
			provenance = ref.Sources[0].Source
			if ref.Sources[0].DocumentVersion != 3 {
				t.Fatal("source revision lost")
			}
		}
	}
	if provenance.Verified || !provenance.Mutable || provenance.IssueID != issue {
		t.Fatalf("external provenance: %+v", provenance)
	}
	testutil.Call(t, testHandler.UnlinkIssueDocument, issueDocumentRequest("DELETE", issue, doc.ID, nil)).Want(204)
	testutil.Call(t, testHandler.ListIssueDocuments, issueDocumentRequest("GET", issue, "", nil)).Want(200).JSON(&listing)
	if listing.Total != 1 {
		t.Fatal("unlink did not remove only the task relation")
	}
	testutil.Call(t, testHandler.ListIssueDocuments, issueDocumentRequest("GET", second, "", nil)).Want(200).JSON(&listing)
	if listing.Total != 1 || listing.Documents[0].ID != doc.ID {
		t.Fatal("unlink removed another issue's reference")
	}
	var read ProjectDocumentResponse
	testutil.Call(t, testHandler.GetProjectDocument, documentTestRequest("GET", project, doc.ID, nil)).Want(200).JSON(&read)
	if read != saved {
		t.Fatal("unlink mutated Markdown or history")
	}
	replay := issueDocumentInput(doc.ID, 2, "first", source)
	replay["label"] = "Decision [source]"
	replay["description"] = "Reasons and alternatives"
	testutil.Call(t, testHandler.AssociateIssueDocument, issueDocumentRequest("POST", issue, "", replay)).Want(200).JSON(&result)
	if result.Linked || !result.Replayed {
		t.Fatal("replayed old write resurrected unlinked relation")
	}
}

func TestDocumentAssociationCreateReplayAndConflicts(t *testing.T) {
	project := documentTestProject(t)
	issue := dbfx.Issue(t, "Create related document", testutil.Cols{"project_id": project})
	input := map[string]any{"create_document": map[string]any{"title": "New Markdown", "body": "Human introduction", "kind": "document"}, "base_version": 0, "idempotency_key": "new-doc", "source": map[string]any{"kind": "url", "url": "https://example.org/source"}}
	var result AssociateDocumentResponse
	testutil.Call(t, testHandler.AssociateIssueDocument, issueDocumentRequest("POST", issue, "", input)).Want(200).JSON(&result)
	id := result.Document.ID
	if result.Document.Version != 1 || !result.Inserted || !strings.HasPrefix(result.Document.Body, "Human introduction\n\n") {
		t.Fatalf("initial revision: %+v", result)
	}
	for range 2 {
		testutil.Call(t, testHandler.AssociateIssueDocument, issueDocumentRequest("POST", issue, "", input)).Want(200).JSON(&result)
		if result.Document.ID != id || !result.Replayed {
			t.Fatal("repeated create duplicated document")
		}
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM project_document WHERE project_id=$1", project); n != 1 {
		t.Fatalf("created %d documents", n)
	}
	const remote = "Human revision after linking\n"
	testutil.Call(t, testHandler.SaveProjectDocument, documentTestRequest("PUT", project, id, map[string]any{"base_version": 1, "title": "Renamed by human", "body": remote})).Want(200)
	stale := issueDocumentInput(id, 1, "stale-source", map[string]any{"kind": "url", "url": "https://example.org/new-source"})
	var conflict struct {
		Code   string                  `json:"code"`
		Latest ProjectDocumentResponse `json:"latest"`
	}
	testutil.Call(t, testHandler.AssociateIssueDocument, issueDocumentRequest("POST", issue, "", stale)).Want(409).JSON(&conflict)
	if conflict.Code != "document_version_conflict" || conflict.Latest.Version != 2 || conflict.Latest.Body != remote {
		t.Fatalf("conflict lost latest: %+v", conflict)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM project_document_source WHERE document_id=$1", id); n != 1 {
		t.Fatal("conflict committed a source")
	}
	stale["base_version"] = 2
	testutil.Call(t, testHandler.AssociateIssueDocument, issueDocumentRequest("POST", issue, "", stale)).Want(200).JSON(&result)
	if result.Document.Version != 3 || !strings.HasPrefix(result.Document.Body, remote) {
		t.Fatal("explicit merge retry lost human prose")
	}
	testutil.Call(t, testHandler.AssociateIssueDocument, issueDocumentRequest("POST", issue, "", input)).Want(200).JSON(&result)
	if result.Document.Version != 1 {
		t.Fatal("replay followed mutable latest instead of original revision")
	}
}

func TestDocumentAssociationPreservesExistingMarkdownLinks(t *testing.T) {
	project := documentTestProject(t)
	issue := dbfx.Issue(t, "Manual Markdown links", testutil.Cols{"project_id": project})
	for _, tc := range []struct {
		body     string
		inserted bool
	}{
		{"A human paragraph.\n\n[Human label](https://example.org/source \"Manual reference\")\n", false},
		{"A code sample:\n\n```md\n[Example](https://example.org/source)\n```\n", true},
	} {
		doc := createTestDocument(t, project, "Manual source", "document")
		testutil.Call(t, testHandler.SaveProjectDocument, documentTestRequest("PUT", project, doc.ID, map[string]any{"base_version": 1, "title": doc.Title, "body": tc.body})).Want(200)
		input := issueDocumentInput(doc.ID, 2, doc.ID, map[string]any{"kind": "url", "url": "https://example.org/source"})
		input["label"] = "Artifact label"
		var result AssociateDocumentResponse
		testutil.Call(t, testHandler.AssociateIssueDocument, issueDocumentRequest("POST", issue, "", input)).Want(200).JSON(&result)
		if result.Inserted != tc.inserted || !strings.HasPrefix(result.Document.Body, tc.body) {
			t.Fatalf("manual link handling: %+v", result)
		}
		if !tc.inserted && (result.Document.Body != tc.body || result.Document.Version != 2) {
			t.Fatal("existing Markdown link was duplicated or rewritten")
		}
	}
}

func TestDocumentAssociationCompetingAppendsPreserveDraft(t *testing.T) {
	project := documentTestProject(t)
	issue := dbfx.Issue(t, "Concurrent Markdown", testutil.Cols{"project_id": project})
	doc := createTestDocument(t, project, "Concurrent", "document")
	start := make(chan struct{})
	codes := make(chan int, 2)
	var wg sync.WaitGroup
	for i := range 2 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			body := issueDocumentInput(doc.ID, 1, fmt.Sprintf("concurrent-%d", i), map[string]any{"kind": "url", "url": fmt.Sprintf("https://example.org/%d", i)})
			rec := httptest.NewRecorder()
			testHandler.AssociateIssueDocument(rec, issueDocumentRequest("POST", issue, "", body))
			codes <- rec.Code
		}(i)
	}
	close(start)
	wg.Wait()
	close(codes)
	counts := map[int]int{}
	for code := range codes {
		counts[code]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatalf("competing revisions: %v", counts)
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM project_document_revision WHERE document_id=$1", doc.ID); n != 2 {
		t.Fatal("conflict created a revision")
	}
	if n := dbfx.Count(t, "SELECT count(*) FROM project_document_source WHERE document_id=$1", doc.ID); n != 1 {
		t.Fatal("conflict created a source")
	}
}

func TestDocumentAssociationScopeAndUnavailableSources(t *testing.T) {
	project := documentTestProject(t)
	other := documentTestProject(t)
	issue := dbfx.Issue(t, "Scoped linking", testutil.Cols{"project_id": project})
	withoutProject := dbfx.Issue(t, "No project")
	doc := createTestDocument(t, project, "Scoped", "document")
	foreign := createTestDocument(t, other, "Other project", "document")
	testutil.Call(t, testHandler.AssociateIssueDocument, issueDocumentRequest("POST", withoutProject, "", issueDocumentInput(doc.ID, 1, "missing-project", nil))).Want(409)
	testutil.Call(t, testHandler.AssociateIssueDocument, issueDocumentRequest("POST", issue, "", issueDocumentInput(foreign.ID, 1, "cross-project", nil))).Want(404)
	attachment := dbfx.Insert(t, "attachment", testutil.Cols{"workspace_id": testWorkspaceID, "issue_id": issue, "uploader_type": "member", "uploader_id": testUserID, "filename": "gone.md", "url": "/missing/file.md", "content_type": "text/markdown", "size_bytes": 1})
	for i, source := range []map[string]any{
		{"kind": "url", "url": "/Users/local/report.md"}, {"kind": "url", "url": "file:///tmp/report.md"}, {"kind": "url", "url": "javascript:alert(1)"}, {"kind": "url", "url": "https://user:pass@example.org/file"}, {"kind": "url", "url": "https://example.org/>injection"},
		{"kind": "document", "document_id": foreign.ID, "document_version": 1}, {"kind": "document", "document_id": doc.ID, "document_version": 99}, {"kind": "attachment", "attachment_id": attachment},
		{"kind": "url", "url": "https://example.org", "attachment_id": attachment},
	} {
		testutil.Call(t, testHandler.AssociateIssueDocument, issueDocumentRequest("POST", issue, "", issueDocumentInput(doc.ID, 1, fmt.Sprintf("invalid-%d", i), source))).Want(422)
	}
	foreignWS, foreignProject := foreignWorkspaceWithProject(t, "assoc-foreign", "AF")
	_ = foreignWS
	foreignIssue := dbfx.Issue(t, "Foreign issue", testutil.Cols{"workspace_id": foreignWS, "project_id": foreignProject})
	testutil.Call(t, testHandler.ListIssueDocuments, issueDocumentRequest("GET", foreignIssue, "", nil)).Want(404)
	var read ProjectDocumentResponse
	testutil.Call(t, testHandler.GetProjectDocument, documentTestRequest("GET", project, doc.ID, nil)).Want(200).JSON(&read)
	if read.Version != 1 || read.Body != "" {
		t.Fatal("invalid sources mutated document")
	}
}

func TestDocumentAssociationPinnedPipelineArtifactAndDocumentRevision(t *testing.T) {
	source := strings.Replace(pipelineTestGitlab, "  instructions: Read the exact source.", "  instructions: Read the exact source.\n  artifacts: {paths: [reports/context.md]}", 1)
	source = strings.Replace(source, "  needs: [make_notes]", "  needs: [read_sources, make_notes]", 1)
	f := newPipelineFixture(t, source)
	project := documentTestProject(t)
	dbfx.Exec(t, "UPDATE issue SET project_id=$2 WHERE id=$1", f.issue, project)
	document := createTestDocument(t, project, "Published context", "spec")
	target := createTestDocument(t, project, "Delivery Markdown", "document")
	f.start(t)
	fromArtifact := map[string]any{"kind": "pipeline_artifact", "run_id": f.run, "job_id": "read_sources", "attempt": 1, "path": "reports/context.md"}
	testutil.Call(t, f.h.AssociateIssueDocument, issueDocumentRequest("POST", f.issue, "", issueDocumentInput(target.ID, 1, "declared-only", fromArtifact))).Want(422)
	task := f.report(t, "read_sources", "succeeded", []pipeline.Artifact{{Path: "reports/context.md", DocumentID: document.ID, DocumentVersion: 1}})
	f.complete(t, task)
	run := f.read(t)
	inputs := run.Job("make_notes").Current().Inputs
	if len(inputs) != 1 || inputs[0].DocumentID != document.ID || inputs[0].DocumentVersion != 1 {
		t.Fatalf("document input not pinned: %+v", inputs)
	}
	testutil.Call(t, f.h.SaveProjectDocument, documentTestRequest("PUT", project, document.ID, map[string]any{"title": "New title", "body": "New content after downstream started", "base_version": 1})).Want(200)
	var result AssociateDocumentResponse
	testutil.Call(t, f.h.AssociateIssueDocument, issueDocumentRequest("POST", f.issue, "", issueDocumentInput(target.ID, 1, "published", fromArtifact))).Want(200).JSON(&result)
	var records struct {
		Sources []DocumentSourceRecord `json:"sources"`
	}
	testutil.Call(t, f.h.ListDocumentSources, documentTestRequest("GET", project, target.ID, nil)).Want(200).JSON(&records)
	if len(records.Sources) != 1 {
		t.Fatalf("sources: %+v", records)
	}
	provenance := records.Sources[0].Source
	if provenance.TaskID != task || provenance.RunID != f.run || provenance.JobID != "read_sources" || provenance.Attempt != 1 || provenance.Artifact.DocumentVersion != 1 || !provenance.Verified || provenance.Mutable {
		t.Fatalf("lost pipeline provenance: %+v", provenance)
	}
	rec := httptest.NewRecorder()
	req := f.request("GET", "", nil)
	req.URL.RawQuery = url.Values{"artifact_id": {inputs[0].ID}}.Encode()
	f.h.DownloadPipelineArtifact(rec, req)
	if rec.Code != 200 || rec.Body.String() != document.Body {
		t.Fatalf("download followed latest: %d %s", rec.Code, rec.Body.String())
	}
	req = documentTestRequest("GET", project, document.ID, nil)
	req = testutil.WithURLParams(req, "id", project, "documentId", document.ID, "version", "1")
	var revision ProjectDocumentResponse
	testutil.Call(t, f.h.GetProjectDocumentRevision, req).Want(200).JSON(&revision)
	if revision.Body != document.Body || revision.Version != 1 {
		t.Fatal("fixed revision changed")
	}
	f.complete(t, f.report(t, "make_notes", "succeeded", nil))
	run = f.read(t)
	gate := run.Job("human_check")
	materials, available := run.Inputs(gate)
	if gate.Status != "waiting_approval" || !available || len(materials) != 1 || materials[0].DocumentVersion != 1 {
		t.Fatalf("approval material not pinned: %+v", gate)
	}
	testutil.Call(t, f.h.DecidePipelineJob, f.request("POST", "human_check", map[string]any{"decision": "approve", "expected_revision": gate.Revision, "idempotency_key": "approve-document-v1"})).Want(200)
	run = f.read(t)
	if run.Job("human_check").Decision.Materials[0].DocumentVersion != 1 {
		t.Fatal("decision lost pinned document revision")
	}
}

func TestDocumentAssociationAttachmentRepositoryAndCleanup(t *testing.T) {
	project := dbfx.Project(t, "Document relation cleanup")
	issue := dbfx.Issue(t, "Deliver real sources", testutil.Cols{"project_id": project})
	doc := createTestDocument(t, project, "Real Markdown", "document")
	h := *testHandler
	h.initPipelines(nil)
	h.Pipelines.ArtifactAvailable = func(context.Context, db.Attachment) bool { return true }
	h.Pipelines.RepositoryFile = func(_ context.Context, _, _, repo, path, ref string) (string, []byte, error) {
		if repo != "org/repo" || path != "docs/result.md" || ref != strings.Repeat("a", 40) {
			return "", nil, fmt.Errorf("unavailable")
		}
		return ref, []byte("pinned"), nil
	}
	attachment := dbfx.Insert(t, "attachment", testutil.Cols{"workspace_id": testWorkspaceID, "issue_id": issue, "uploader_type": "member", "uploader_id": testUserID, "filename": "published.md", "url": "/fake/published.md", "content_type": "text/markdown", "size_bytes": 1})
	for i, source := range []map[string]any{{"kind": "attachment", "attachment_id": attachment}, {"kind": "repository", "repo": "org/repo", "sha": strings.Repeat("a", 40), "path": "docs/result.md"}, {"kind": "document", "document_id": doc.ID, "document_version": 1}} {
		var result AssociateDocumentResponse
		testutil.Call(t, h.AssociateIssueDocument, issueDocumentRequest("POST", issue, "", issueDocumentInput(doc.ID, int32(i+1), fmt.Sprintf("source-%d", i), source))).Want(200).JSON(&result)
		if !result.Inserted || result.Document.Version != int32(i+2) {
			raw, _ := json.Marshal(result)
			t.Fatalf("real source append: %s", raw)
		}
	}
	testutil.Call(t, h.DeleteProject, testutil.WithURLParams(newRequest("DELETE", "/api/projects/"+project, nil), "id", project)).Want(204)
	for _, table := range []string{"project_document_issue", "project_document_source", "project_document_operation"} {
		if n := dbfx.Count(t, "SELECT count(*) FROM "+table+" WHERE project_id=$1", project); n != 0 {
			t.Errorf("project deletion retained %d %s", n, table)
		}
	}
}
