import { z } from "zod";
import { parseWithFallback } from "../api/schema";
import type { ListProjectDocumentsResponse, ProjectDocument } from "../types/project";

const ProjectDocumentMetadataSchema = z.object({
  id: z.string().min(1),
  workspace_id: z.string().min(1),
  project_id: z.string().min(1),
  title: z.string(),
  is_pinned: z.boolean().default(false),
  position: z.number().int().default(0),
  revision: z.number().int().positive(),
  created_by: z.string(),
  updated_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
}).loose();

export const ProjectDocumentSchema = ProjectDocumentMetadataSchema.extend({
  content: z.string(),
});

export const ListProjectDocumentsResponseSchema = z.object({
  documents: z.array(ProjectDocumentMetadataSchema.extend({ excerpt: z.string().default("") })),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
}).loose();

// A missing revision or content cannot be replaced with a successful empty
// document: an editor would mistake that for saved content on its next flush.
export function parseProjectDocument(data: unknown, endpoint: string): ProjectDocument {
  const parsed = parseWithFallback<ProjectDocument | null>(data, ProjectDocumentSchema, null, { endpoint });
  if (parsed === null) throw new Error(`Malformed response from ${endpoint}`);
  return parsed;
}

export function parseProjectDocuments(data: unknown, endpoint: string): ListProjectDocumentsResponse {
  const parsed = parseWithFallback<ListProjectDocumentsResponse | null>(data, ListProjectDocumentsResponseSchema, null, { endpoint });
  if (parsed === null) throw new Error(`Malformed response from ${endpoint}`);
  return parsed;
}
