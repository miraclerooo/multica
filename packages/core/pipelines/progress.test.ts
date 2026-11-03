// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { PipelineNodeSchema, PipelineRunSchema } from "./schema";
import { choosePipelineProgressRun, pipelineProgress } from "./progress";
import {
  expandPipelineProgressStages,
  selectPipelineProgressRun,
  usePipelineProgressStore,
} from "./progress-store";

function snapshot(statuses: string[], runStatus = "running") {
  const nodes = statuses.map((_, i) =>
    PipelineNodeSchema.parse({
      id: `n${i}`,
      source_id: `n${i}`,
      title: `Node ${i}`,
      stage: i % 2 ? "second" : "first",
      type: "agent",
      needs: [],
      artifact_sources: [],
      paths: [],
      when: "on_success",
      retry: 2,
      allow_failure: true,
    }),
  );
  return PipelineRunSchema.parse({
    id: "r",
    workspace_id: "w",
    issue_id: "i",
    squad_id: "s",
    definition_id: "d",
    creator_id: "human",
    revision: 1,
    status: runStatus,
    reason: "",
    plan: {
      kind: "gitlab_yaml",
      compiler_version: "2",
      source_hash: "original",
      stages: ["first", "second"],
      nodes,
    },
    policy: "",
    issue_title: "Original",
    issue_description: "",
    issue_revision: 1,
    project_id: "",
    workflow_id: "",
    workflow_step: "",
    projected_status: "",
    jobs: nodes.map((node, i) => ({
      node,
      status: statuses[i],
      reason: "",
      revision: 1,
      executor_id: "a",
      attempts: [],
      decision: null,
    })),
    created_at: "2026-11-03T00:00:00Z",
    updated_at: "2026-11-03T00:00:00Z",
  });
}
afterEach(() => usePipelineProgressStore.getState().clearDraft());
it("retains declared empty stages in frozen plan order", () => {
  const run = snapshot(["running", "succeeded"]);
  run.plan.stages = ["first", "empty", "second"];
  expect(
    pipelineProgress(run).groups.map((group) => [
      group.stage,
      group.nodes.length,
    ]),
  ).toEqual([
    ["first", 1],
    ["empty", 0],
    ["second", 1],
  ]);
});
it.each([
  {
    statuses: ["failed", "skipped", "skipped", "skipped"],
    expected: {
      succeeded: 0,
      failed: 1,
      skipped: 3,
      unfinished: 0,
      unknown: 0,
    },
  },
  {
    statuses: ["succeeded", "failed", "succeeded", "waiting_approval"],
    expected: { succeeded: 2, failed: 1, unfinished: 1 },
  },
  {
    statuses: ["cancelled", "rejected", "pending", "ready"],
    expected: { succeeded: 0, cancelled: 1, rejected: 1, unfinished: 2 },
  },
  {
    statuses: ["queued", "running", "blocked", "waiting_approval"],
    expected: { succeeded: 0, unfinished: 4 },
  },
  {
    statuses: ["future_policy_hold", ""],
    expected: { succeeded: 0, unknown: 2, unfinished: 0 },
  },
  { statuses: [], expected: { succeeded: 0, total: 0, unknown: 0 } },
])(
  "counts frozen nodes for $statuses without treating other terminal states as success",
  ({ statuses, expected }) => {
    const result = pipelineProgress(snapshot(statuses));
    expect(result.counts).toMatchObject({
      total: statuses.length,
      ...expected,
    });
  },
);
it("uses frozen stage order and node names independently of job ordering and attempts", () => {
  const run = snapshot(["running", "waiting_approval", "succeeded"]);
  run.jobs.reverse();
  run.jobs.find((j) => j.node.id === "n0")!.attempts = [
    {
      number: 2,
      task_id: "current",
      executor_id: "a",
      status: "running",
      inputs: [],
      report: null,
      usage: [],
    },
    {
      number: 1,
      task_id: "old",
      executor_id: "a",
      status: "failed",
      inputs: [],
      report: null,
      usage: [],
    },
  ];
  const result = pipelineProgress(run);
  expect(
    result.groups.map((g) => [g.stage, g.nodes.map((n) => n.node.title)]),
  ).toEqual([
    ["first", ["Node 0", "Node 2"]],
    ["second", ["Node 1"]],
  ]);
  expect(result.nodes[0]?.attempt?.task_id).toBe("current");
  expect(result.counts.total).toBe(3);
  expect(result.counts.failed).toBe(0);
});
it("renders one ordered node list when the frozen plan has no stages", () => {
  const run = snapshot(["succeeded", "blocked"]);
  run.plan.kind = "hermes_yaml";
  run.plan.stages = [];
  expect(
    pipelineProgress(run).groups.map((g) => g.nodes.map((n) => n.node.id)),
  ).toEqual([["n0", "n1"]]);
});
it("keeps unknown run and incomplete node snapshots uncertain", () => {
  const run = snapshot(["succeeded"], "future_policy_hold");
  expect(pipelineProgress(run)).toMatchObject({
    uncertain: true,
    counts: { succeeded: 1, total: 1 },
  });
  run.status = "succeeded";
  run.jobs = [];
  expect(pipelineProgress(run)).toMatchObject({
    uncertain: true,
    counts: { succeeded: 0, unknown: 1, total: 1 },
  });
});
it("does not count extra job records or duplicate frozen identities as additional successes", () => {
  const run = snapshot(["failed"]);
  run.jobs.push({
    ...run.jobs[0]!,
    node: { ...run.jobs[0]!.node, id: "extra" },
    status: "succeeded",
  });
  expect(pipelineProgress(run)).toMatchObject({
    uncertain: true,
    counts: { succeeded: 0, failed: 1, total: 1 },
  });
});
it("defaults to the newest active instance, otherwise latest, and never replaces an explicit historical selection", () => {
  const latest = {
    ...snapshot([]),
    id: "latest",
    created_at: "2026-11-03T03:00:00Z",
    status: "succeeded",
  };
  const active = {
    ...latest,
    id: "active",
    created_at: "2026-11-03T02:00:00Z",
    status: "waiting_approval",
  };
  const oldest = {
    ...active,
    id: "old",
    created_at: "2026-11-03T01:00:00Z",
    status: "running",
  };
  expect(choosePipelineProgressRun([oldest, latest, active])?.id).toBe(
    "active",
  );
  expect(choosePipelineProgressRun([latest, active], "latest")?.id).toBe(
    "latest",
  );
  expect(
    choosePipelineProgressRun([latest, active], "unavailable"),
  ).toBeUndefined();
  expect(
    choosePipelineProgressRun([latest, { ...active, status: "cancelled" }])?.id,
  ).toBe("latest");
});
it("isolates explicit runs and expanded groups by workspace, issue and run", () => {
  selectPipelineProgressRun("w:i", "old");
  selectPipelineProgressRun("w:other", "new");
  selectPipelineProgressRun("other:i", "private");
  expandPipelineProgressStages("w:i:old", ["deep"]);
  expandPipelineProgressStages("w:i:new", []);
  expect(usePipelineProgressStore.getState().draft).toEqual({
    runs: { "w:i": "old", "w:other": "new", "other:i": "private" },
    expanded: { "w:i:old": ["deep"], "w:i:new": [] },
  });
});
