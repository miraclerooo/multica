import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { ProjectDocumentSummary } from "../types/project";

export const projectDocumentKeys = {
  all: (wsId: string) => ["project-documents", wsId] as const,
  project: (wsId: string, projectId: string) =>
    [...projectDocumentKeys.all(wsId), projectId] as const,
  list: (wsId: string, projectId: string) =>
    [...projectDocumentKeys.project(wsId, projectId), "list"] as const,
  detail: (wsId: string, projectId: string, id: string) =>
    [...projectDocumentKeys.project(wsId, projectId), "detail", id] as const,
  save: (wsId: string, projectId: string) =>
    [...projectDocumentKeys.project(wsId, projectId), "save"] as const,
};

export function projectDocumentsOptions(
  wsId: string,
  projectId: string,
  workspaceSlug?: string,
) {
  return queryOptions({
    queryKey: projectDocumentKeys.list(wsId, projectId),
    queryFn: async () => {
      const documents = new Map<string, ProjectDocumentSummary>();
      let offset = 0,
        total = 0;
      do {
        const page = await api.listProjectDocuments(
          projectId,
          { limit: 100, offset },
          workspaceSlug,
        );
        total = page.total;
        for (const doc of page.documents) documents.set(doc.id, doc);
        if (page.documents.length === 0) break;
        offset += page.documents.length;
      } while (offset < total);
      return { documents: [...documents.values()], total };
    },
    enabled: !!wsId && !!projectId,
  });
}

export function projectDocumentOptions(
  wsId: string,
  projectId: string,
  id: string,
  workspaceSlug?: string,
) {
  return queryOptions({
    queryKey: projectDocumentKeys.detail(wsId, projectId, id),
    queryFn: () => api.getProjectDocument(projectId, id, workspaceSlug),
    enabled: !!wsId && !!projectId && !!id,
    retry: false,
  });
}
