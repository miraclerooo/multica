package execenv

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestProjectDocumentBriefHasResolvableReference(t *testing.T) {
	const projectID = "11111111-1111-4111-8111-111111111111"
	const documentID = "22222222-2222-4222-8222-222222222222"
	brief := buildMetaSkillContent("codex", TaskContextForEnv{ProjectID: projectID, ProjectTitle: "Docs", ProjectResources: []ProjectResourceForEnv{{ID: "resource", ResourceType: "project_document", ResourceRef: json.RawMessage(`{"document_id":"` + documentID + `"}`), Label: "Current Spec"}}})
	for _, want := range []string{"multica://project/" + projectID + "/documents/" + documentID, "multica project document get " + projectID + " " + documentID, "multica project document list " + projectID, "--base-version <version>"} {
		if !strings.Contains(brief, want) {
			t.Errorf("brief missing %q", want)
		}
	}
	if strings.Contains(brief, "/specs/SPEC-01.md") {
		t.Error("brief contains a prototype-only URI")
	}
}
