import { z } from "zod";

export const PipelineErrorSchema = z.object({ code: z.string(), error: z.string() }).loose();

const LocationSchema = z.object({ line: z.number().default(0), column: z.number().default(0) });
export const PipelineDiagnosticSchema = LocationSchema.extend({
  code: z.string(), severity: z.string(), message: z.string(),
  job_id: z.string().optional(), field: z.string().optional(), suggestion: z.string().optional(),
}).loose();
export const PipelineNodeSchema = LocationSchema.extend({
  id: z.string(), source_id: z.string(), title: z.string().default(""), type: z.string(),
  stage: z.string().default(""), instructions: z.string().default(""), role: z.string().default(""),
  owner: z.string().default(""), needs: z.array(z.string()), artifact_sources: z.array(z.string()),
  paths: z.array(z.string()), when: z.string(), allow_failure: z.boolean(), retry: z.number().int().nonnegative(),
  output: z.unknown().optional(), exit_check: z.unknown().optional(),
}).loose();
export const PipelinePlanSchema = z.object({
  kind: z.string(), compiler_version: z.string(), source_hash: z.string(), stages: z.array(z.string()),
  nodes: z.array(PipelineNodeSchema),
}).loose();
export const PipelineValidationSchema = z.object({
  kind: z.string(), syntax_valid: z.boolean(), binding_valid: z.boolean().nullable(),
  diagnostics: z.array(PipelineDiagnosticSchema), plan: PipelinePlanSchema.nullable(),
}).loose();
export const PipelineCapabilitiesSchema = z.object({
  schema_version: z.number(), compiler_version: z.string(), kinds: z.array(z.string()),
  features: z.record(z.string(), z.boolean()), limits: z.record(z.string(), z.number()).default({}),
}).loose();
export const PipelineDefinitionSchema = z.object({
  id: z.string(), workspace_id: z.string(), squad_id: z.string(), revision: z.number(),
  kind: z.string(), source: z.string(), source_hash: z.string(), compiler_version: z.string(),
  plan: PipelinePlanSchema, creator_id: z.string(), created_at: z.string(),
}).loose();
export const PipelineArtifactSchema = z.object({
  id: z.string(), job_id: z.string(), attempt: z.number(), path: z.string(), status: z.string(),
  document_id: z.string().optional(), document_version: z.number().int().positive().optional(),
  attachment_id: z.string().optional(), repo: z.string().optional(), ref: z.string().optional(), sha: z.string().optional(), reason: z.string().optional(),
}).loose();
export const PipelineReportSchema = z.object({
  result: z.string(), report: z.string(), artifacts: z.array(PipelineArtifactSchema).nullable().transform(v => v ?? []),
}).loose();
export const PipelineAttemptSchema = z.object({
	usage: z.array(z.object({provider: z.string(), model: z.string(), input_tokens: z.number(), output_tokens: z.number(), cache_read_tokens: z.number(), cache_write_tokens: z.number(), cost_usd_ticks: z.number().nullable()}).loose()).nullable().optional().transform(v => v ?? []),
  number: z.number(), task_id: z.string(), executor_id: z.string(), status: z.string(),
  inputs: z.array(PipelineArtifactSchema), report: PipelineReportSchema.nullable(),
  started_at: z.string().optional(), completed_at: z.string().optional(),
}).loose();
export const PipelineDecisionSchema = z.object({
  actor_id: z.string(), decision: z.string(), reason: z.string(), job_revision: z.number(),
  materials: z.array(PipelineArtifactSchema), created_at: z.string(),
}).loose();
export const PipelineJobSchema = z.object({
  node: PipelineNodeSchema, status: z.string(), reason: z.string(), revision: z.number(), executor_id: z.string(),
  attempts: z.array(PipelineAttemptSchema), decision: PipelineDecisionSchema.nullable(),
}).loose();
export const PipelineRunSchema = z.object({
  id: z.string(), workspace_id: z.string(), issue_id: z.string(), squad_id: z.string(), definition_id: z.string(),
  creator_id: z.string(), revision: z.number(), status: z.string(), reason: z.string(), plan: PipelinePlanSchema,
  policy: z.string(), issue_title: z.string(), issue_description: z.string(), issue_revision: z.number(),
  project_id: z.string(), workflow_id: z.string(), workflow_step: z.string(), projected_status: z.string(),
  jobs: z.array(PipelineJobSchema), created_at: z.string(), updated_at: z.string(),
}).loose();
export const PipelineDefinitionListSchema = z.object({ items: z.array(PipelineDefinitionSchema), limit: z.number(), offset: z.number() }).loose();
export const PipelineRunListSchema = z.object({ items: z.array(PipelineRunSchema), limit: z.number(), offset: z.number() }).loose();
export const PipelineArtifactListSchema = z.object({ items: z.array(PipelineArtifactSchema), limit: z.number(), offset: z.number() }).loose();
export const EMPTY_PIPELINE_VALIDATION: z.infer<typeof PipelineValidationSchema> = {
  kind: "unknown", syntax_valid: false, binding_valid: null, plan: null,
  diagnostics: [{ code: "malformed_response", severity: "error", message: "Invalid pipeline response", line: 0, column: 0 }],
};
export const EMPTY_PIPELINE_CAPABILITIES: z.infer<typeof PipelineCapabilitiesSchema> = { schema_version: 0, compiler_version: "", kinds: [], features: {}, limits: {} };
export type PipelineDefinition = z.infer<typeof PipelineDefinitionSchema>;
export type PipelineRun = z.infer<typeof PipelineRunSchema>;
export type PipelineJob = z.infer<typeof PipelineJobSchema>;
export type PipelineArtifact = z.infer<typeof PipelineArtifactSchema>;
export type PipelinePlan = z.infer<typeof PipelinePlanSchema>;
export type PipelineValidation = z.infer<typeof PipelineValidationSchema>;
export type PipelineCapabilities = z.infer<typeof PipelineCapabilitiesSchema>;

export interface PipelineSourceInput { source: string; squad_id?: string }
export interface PipelineDefinitionInput extends PipelineSourceInput { squad_id: string; idempotency_key: string; activate?: boolean; expected_revision?: number }
export interface PipelineRunInput { issue_id: string; squad_id: string; definition_id?: string; idempotency_key: string }
export interface PipelineRevisionInput { expected_revision: number; idempotency_key: string }
export interface PipelineDecisionInput extends PipelineRevisionInput { decision: "approve" | "reject"; reason?: string }
export interface PipelineReportInput { attempt: number; result: "succeeded" | "failed" | "blocked"; report: string; artifacts: { path: string; attachment_id?: string; document_id?: string; document_version?: number; repo?: string; ref?: string; sha?: string }[]; idempotency_key: string }
export interface PipelineListInput { issue_id?: string; squad_id?: string; job_id?: string; limit?: number; offset?: number }
