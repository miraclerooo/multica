import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { projectKeys } from "../projects/queries";
import { documentKeys } from "./queries";
import { DocumentConflictSchema, type ProjectDocument } from "./schema";
import type { AssociateDocumentInput, DocumentListInput } from "./associations";

export function documentGroupsOptions(wsId: string, projectId: string, filters: DocumentListInput = {}) {
  return queryOptions({
    queryKey: [...documentKeys.all(wsId, projectId), "groups", filters],
    queryFn: () => api.listProjectDocumentGroups(projectId, filters),
  });
}

export function issueDocumentsOptions(wsId: string, projectId: string, issueId: string) {
  return queryOptions({
    queryKey: [...documentKeys.all(wsId, projectId), "issue", issueId],
    queryFn: () => api.listIssueDocuments(issueId),
    enabled: !!issueId,
  });
}

export function documentSourcesOptions(wsId: string, projectId: string, id: string) {
  return queryOptions({
    queryKey: [...documentKeys.detail(wsId, projectId, id), "sources"],
    queryFn: () => api.listProjectDocumentSources(projectId, id),
    enabled: !!id,
  });
}

export function documentRevisionOptions(wsId: string, projectId: string, id: string, version: number) {
  return queryOptions({
    queryKey: [...documentKeys.detail(wsId, projectId, id), "revision", version],
    queryFn: () => api.getProjectDocumentRevision(projectId, id, version),
    enabled: !!id && version > 0,
  });
}

export function useAssociateDocument(wsId: string, projectId: string, issueId: string) {
  const qc = useQueryClient();
  const adopt = (doc: ProjectDocument) => qc.setQueryData<ProjectDocument>(
    documentKeys.detail(wsId, projectId, doc.id),
    old => !old || old.version <= doc.version ? doc : old,
  );
  return useMutation({
    mutationFn: (input: AssociateDocumentInput) => api.associateIssueDocument(issueId, input),
    onSuccess: result => adopt(result.document),
    onError: error => {
      const conflict = error instanceof ApiError && error.status === 409
        ? DocumentConflictSchema.safeParse(error.body) : null;
      if (conflict?.success) adopt(conflict.data.latest);
      // Drafts are independent of this mutation and survive every conflict.
    },
    onSettled: () => qc.invalidateQueries({ queryKey: projectKeys.detail(wsId, projectId) }),
  });
}

export function useUnlinkDocument(wsId: string, projectId: string, issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => api.unlinkIssueDocument(issueId, documentId),
    onSuccess: () => qc.invalidateQueries({ queryKey: documentKeys.all(wsId, projectId) }),
  });
}
