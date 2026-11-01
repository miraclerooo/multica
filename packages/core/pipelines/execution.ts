import { z } from "zod";

export const RuntimeBuildSchema = z.object({
  version: z.string().default(""), commit: z.string().default(""),
  build_commit: z.string().optional(),
  capabilities: z.array(z.string()).nullable().optional().transform(v => v ?? []),
  release_channel: z.string().default("unknown"), upgrade_guide_url: z.string().default(""),
}).loose();

export const RuntimeCompatibilitySchema = z.object({
  runtime_id: z.string(), name: z.string().default(""), agent_ids: z.array(z.string()).default([]),
  status: z.string().default("unknown"), reason: z.string().default("build_report_unavailable"),
  required_capabilities: z.array(z.string()).default([]), missing_capabilities: z.array(z.string()).default([]),
  daemon: RuntimeBuildSchema.default({version: "", commit: "", capabilities: [], release_channel: "unknown", upgrade_guide_url: ""}),
  disk: RuntimeBuildSchema.nullable().default(null), disk_reason: z.string().default("disk_probe_unavailable"),
  build_relation: z.string().default("unknown"), reload_pending_reason: z.string().default(""),
  load_state: z.string().default("unknown"),
  reported_at: z.string().default(""), upgrade_action: z.string().default("channel_not_configured"),
  upgrade_guide_url: z.string().default(""),
}).loose();

export const ExecutionReadinessSchema = z.object({
  ready: z.boolean().default(false), runtimes: z.array(RuntimeCompatibilitySchema).default([]),
}).loose();
export const IssueExecutionSchema = z.object({
  requested_mode: z.string(), mode: z.string(), squad_id: z.string(),
  pipeline_id: z.string().optional(), pipeline_name: z.string().optional(),
  definition_id: z.string().optional(), definition_revision: z.number().optional(),
  creator_id: z.string(), bindings: z.record(z.string(), z.string()).optional(), policy: z.string().default(""),
  state: z.string().default("waiting_runtime"),
  readiness: ExecutionReadinessSchema.default({ready: false, runtimes: []}),
}).loose();
export type IssueExecution = z.infer<typeof IssueExecutionSchema>;
export type ExecutionReadiness = z.infer<typeof ExecutionReadinessSchema>;
export type RuntimeCompatibility = z.infer<typeof RuntimeCompatibilitySchema>;
export const PIPELINE_SELECTION_CAPABILITY = "pipeline-task-selection-v1";

export type ExecutionSelection =
  | { mode: "default" | "markdown"; pipeline_id?: never; definition_id?: never }
  | { mode: "pipeline"; pipeline_id: string; definition_id?: string };

// Explicit pipeline choices submit the previewed version, never a newer catalog pointer.
export function selectionFromPreview(selection: ExecutionSelection, preview: IssueExecution | null | undefined): ExecutionSelection | null {
  if (!preview || preview.requested_mode !== selection.mode || !["markdown", "pipeline"].includes(preview.mode) ||
      !["waiting_runtime", "ready", "started"].includes(preview.state)) return null;
  if (selection.mode !== "pipeline") return { mode: selection.mode };
  if (preview.mode !== "pipeline" || preview.pipeline_id !== selection.pipeline_id || !preview.definition_id ||
      (selection.definition_id && selection.definition_id !== preview.definition_id)) return null;
  return {mode: "pipeline", pipeline_id: selection.pipeline_id, definition_id: preview.definition_id};
}

export function safeUpgradeGuide(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

export function canStartIssueExecution(execution: IssueExecution | null | undefined): boolean {
  return execution?.mode === "pipeline" && !!execution.pipeline_id && !!execution.definition_id &&
    (execution.state === "ready" || execution.state === "waiting_runtime") &&
    execution.readiness.ready === true && execution.readiness.runtimes.every(r => r.status === "supported" &&
      r.daemon.capabilities.includes(PIPELINE_SELECTION_CAPABILITY) && r.disk?.capabilities.includes(PIPELINE_SELECTION_CAPABILITY) === true);
}

// Opaque receipt key; it carries no identity or authorization information.
export function newExecutionRequestKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
