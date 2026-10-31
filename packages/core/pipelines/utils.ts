import { parseDocument } from "yaml";
import type { PipelinePlan, PipelineRun } from "./schema";

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
  if (pipelineSourceKind(source) === "hermes_yaml") {
    if (node.type === "manual")
      throw new Error("Manual gates do not bind an executor");
    if (role) {
      if (!doc.hasIn(["roles", role])) doc.setIn(["roles", role], {});
      doc.setIn(["states", node.source_id, "by"], role);
    } else doc.deleteIn(["states", node.source_id, "by"]);
  } else {
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
