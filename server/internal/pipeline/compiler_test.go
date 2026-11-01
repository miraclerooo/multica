package pipeline

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const customGitlab = `kind: gitlab_yaml
stages: [gather, publish, approval]
read_sources:
  stage: gather
  tags: [研究员]
  instructions: |
    Preserve these exact instructions.
    Keep the original source text.
  artifacts: {paths: [reports/context.md]}
make_notes:
  stage: publish
  tags: [研究员]
  needs: [read_sources]
  instructions: Write notes.
confirm_notes:
  stage: approval
  needs: [make_notes]
  when: manual
  allow_failure: false
`
const customHermes = `kind: hermes_yaml
id: research
name: research
version: 1.0.0
roles: {研究员: {}}
gates: {confirm_notes: {type: manual}}
states:
  read_sources:
    by: 研究员
    entry: |
      Preserve these exact instructions.
      Keep the original source text.
    artifacts: {paths: [reports/context.md]}
  make_notes:
    by: 研究员
    entry: Write notes.
    gate: confirm_notes
edges:
  - {from: read_sources, to: make_notes, type: forward}
`

func TestDialectSemanticParity(t *testing.T) {
	g, h := Compile(customGitlab), Compile(customHermes)
	if !g.SyntaxValid || !h.SyntaxValid {
		t.Fatalf("GitLab: %+v; Hermes: %+v", g.Diagnostics, h.Diagnostics)
	}
	if len(g.Plan.Nodes) != 3 || len(h.Plan.Nodes) != 3 {
		t.Fatal("custom three-node workflow changed")
	}
	for i := range g.Plan.Nodes {
		a, b := g.Plan.Nodes[i], h.Plan.Nodes[i]
		if a.Type != b.Type || a.Role != b.Role || a.Instructions != b.Instructions || strings.Join(a.Paths, ",") != strings.Join(b.Paths, ",") || strings.Join(a.Needs, ",") != strings.Join(b.Needs, ",") {
			t.Fatalf("node %d semantics differ: %+v / %+v", i, a, b)
		}
		if a.Line < 1 || b.Line < 1 {
			t.Fatal("missing source location")
		}
	}
	if h.Kind != "hermes_yaml" || h.Plan.SourceHash == g.Plan.SourceHash {
		t.Fatal("source kind/hash lost")
	}
}

func TestCompilerRejectsUnsupportedAndInvalidSource(t *testing.T) {
	cases := []struct{ name, source, code string }{
		{"syntax", "a: [", "invalid_yaml"},
		{"multi_document", customGitlab + "---\na: b\n", "invalid_yaml"},
		{"duplicate", customGitlab + "read_sources: {}\n", "duplicate_key"},
		{"runner_script", strings.Replace(customGitlab, "  instructions: Write notes.", "  script: echo nope", 1), "unknown_field"},
		{"unknown_kind", strings.Replace(customGitlab, "gitlab_yaml", "other", 1), "unsupported_capability"},
		{"cycle", strings.Replace(customGitlab, "needs: [read_sources]", "needs: [make_notes]", 1), "cyclic_dependency"},
		{"unknown_need", strings.Replace(customGitlab, "needs: [read_sources]", "needs: [missing]", 1), "unknown_need"},
		{"unknown_stage", strings.Replace(customGitlab, "stage: gather", "stage: elsewhere", 1), "unknown_stage"},
		{"role_array", strings.Replace(customGitlab, "tags: [研究员]", "tags: [one, two]", 1), "unsupported_capability"},
		{"ambiguous_artifacts", strings.Replace(customGitlab, "needs: [read_sources]", "needs: [read_sources]\n  dependencies: []", 1), "unsupported_capability"},
		{"glob", strings.Replace(customGitlab, "reports/context.md", "reports/*.md", 1), "unsupported_capability"},
		{"traversal", strings.Replace(customGitlab, "reports/context.md", "../context.md", 1), "unsupported_capability"},
		{"hermes_route", strings.Replace(customHermes, "type: forward", "type: rollback", 1), "unsupported_capability"},
		{"hermes_role", strings.Replace(customHermes, "by: 研究员", "by: missing", 1), "role_unbound"},
		{"alias", "kind: gitlab_yaml\nstages: &a [one]\njob: *a\n", "unsupported_capability"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := Compile(tc.source)
			if v.SyntaxValid || v.Plan != nil {
				t.Fatal("invalid source compiled")
			}
			for _, d := range v.Diagnostics {
				if d.Code == tc.code {
					return
				}
			}
			t.Fatalf("missing %s: %+v", tc.code, v.Diagnostics)
		})
	}
}

func TestStageBarrierAndExplicitEmptyNeeds(t *testing.T) {
	source := `stages: [a, b]
first: {stage: a, instructions: one}
parallel: {stage: a, instructions: two}
barrier: {stage: b, instructions: three, dependencies: []}
independent: {stage: b, instructions: four, needs: []}
`
	v := Compile(source)
	if !v.SyntaxValid {
		t.Fatal(v.Diagnostics)
	}
	if len(v.Plan.Nodes[2].Needs) != 2 || len(v.Plan.Nodes[2].ArtifactSources) != 0 || len(v.Plan.Nodes[3].Needs) != 0 {
		t.Fatalf("wrong barrier/needs semantics: %+v", v.Plan)
	}
}

func TestShippedTemplatesCompile(t *testing.T) {
	files, err := filepath.Glob("../../../docs/pipelines/examples/*.yaml")
	if err != nil || len(files) != 4 {
		t.Fatalf("examples: %v %v", files, err)
	}
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		v := Compile(string(data))
		if !v.SyntaxValid {
			t.Fatalf("%s: %+v", file, v.Diagnostics)
		}
	}
}
