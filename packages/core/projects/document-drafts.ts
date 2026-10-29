import { createDraftStore } from "../drafts/create-draft-store";
import { getCurrentWsId } from "../platform/workspace-storage";
import type { ProjectDocument } from "../types/project";

export type DocumentFields = Pick<
  ProjectDocument,
  "title" | "content" | "is_pinned" | "position"
>;
export type DocumentProblem = {
  kind: "conflict" | "forbidden" | "missing" | "network" | "invalid";
  revision?: number;
};
export type ProjectDocumentDraft = DocumentFields & {
  revision: number;
  problem?: DocumentProblem;
};

export const useProjectDocumentDraftStore = createDraftStore<{
  entries: Record<string, ProjectDocumentDraft>;
}>({
  storageKey: "multica_project_document_drafts",
  emptyData: { entries: {} },
  hasMeaningful: ({ entries }) => Object.keys(entries).length > 0,
});

export const documentDraftKey = (
  wsId: string,
  projectId: string,
  documentId: string,
) => `${wsId}:${projectId}:${documentId}`;
export function documentFields(doc: DocumentFields): DocumentFields {
  return {
    title: doc.title,
    content: doc.content,
    is_pinned: doc.is_pinned,
    position: doc.position,
  };
}
export function equalDocumentFields(a: DocumentFields, b: DocumentFields) {
  return (
    a.title.trim() === b.title.trim() &&
    a.content === b.content &&
    a.is_pinned === b.is_pinned &&
    a.position === b.position
  );
}
export function validDocumentFields(doc: DocumentFields) {
  const title = doc.title.trim();
  return (
    title.length > 0 &&
    [...title].length <= 200 &&
    !title.includes("\0") &&
    !doc.content.includes("\0") &&
    new TextEncoder().encode(doc.content).length <= 1024 * 1024
  );
}
export function readDocumentDraft(
  key: string,
): ProjectDocumentDraft | undefined {
  return useProjectDocumentDraftStore.getState().draft.entries[key];
}
export function writeDocumentDraft(
  wsId: string,
  key: string,
  value?: ProjectDocumentDraft,
) {
  // A late save must not write into the newly active workspace's storage.
  if (getCurrentWsId() !== wsId) return;
  const store = useProjectDocumentDraftStore.getState();
  const entries = { ...store.draft.entries };
  if (value) entries[key] = value;
  else delete entries[key];
  store.setDraft({ entries });
}
export function editDocumentDraft(
  wsId: string,
  doc: ProjectDocument,
  patch: Partial<DocumentFields>,
) {
  const key = documentDraftKey(wsId, doc.project_id, doc.id);
  const current = readDocumentDraft(key);
  const draft = {
    ...(current ?? { ...documentFields(doc), revision: doc.revision }),
    ...patch,
  };
  if (draft.problem?.kind === "invalid") delete draft.problem;
  writeDocumentDraft(wsId, key, draft);
}
