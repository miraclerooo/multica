import { z } from "zod";
import { parseWithFallback } from "../api/schema";

export const ProjectDocumentSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().min(1),
  project_id: z.string().min(1),
  kind: z.enum(["spec", "document"]).catch("document"),
  title: z.string(),
  body: z.string(),
  version: z.number().int().positive(),
  base_version: z.number().int().nonnegative(),
  author_type: z.string().default("unknown"),
  author_id: z.string().default(""),
  author_name: z.string().default(""),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
  resource_uri: z.string().default(""),
});

export type ProjectDocument = z.infer<typeof ProjectDocumentSchema>;
export type DocumentSnapshot = Pick<
  ProjectDocument,
  "title" | "body" | "version"
>;
export interface CreateDocumentInput {
  title: string;
  kind: "spec" | "document";
  body?: string;
}
export interface SaveDocumentInput {
  title: string;
  body: string;
  base_version: number;
}

export const DocumentListSchema = z.object({
  documents: z.array(ProjectDocumentSchema).default([]),
  total: z.number().default(0),
});
export const DocumentHistorySchema = z.object({
  revisions: z.array(ProjectDocumentSchema).default([]),
  total: z.number().default(0),
});
export const DocumentConflictSchema = z.object({
  code: z.literal("document_version_conflict"),
  latest: ProjectDocumentSchema,
});

export const ProjectResourceSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  workspace_id: z.string(),
  resource_type: z.string(),
  resource_ref: z.record(z.string(), z.unknown()).default({}),
  label: z.string().nullable().default(null),
  position: z.number().default(0),
  created_at: z.string().default(""),
  created_by: z.string().nullable().default(null),
});
export const ProjectResourceListSchema = z.object({
  resources: z.array(ProjectResourceSchema).default([]),
  total: z.number().default(0),
});

export function parseDocumentResponse(
  raw: unknown,
  endpoint: string,
): ProjectDocument {
  const document = parseWithFallback<ProjectDocument | null>(
    raw,
    ProjectDocumentSchema,
    null,
    { endpoint },
  );
  // An unacknowledged write must leave the local draft available for retry.
  if (!document) throw new Error("Invalid document response");
  return document;
}
