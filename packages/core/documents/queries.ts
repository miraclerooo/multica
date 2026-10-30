import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { projectKeys } from "../projects/queries";
import {
  acknowledgeDocumentSave,
  failDocumentSave,
  type DocumentDraft,
} from "./drafts";
import {
  DocumentConflictSchema,
  type ProjectDocument,
  type CreateDocumentInput,
} from "./schema";

export const documentKeys = {
  all: (wsId: string, projectId: string) =>
    [...projectKeys.detail(wsId, projectId), "documents"] as const,
  list: (wsId: string, projectId: string) =>
    [...documentKeys.all(wsId, projectId), "list"] as const,
  detail: (wsId: string, projectId: string, id: string) =>
    [...documentKeys.all(wsId, projectId), id] as const,
  history: (wsId: string, projectId: string, id: string) =>
    [...documentKeys.detail(wsId, projectId, id), "history"] as const,
};
export function documentListOptions(wsId: string, projectId: string) {
  return queryOptions({
    queryKey: documentKeys.list(wsId, projectId),
    queryFn: () => api.listProjectDocuments(projectId),
    select: (data) => data.documents,
  });
}
export function documentDetailOptions(
  wsId: string,
  projectId: string,
  id: string,
) {
  return queryOptions({
    queryKey: documentKeys.detail(wsId, projectId, id),
    queryFn: () => api.getProjectDocument(projectId, id),
    enabled: !!id,
  });
}
export function documentHistoryOptions(
  wsId: string,
  projectId: string,
  id: string,
) {
  return queryOptions({
    queryKey: documentKeys.history(wsId, projectId, id),
    queryFn: () => api.listProjectDocumentRevisions(projectId, id),
    select: (data) => data.revisions,
    enabled: !!id,
  });
}
export function useCreateDocument(wsId: string, projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDocumentInput) =>
      api.createProjectDocument(projectId, input),
    onSuccess: (doc) => {
      qc.setQueryData(documentKeys.detail(wsId, projectId, doc.id), doc);
      void qc.invalidateQueries({
        queryKey: projectKeys.detail(wsId, projectId),
      });
    },
  });
}
export function useSaveDocument(wsId: string, projectId: string, id: string) {
  const qc = useQueryClient();
  const adopt = (doc: ProjectDocument) =>
    qc.setQueryData<ProjectDocument>(
      documentKeys.detail(wsId, projectId, id),
      (old) => (!old || old.version <= doc.version ? doc : old),
    );
  return useMutation({
    mutationKey: ["save-project-document", wsId, projectId, id],
    mutationFn: ({
      draft,
      baseVersion,
    }: {
      key: string;
      draft: DocumentDraft;
      baseVersion?: number;
    }) =>
      api.saveProjectDocument(projectId, id, {
        title: draft.title,
        body: draft.body,
        base_version: baseVersion ?? draft.base.version,
      }),
    onSuccess: (saved, { key, draft }) => {
      adopt(saved);
      acknowledgeDocumentSave(key, draft, saved);
    },
    onError: (error, { key }) => {
      const conflict =
        error instanceof ApiError && error.status === 409
          ? DocumentConflictSchema.safeParse(error.body)
          : null;
      if (conflict?.success) adopt(conflict.data.latest);
      failDocumentSave(
        key,
        conflict?.success ? "conflict" : "failed",
        error instanceof Error ? error.message : "Save failed",
      );
    },
    onSettled: () => {
      void qc.invalidateQueries({
        queryKey: documentKeys.all(wsId, projectId),
      });
      void qc.invalidateQueries({
        queryKey: [...projectKeys.detail(wsId, projectId), "resources"],
      });
    },
  });
}
