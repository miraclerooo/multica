import { z } from "zod";
import { parseWithFallback } from "../api/schema";
import { PipelineArtifactSchema } from "../pipelines/schema";
import { DocumentListSchema, ProjectDocumentSchema, type CreateDocumentInput } from "./schema";

export type DocumentSourceInput =
  | { kind: "attachment"; attachment_id: string }
  | { kind: "document"; document_id: string; document_version: number }
  | { kind: "pipeline_artifact"; run_id: string; job_id: string; attempt: number; path: string }
  | { kind: "repository"; repo: string; sha: string; path: string }
  | { kind: "url"; url: string };

export type AssociateDocumentInput = {
  base_version: number;
  idempotency_key: string;
  source?: DocumentSourceInput;
  label?: string;
  description?: string;
} & (
  | { document_id: string; create_document?: never }
  | { document_id?: never; create_document: CreateDocumentInput }
);

export interface DocumentListInput { issue_id?: string; q?: string }

export const DocumentSourceSchema = z.object({
  kind: z.string(),
  issue_id: z.string().min(1),
  attachment_id: z.string().optional(),
  document_id: z.string().optional(),
  document_version: z.number().int().positive().optional(),
  run_id: z.string().optional(),
  job_id: z.string().optional(),
  attempt: z.number().int().positive().optional(),
  path: z.string().optional(),
  repo: z.string().optional(),
  sha: z.string().optional(),
  url: z.string().optional(),
  task_id: z.string().optional(),
  artifact: PipelineArtifactSchema.optional(),
  label: z.string(),
  description: z.string().optional(),
  href: z.string().min(1),
  verified: z.boolean().default(false),
  mutable: z.boolean().default(true),
  markdown: z.string(),
});

export const DocumentSourceRecordSchema = z.object({
  source_key: z.string().min(1),
  document_version: z.number().int().positive(),
  source: DocumentSourceSchema,
});
export const DocumentSourcesSchema = z.object({
  sources: z.array(DocumentSourceRecordSchema).default([]),
  total: z.number().int().nonnegative().default(0),
});
export const DocumentIssueGroupSchema = z.object({
  issue_id: z.string().nullable(),
  identifier: z.string().default(""),
  title: z.string(),
  count: z.number().int().nonnegative(),
  documents: z.array(ProjectDocumentSchema),
});
export const DocumentReferenceSchema = z.object({
  document_id: z.string().min(1),
  issue_id: z.string().min(1),
  document_version: z.number().int().positive(),
  sources: z.array(DocumentSourceRecordSchema),
});
export const DocumentCollectionSchema = DocumentListSchema.extend({
  groups: z.array(DocumentIssueGroupSchema).default([]),
  references: z.array(DocumentReferenceSchema).default([]),
});
export const AssociateDocumentResponseSchema = z.object({
  document: ProjectDocumentSchema,
  inserted: z.boolean(),
  replayed: z.boolean(),
  linked: z.boolean(),
});
export type DocumentCollection = z.infer<typeof DocumentCollectionSchema>;
export type DocumentSources = z.infer<typeof DocumentSourcesSchema>;
export type AssociateDocumentResponse = z.infer<typeof AssociateDocumentResponseSchema>;

export function parseAssociationResponse(raw: unknown): AssociateDocumentResponse {
  const result = parseWithFallback<AssociateDocumentResponse | null>(
    raw, AssociateDocumentResponseSchema, null, { endpoint: "POST issue documents" },
  );
  if (!result) throw new Error("Invalid document association response");
  return result;
}
