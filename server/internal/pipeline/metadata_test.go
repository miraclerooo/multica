package pipeline

import (
	"encoding/json"
	"strings"
	"testing"
)

const metadataAgent = "15cfc7a3-afd0-4fb4-9802-df6714172a91"
const metadataOwner = "a3d005d9-0871-4375-9f01-85a8f4a02e63"

func TestPipelineMetadataBothDialects(t *testing.T) {
	for _, kind := range []string{"gitlab_yaml", "hermes_yaml"} {
		t.Run(kind, func(t *testing.T) {
			entry, head := "instructions", "kind: gitlab_yaml\nstages: [work]\nnode_1:\n  stage: work\n"
			if kind == "hermes_yaml" {
				entry, head = "entry", "kind: hermes_yaml\nstates:\n  node_1:\n"
			}
			indent := "  "
			if kind == "hermes_yaml" {
				indent = "    "
			}
			source := head + indent + "title: Research notes\n" + indent + "agent_id: " + strings.ToUpper(metadataAgent) + "\n" + indent + "owner_user_id: " + metadataOwner + "\n" + indent + entry + ": |\n" + indent + "  Full instructions.\n" + indent + "  Keep this line.\n" + indent + "artifacts:\n" + indent + "  paths: [legacy/full.md]\n" + indent + "  files:\n" + indent + "    - name: plan.md\n" + indent + "      path: reports/plan.md\n" + indent + "      description: |+\n" + indent + "        First paragraph.\n\n" + indent + "        Second paragraph.\n\n" + indent + "    - name: plan.md\n" + indent + "      path: alternate/plan.md\n" + indent + "      description: Different evidence.\n"
			v := Compile(source)
			if !v.SyntaxValid {
				t.Fatalf("%+v", v.Diagnostics)
			}
			n := v.Plan.Nodes[0]
			if n.ID != "node_1" || n.Title != "Research notes" || n.AgentID != metadataAgent || n.OwnerUserID != metadataOwner || n.Instructions != "Full instructions.\nKeep this line.\n" || len(n.Deliverables) != 3 || n.Deliverables[1].Description != "First paragraph.\n\nSecond paragraph.\n\n" || n.Paths[2] != "alternate/plan.md" {
				t.Fatalf("lost metadata: %+v", n)
			}
			renamed := Compile(strings.Replace(source, "title: Research notes", "title: New display only", 1))
			if renamed.Plan.Nodes[0].ID != n.ID || renamed.Plan.Nodes[0].SourceID != n.SourceID || strings.Join(renamed.Plan.Nodes[0].Paths, ",") != strings.Join(n.Paths, ",") {
				t.Fatal("display name changed references")
			}
			r := NewRun(*v.Plan, map[string]string{n.ID: metadataAgent, "owner:" + n.ID: metadataOwner})
			if r.Jobs[0].ExecutorID != metadataAgent || r.Jobs[0].OwnerID != metadataOwner {
				t.Fatal("bindings not frozen")
			}
			a := r.Artifacts()
			if len(a) != 3 || a[1].Status != "declared" || a[1].ID != "" || a[1].Description != n.Deliverables[1].Description || a[1].Path == a[2].Path {
				t.Fatalf("declarations changed: %+v", a)
			}
			if !strings.Contains(r.Brief(&r.Jobs[0]), "Expected deliverables (declarations, not delivered evidence)") {
				t.Fatal("brief lacks expected materials")
			}
			if !strings.Contains(r.Brief(&r.Jobs[0]), n.Deliverables[1].Description) {
				t.Fatal("task brief flattened multiline file explanation")
			}
			b, _ := json.Marshal(r)
			var reloaded Run
			if e := json.Unmarshal(b, &reloaded); e != nil || reloaded.Plan.Nodes[0].Deliverables[1].Description != n.Deliverables[1].Description {
				t.Fatal("snapshot reload lost paragraphs")
			}
		})
	}
}

func TestPipelineMetadataRejectsAmbiguityAndUnknownFields(t *testing.T) {
	base := "kind: gitlab_yaml\nstages: [work]\njob:\n  stage: work\n  instructions: do work\n"
	cases := map[string]string{
		"bad agent":          "  agent_id: not-a-uuid\n",
		"bad owner":          "  owner_user_id: 00000000-0000-0000-0000-000000000000\n",
		"two executors":      "  tags: [leader]\n  agent_id: " + metadataAgent + "\n",
		"two owners":         "  owner: old-owner\n  owner_user_id: " + metadataOwner + "\n",
		"manual executor":    "  when: manual\n  agent_id: " + metadataAgent + "\n",
		"multiline filename": "  artifacts:\n    files: [{name: \"a\\nb.md\"}]\n",
		"duplicate paths":    "  artifacts:\n    paths: [a.md]\n    files: [{name: a.md}]\n",
		"traversal":          "  artifacts:\n    files: [{name: a.md, path: ../a.md}]\n",
		"unknown nested":     "  artifacts:\n    files: [{name: a.md, unknown: {secret: keep}}]\n",
		"closed when":        "  when: always\n",
	}
	for name, suffix := range cases {
		t.Run(name, func(t *testing.T) {
			v := Compile(base + suffix)
			if v.SyntaxValid || v.Plan != nil || len(v.Diagnostics) == 0 {
				t.Fatalf("invalid metadata accepted: %+v", v)
			}
		})
	}
}
