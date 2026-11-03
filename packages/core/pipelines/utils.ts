import { parseDocument } from "yaml";
import type { PipelineJob, PipelinePlan, PipelineRun } from "./schema";

const activeRunStatuses = new Set(["queued", "running", "waiting_approval", "blocked"]);
const knownRunStatuses = new Set([
  ...activeRunStatuses, "succeeded", "failed", "cancelling", "cancelled", "rejected",
]);
const knownJobStatuses = new Set([
  "pending", "ready", "queued", "running", "waiting_approval", "blocked",
  "succeeded", "failed", "skipped", "cancelled", "rejected",
]);

type PipelineWriteRestriction = {
  code: "status" | "plan" | "job_status";
  value: string;
};

// Keep unfamiliar snapshots readable, but never infer write semantics from
// the absence of a known terminal state. Compiler 2 adds metadata and stable
// identities; scheduling states and approval permissions retain v1 semantics.
export function pipelineRunActions(run: PipelineRun, job?: PipelineJob) {
  let restriction: PipelineWriteRestriction | null = null;
  if (!["gitlab_yaml", "hermes_yaml"].includes(run.plan.kind)) {
    restriction = { code: "plan", value: run.plan.kind };
  } else if (!["1", "2"].includes(run.plan.compiler_version)) {
    restriction = { code: "plan", value: `compiler_version=${run.plan.compiler_version}` };
  } else if (!knownRunStatuses.has(run.status)) {
    restriction = { code: "status", value: run.status };
  } else {
    for (const node of [...run.plan.nodes, ...run.jobs.map((j) => j.node)]) {
      if (!["agent", "manual"].includes(node.type)) {
        restriction = { code: "plan", value: `node.type=${node.type}` };
        break;
      }
      if (!["on_success", "on_failure", "manual"].includes(node.when)) {
        restriction = { code: "plan", value: `node.when=${node.when}` };
        break;
      }
    }
    const unknownJob = run.jobs.find((j) => !knownJobStatuses.has(j.status));
    if (!restriction && unknownJob) {
      restriction = { code: "job_status", value: `${unknownJob.node.id}: ${unknownJob.status}` };
    }
  }
  const active = !restriction && activeRunStatuses.has(run.status);
  return {
    restriction,
    cancel: active,
    decide: active && job?.node.type === "manual" && job.status === "waiting_approval" && !job.decision,
    retry: !restriction && (active || ["failed", "succeeded"].includes(run.status)) &&
      job?.node.type === "agent" && ["failed", "blocked"].includes(job.status),
  };
}

export function pipelineSourceKind(source: string): string {
  try {
    return String(parseDocument(source).get("kind") ?? "gitlab_yaml");
  } catch {
    return "unknown";
  }
}

// Edit the binding and its required declaration in the user's document,
// preserving comments, instructions and structure through the YAML model.
export function bindPipelineRole(
  source: string,
  node: PipelinePlan["nodes"][number],
  role: string,
): string {
  const doc = parseDocument(source);
  if (doc.errors.length) throw doc.errors[0];
  if (node.type === "manual") throw new Error("Manual gates do not bind an executor");
  if (pipelineSourceKind(source) === "hermes_yaml") {
    doc.deleteIn(["states",node.source_id,"agent_id"]);
    if (role) {
      if (!doc.hasIn(["roles", role])) doc.setIn(["roles", role], {});
      doc.setIn(["states", node.source_id, "by"], role);
    } else doc.deleteIn(["states", node.source_id, "by"]);
  } else {
    doc.deleteIn([node.source_id,"agent_id"]);
    doc.setIn([node.source_id, "tags"], role ? [role] : []);
  }
  return doc.toString();
}

export function pipelineUsage(run: PipelineRun) {
  let tokens = 0;
  let ticks = 0;
  let unpriced = false;
  let attempts = 0;
  const seen = new Set<string>();
  for (const job of run.jobs)
    for (const attempt of job.attempts) {
      const key = attempt.task_id || `${job.node.id}:${attempt.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      attempts++;
      if (!attempt.usage.length) unpriced = true;
      for (const usage of attempt.usage) {
        tokens +=
          usage.input_tokens +
          usage.output_tokens +
          usage.cache_read_tokens +
          usage.cache_write_tokens;
        if (usage.cost_usd_ticks == null) unpriced = true;
        else ticks += usage.cost_usd_ticks;
      }
    }
  return { tokens, ticks, unpriced: unpriced || !attempts, attempts };
}

export function pipelineDependencies(
  node: PipelinePlan["nodes"][number],
): string[] {
  return [...new Set([...node.needs, ...node.artifact_sources])];
}

export function extractPipelineDraft(
  content: string,
  kind: string,
): string | null {
  const blocks = [...content.matchAll(/```(?:yaml|yml)\s*\n([\s\S]*?)```/g)];
  const source = blocks.at(-1)?.[1];
  if (!source || pipelineSourceKind(source) !== kind) return null;
  const doc = parseDocument(source);
  return doc.errors.length ? null : source;
}
