// @vitest-environment node
import { expect, it } from "vitest";
import { parse } from "yaml";
import {
  bindPipelineRole,
  extractPipelineDraft,
  pipelineDependencies,
  pipelineUsage,
} from "./utils";
import { PipelineNodeSchema, PipelineRunSchema } from "./schema";

const node = PipelineNodeSchema.parse({
  id: "review_notes",
  source_id: "review_notes",
  type: "agent",
  needs: ["read_sources"],
  artifact_sources: ["read_sources"],
  paths: [],
  when: "on_success",
  allow_failure: false,
  retry: 0,
});
it("changes GitLab roles without replacing custom instructions or structure", () => {
  const source =
    "kind: gitlab_yaml\n# user policy\nstages: [research]\nreview_notes:\n  stage: research\n  instructions: |\n    Preserve this exact policy.\n    And this second line.\n  tags: [investigator]\n  retry: 2\n";
  const bound = bindPipelineRole(source, node, "custom reviewer");
  expect(bound).toContain("# user policy");
  expect(parse(bound).review_notes).toEqual({
    ...parse(source).review_notes,
    tags: ["custom reviewer"],
  });
  expect(parse(bindPipelineRole(bound, node, "")).review_notes.tags).toEqual(
    [],
  );
});
it("edits Hermes source state while retaining gates, metadata and entry text", () => {
  const source =
    "kind: hermes_yaml\nid: custom-flow\nroles: {researcher: {}}\ngates: {review: {type: manual}}\nstates:\n  review_notes:\n    by: researcher\n    entry: Do the user's custom work.\n    gate: review\nedges: []\n";
  expect(
    parse(bindPipelineRole(source, node, "researcher")).states.review_notes
      .entry,
  ).toBe("Do the user's custom work.");
  const leader = bindPipelineRole(source, node, "");
  expect(parse(leader).states.review_notes.by).toBeUndefined();
  expect(parse(leader).gates).toEqual(parse(source).gates);
  expect(() =>
    bindPipelineRole(source, { ...node, type: "manual" }, "owner"),
  ).toThrow();
});
it.each([
  { name: "missing roles", declaration: "" },
  { name: "empty roles", declaration: "roles: {} # keep role policy\n" },
  {
    name: "another declared role",
    declaration: "roles:\n  researcher: {} # keep researcher\n",
  },
])("declares a selected Hermes role with $name", ({ declaration }) => {
  const source = `kind: hermes_yaml
# user workflow
id: custom-flow
${declaration}states:
  review_notes:
    entry: |
      Preserve this exact policy.
      And this second line.
    artifacts: [reports/context.md]
    retry: 2
edges: []
`;
  const original = parse(source);
  const bound = bindPipelineRole(source, node, "reviewer");
  expect(parse(bound)).toEqual({
    ...original,
    roles: { ...original.roles, reviewer: {} },
    states: {
      ...original.states,
      review_notes: { ...original.states.review_notes, by: "reviewer" },
    },
  });
  expect(bound).toContain("# user workflow");
  if (declaration.includes("#")) {
    expect(bound).toContain(declaration.split("#")[1]!.trim());
  }
});
it("preserves existing Hermes declarations and other users of a role when rebinding or choosing the leader", () => {
  const source = `kind: hermes_yaml
roles:
  reviewer: &reviewer {} # keep this declaration
states:
  review_notes:
    by: reviewer # keep binding comment
    entry: Preserve the original instruction.
  publish:
    by: reviewer
    entry: Publish the reviewed result.
edges: [{from: review_notes, to: publish}]
`;
  const original = parse(source);
  const existing = bindPipelineRole(source, node, "reviewer");
  expect(parse(existing)).toEqual(original);
  expect(existing).toContain("&reviewer");
  expect(existing).toContain("# keep this declaration");
  expect(existing).toContain("# keep binding comment");
  const reassigned = bindPipelineRole(existing, node, "writer");
  const rebound = bindPipelineRole(reassigned, node, "reviewer");
  expect(parse(rebound).roles).toEqual({ reviewer: {}, writer: {} });
  expect(parse(rebound).states.publish).toEqual(original.states.publish);
  const leader = parse(bindPipelineRole(rebound, node, ""));
  expect(leader.roles).toEqual({ reviewer: {}, writer: {} });
  expect(leader.states.review_notes).toEqual({
    entry: original.states.review_notes.entry,
  });
  expect(leader.states.publish).toEqual(original.states.publish);
  expect(leader.edges).toEqual(original.edges);
});
it("counts a dependency once when it also supplies materials", () => {
  expect(pipelineDependencies(node)).toEqual(["read_sources"]);
});
it("aggregates unique attempts and retains unknown pricing", () => {
  const attempt = {
    number: 1,
    task_id: "task",
    executor_id: "agent",
    status: "completed",
    inputs: [],
    report: null,
    usage: [
      {
        provider: "custom",
        model: "unpriced",
        input_tokens: 12,
        output_tokens: 7,
        cache_read_tokens: 3,
        cache_write_tokens: 2,
        cost_usd_ticks: null,
      },
    ],
  };
  const run = PipelineRunSchema.parse({
    id: "r",
    workspace_id: "w",
    issue_id: "i",
    squad_id: "s",
    definition_id: "d",
    creator_id: "m",
    revision: 1,
    status: "succeeded",
    reason: "",
    plan: {
      kind: "gitlab_yaml",
      compiler_version: "1",
      source_hash: "hash",
      stages: [],
      nodes: [],
    },
    policy: "",
    issue_title: "custom",
    issue_description: "",
    issue_revision: 1,
    project_id: "p",
    workflow_id: "",
    workflow_step: "",
    projected_status: "in_review",
    jobs: [
      {
        node,
        status: "succeeded",
        reason: "",
        revision: 1,
        executor_id: "agent",
        attempts: [
          attempt,
          attempt,
          {
            ...attempt,
            number: 2,
            task_id: "task-2",
            usage: [{ ...attempt.usage[0], cost_usd_ticks: 100 }],
          },
        ],
        decision: null,
      },
    ],
    created_at: "now",
    updated_at: "now",
  });
  expect(pipelineUsage(run)).toEqual({
    tokens: 48,
    ticks: 100,
    unpriced: true,
    attempts: 2,
  });
});
it("rejects a Mika response that changes the selected dialect or contains invalid YAML", () => {
  expect(
    extractPipelineDraft(
      "```yaml\nkind: gitlab_yaml\nstages: []\n```",
      "hermes_yaml",
    ),
  ).toBeNull();
  expect(
    extractPipelineDraft(
      "```yaml\nkind: hermes_yaml\nstates: [\n```",
      "hermes_yaml",
    ),
  ).toBeNull();
  expect(
    extractPipelineDraft(
      "```yaml\nkind: hermes_yaml\nstates: {}\n```",
      "hermes_yaml",
    ),
  ).toContain("kind: hermes_yaml");
});
