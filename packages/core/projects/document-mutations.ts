import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { getCurrentWsId } from "../platform/workspace-storage";
import type {
  CreateProjectDocumentRequest,
  Project,
  ProjectDocument,
  ProjectDocumentMetadata,
  MemberWithUser,
} from "../types";
import {
  documentDraftKey,
  documentFields,
  equalDocumentFields,
  readDocumentDraft,
  validDocumentFields,
  writeDocumentDraft,
  type DocumentProblem,
} from "./document-drafts";
import {
  projectDocumentKeys,
  projectDocumentOptions,
} from "./document-queries";

export function documentProblem(error: unknown): DocumentProblem {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      const body = error.body as { current_revision?: unknown } | undefined;
      return {
        kind: "conflict",
        revision:
          typeof body?.current_revision === "number"
            ? body.current_revision
            : undefined,
      };
    }
    if (error.status === 401 || error.status === 403)
      return { kind: "forbidden" };
    if (error.status === 404) return { kind: "missing" };
    if (error.status === 400 || error.status === 413)
      return { kind: "invalid" };
  }
  return { kind: "network" };
}

export function canDeleteProjectDocument(
  doc: ProjectDocumentMetadata,
  project: Project,
  userId: string | undefined,
  members: MemberWithUser[],
) {
  if (!userId) return false;
  const member = members.find((m) => m.user_id === userId);
  return (
    !!member &&
    (doc.created_by === userId ||
      (project.lead_type === "member" && project.lead_id === userId) ||
      member.role === "owner" ||
      member.role === "admin")
  );
}

const saves = new WeakMap<QueryClient, Map<string, Promise<boolean>>>();

async function adoptSaved(
  qc: QueryClient,
  wsId: string,
  projectId: string,
  doc: ProjectDocument,
) {
  const key = projectDocumentKeys.detail(wsId, projectId, doc.id);
  await qc.cancelQueries({ queryKey: key });
  qc.setQueryData<ProjectDocument>(key, (old) =>
    old && old.revision > doc.revision ? old : doc,
  );
  void qc.invalidateQueries({
    queryKey: projectDocumentKeys.list(wsId, projectId),
  });
}

/** One queue per document survives component unmounts, mode switches and pins. */
export function flushProjectDocument(
  qc: QueryClient,
  wsId: string,
  projectId: string,
  id: string,
  workspaceSlug?: string,
): Promise<boolean> {
  const key = documentDraftKey(wsId, projectId, id);
  let queue = saves.get(qc);
  if (!queue) {
    queue = new Map();
    saves.set(qc, queue);
  }
  const pending = queue.get(key);
  if (pending) return pending;
  const run = async () => {
    while (getCurrentWsId() === wsId) {
      const draft = readDocumentDraft(key);
      if (!draft) return true;
      if (draft.problem) return false;
      if (!validDocumentFields(draft)) {
        writeDocumentDraft(wsId, key, {
          ...draft,
          problem: { kind: "invalid" },
        });
        return false;
      }
      const cached = qc.getQueryData<ProjectDocument>(
        projectDocumentKeys.detail(wsId, projectId, id),
      );
      if (
        cached?.revision === draft.revision &&
        equalDocumentFields(cached, draft)
      ) {
        writeDocumentDraft(wsId, key);
        return true;
      }
      try {
        const saved = await api.updateProjectDocument(
          projectId,
          id,
          { revision: draft.revision, ...documentFields(draft) },
          workspaceSlug,
        );
        await adoptSaved(qc, wsId, projectId, saved);
        if (getCurrentWsId() !== wsId) return false;
        const current = readDocumentDraft(key);
        if (!current) return true;
        // Typing during the request belongs to the next serialized revision.
        if (equalDocumentFields(current, draft)) writeDocumentDraft(wsId, key);
        else
          writeDocumentDraft(wsId, key, {
            ...current,
            revision: saved.revision,
            problem: undefined,
          });
      } catch (error) {
        const current = readDocumentDraft(key);
        if (current)
          writeDocumentDraft(wsId, key, {
            ...current,
            problem: documentProblem(error),
          });
        void qc.invalidateQueries({
          queryKey: projectDocumentKeys.detail(wsId, projectId, id),
        });
        return false;
      }
    }
    return false;
  };
  const promise = run().finally(() => queue.delete(key));
  queue.set(key, promise);
  return promise;
}

/** Refetch before retrying an ambiguous write. Never rebase a conflicting draft. */
export async function retryProjectDocument(
  qc: QueryClient,
  wsId: string,
  projectId: string,
  id: string,
  workspaceSlug?: string,
) {
  const key = documentDraftKey(wsId, projectId, id);
  try {
    const remote = await qc.fetchQuery({
      ...projectDocumentOptions(wsId, projectId, id, workspaceSlug),
      staleTime: 0,
    });
    const draft = readDocumentDraft(key);
    if (!draft) return true;
    if (equalDocumentFields(remote, draft)) {
      writeDocumentDraft(wsId, key);
      return true;
    }
    if (remote.revision !== draft.revision) {
      writeDocumentDraft(wsId, key, {
        ...draft,
        problem: { kind: "conflict", revision: remote.revision },
      });
      return false;
    }
    writeDocumentDraft(wsId, key, { ...draft, problem: undefined });
    return flushProjectDocument(qc, wsId, projectId, id, workspaceSlug);
  } catch (error) {
    const draft = readDocumentDraft(key);
    if (draft)
      writeDocumentDraft(wsId, key, {
        ...draft,
        problem: documentProblem(error),
      });
    return false;
  }
}

export function useSaveProjectDocument(
  wsId: string,
  projectId: string,
  workspaceSlug?: string,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: projectDocumentKeys.save(wsId, projectId),
    mutationFn: (id: string) =>
      flushProjectDocument(qc, wsId, projectId, id, workspaceSlug),
    retry: false,
  });
}
export function useRetryProjectDocument(
  wsId: string,
  projectId: string,
  workspaceSlug?: string,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: projectDocumentKeys.save(wsId, projectId),
    mutationFn: (id: string) =>
      retryProjectDocument(qc, wsId, projectId, id, workspaceSlug),
    retry: false,
  });
}

export function useCreateProjectDocument(
  wsId: string,
  projectId: string,
  workspaceSlug?: string,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateProjectDocumentRequest) =>
      api.createProjectDocument(projectId, data, workspaceSlug),
    retry: false,
    onSuccess: (doc) => adoptSaved(qc, wsId, projectId, doc),
  });
}
export function useDeleteProjectDocument(
  wsId: string,
  projectId: string,
  workspaceSlug?: string,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, revision }: { id: string; revision: number }) =>
      api.deleteProjectDocument(projectId, id, revision, workspaceSlug),
    retry: false,
    onSuccess: async (_, { id }) => {
      await qc.cancelQueries({
        queryKey: projectDocumentKeys.project(wsId, projectId),
      });
      qc.removeQueries({
        queryKey: projectDocumentKeys.detail(wsId, projectId, id),
      });
      writeDocumentDraft(wsId, documentDraftKey(wsId, projectId, id));
      void qc.invalidateQueries({
        queryKey: projectDocumentKeys.list(wsId, projectId),
      });
    },
  });
}
