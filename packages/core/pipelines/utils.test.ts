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
