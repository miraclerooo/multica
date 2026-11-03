// @vitest-environment node
import { expect, it } from "vitest";
import { PipelineRunSchema } from "./schema";
import { pipelineRunActions } from "./utils";

function snapshot(status = "waiting_approval", type = "manual", jobStatus = "waiting_approval") {
  const node = {
    id: "review", source_id: "review", type, needs: [], artifact_sources: [],
    paths: [], when: type === "manual" ? "manual" : "on_success", allow_failure: false, retry: 0,
  };
  return PipelineRunSchema.parse({
    id: "run", workspace_id: "ws", issue_id: "issue", squad_id: "s", definition_id: "d",
    creator_id: "human", revision: 1, status, reason: "",
    plan: { kind: "gitlab_yaml", compiler_version: "1", source_hash: "hash", stages: ["review"], nodes: [node] },
    policy: "", issue_title: "Review", issue_description: "", issue_revision: 1,
    project_id: "", workflow_id: "", workflow_step: "", projected_status: "in_review",
    jobs: [{ node, status: jobStatus, reason: "", revision: 1, executor_id: "", attempts: [], decision: null }],
    created_at: "", updated_at: "",
  });
}

it.each(["queued", "running", "waiting_approval", "blocked"])(
  "allows a waiting gate in the known active run state %s",
  (status) => {
    const run = snapshot(status);
    expect(pipelineRunActions(run, run.jobs[0])).toMatchObject({
      restriction: null, decide: true, cancel: true, retry: false,
    });
  },
);

it.each(["on_success", "on_failure"])("allows a gate alongside a compiler v1 %s agent", (when) => {
  const run = snapshot("running");
  const worker = { ...run.jobs[0]!.node, id: "worker", source_id: "worker", type: "agent", when };
  run.plan.nodes.push(worker);
  run.jobs.push({ ...run.jobs[0]!, node: worker, status: "running" });
  expect(pipelineRunActions(run, run.jobs[0])).toMatchObject({
    restriction: null, decide: true, cancel: true,
  });
});

it.each(["failed", "succeeded", "cancelled", "cancelling", "rejected"])(
  "never approves or cancels a %s run",
  (status) => {
    const run = snapshot(status);
    expect(pipelineRunActions(run, run.jobs[0])).toMatchObject({ decide: false, cancel: false });
  },
);

it.each(["queued", "running", "waiting_approval", "blocked", "failed", "succeeded"])(
  "preserves retry of a failed agent in a known %s run",
  (status) => {
    const run = snapshot(status, "agent", "failed");
    expect(pipelineRunActions(run, run.jobs[0]).retry).toBe(true);
  },
);

it.each(["cancelled", "cancelling", "rejected"])("does not retry a %s run", (status) => {
  const run = snapshot(status, "agent", "failed");
  expect(pipelineRunActions(run, run.jobs[0]).retry).toBe(false);
});

it.each([
  { field: "status", value: "future_policy_hold", code: "status" },
  { field: "kind", value: "future_yaml", code: "plan" },
  { field: "compiler_version", value: "future", code: "plan" },
  { field: "node_type", value: "future_gate", code: "plan" },
  { field: "when", value: "future_condition", code: "plan" },
  { field: "when", value: "always", code: "plan" },
  { field: "job_status", value: "future_node_hold", code: "job_status" },
])("blocks all run writes for unknown $field while preserving its value", ({ field, value, code }) => {
  const run = snapshot("running");
  if (field === "status") run.status = value;
  else if (field === "kind") run.plan.kind = value;
  else if (field === "compiler_version") run.plan.compiler_version = value;
  else if (field === "node_type") run.plan.nodes[0]!.type = value;
  else if (field === "when") run.jobs[0]!.node.when = value;
  else run.jobs[0]!.status = value;
  const actions = pipelineRunActions(run, run.jobs[0]);
  expect(actions).toMatchObject({ decide: false, retry: false, cancel: false });
  expect(actions.restriction?.code).toBe(code);
  expect(actions.restriction?.value).toContain(value);
  run.jobs[0]!.node.type = "agent";
  if (field !== "job_status") run.jobs[0]!.status = "failed";
  expect(pipelineRunActions(run, run.jobs[0]).retry).toBe(false);
});

it("supports Hermes plans and does not offer a second decision", () => {
  const run = snapshot();
  run.plan.kind = "hermes_yaml";
  expect(pipelineRunActions(run, run.jobs[0]).decide).toBe(true);
  run.jobs[0]!.decision = {
    actor_id: "human", decision: "approve", reason: "", job_revision: 1, materials: [], created_at: "",
  };
  expect(pipelineRunActions(run, run.jobs[0]).decide).toBe(false);
});
