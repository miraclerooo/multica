import type { PipelineJob, PipelineNodeSchema, PipelineRun } from "./schema";
import type { z } from "zod";
import { pipelineRunActions } from "./utils";

export const pipelineProgressStatuses = [
  "pending",
  "ready",
  "queued",
  "running",
  "waiting_approval",
  "blocked",
  "cancelling",
  "succeeded",
  "failed",
  "rejected",
  "skipped",
  "cancelled",
] as const;
export type PipelineProgressStatus = (typeof pipelineProgressStatuses)[number];
export function knownPipelineProgressStatus(
  status: string,
): status is PipelineProgressStatus {
  return (pipelineProgressStatuses as readonly string[]).includes(status);
}
export function isActivePipelineRun(run: Pick<PipelineRun, "status">) {
  return [
    "queued",
    "running",
    "waiting_approval",
    "blocked",
    "cancelling",
  ].includes(run.status);
}
export function choosePipelineProgressRun(
  runs: PipelineRun[],
  explicitId?: string,
) {
  if (explicitId) return runs.find((run) => run.id === explicitId);
  const newest = [...runs].sort(
    (a, b) =>
      b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
  );
  return newest.find(isActivePipelineRun) ?? newest[0];
}
export type PipelineProgressNode = {
  node: z.infer<typeof PipelineNodeSchema>;
  job: PipelineJob | undefined;
  status: string;
  attempt: PipelineJob["attempts"][number] | undefined;
};
export function pipelineProgressCounts(
  nodes: Pick<PipelineProgressNode, "status">[],
) {
  const counts = {
    total: nodes.length,
    succeeded: 0,
    failed: 0,
    rejected: 0,
    skipped: 0,
    cancelled: 0,
    unfinished: 0,
    unknown: 0,
  };
  for (const { status } of nodes) {
    if (
      status === "succeeded" ||
      status === "failed" ||
      status === "rejected" ||
      status === "skipped" ||
      status === "cancelled"
    )
      counts[status]++;
    else if (knownPipelineProgressStatus(status)) counts.unfinished++;
    else counts.unknown++;
  }
  return counts;
}
export function pipelineProgress(run: PipelineRun) {
  const jobs = new Map(run.jobs.map((job) => [job.node.id, job]));
  const nodes = run.plan.nodes.map((node) => {
    const job = jobs.get(node.id);
    return {
      node,
      job,
      status: job?.status ?? "",
      attempt: job?.attempts.reduce<
        PipelineJob["attempts"][number] | undefined
      >(
        (current, attempt) =>
          !current || attempt.number > current.number ? attempt : current,
        undefined,
      ),
    };
  });
  const stages = run.plan.stages.length
    ? [
        ...new Set([
          ...run.plan.stages,
          ...nodes.map((item) => item.node.stage),
        ]),
      ]
    : [""];
  const groups = stages
    .map((stage) => ({
      stage,
      nodes: run.plan.stages.length
        ? nodes.filter((item) => item.node.stage === stage)
        : nodes,
    }))
    .filter(
      (group) => group.nodes.length || run.plan.stages.includes(group.stage),
    );
  const counts = pipelineProgressCounts(nodes);
  const inconsistent =
    new Set(run.plan.nodes.map((n) => n.id)).size !== nodes.length ||
    new Set(run.jobs.map((j) => j.node.id)).size !== run.jobs.length ||
    run.jobs.some((j) => !run.plan.nodes.some((n) => n.id === j.node.id));
  return {
    nodes,
    groups,
    counts,
    uncertain:
      inconsistent ||
      counts.unknown > 0 ||
      !!pipelineRunActions(run).restriction,
  };
}
export function pipelineNodeNeedsAttention(item: PipelineProgressNode) {
  return (
    !knownPipelineProgressStatus(item.status) ||
    [
      "ready",
      "queued",
      "running",
      "waiting_approval",
      "blocked",
      "cancelling",
      "failed",
      "rejected",
    ].includes(item.status)
  );
}
