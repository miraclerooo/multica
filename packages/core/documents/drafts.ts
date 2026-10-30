import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";
import type { DocumentSnapshot } from "./schema";

const DraftSchema = z.object({
  base: z.object({
    title: z.string(),
    body: z.string(),
    version: z.number().int().positive(),
  }),
  title: z.string(),
  body: z.string(),
  status: z.enum(["dirty", "failed", "conflict"]),
  error: z.string().optional(),
});
export type DocumentDraft = z.infer<typeof DraftSchema>;

export const useDocumentDraftStore = createDraftStore<{
  drafts: Record<string, DocumentDraft>;
}>({
  storageKey: "multica_document_drafts",
  emptyData: { drafts: {} },
  workspaceScoped: false,
  hasMeaningful: (data) => Object.keys(data.drafts).length > 0,
  migrateData: (data) => {
    const parsed = z
      .object({ drafts: z.record(z.string(), DraftSchema) })
      .safeParse(data);
    return parsed.success ? parsed.data : { drafts: {} };
  },
});

export function documentDraftKey(
  wsId: string,
  projectId: string,
  documentId: string,
): string {
  return `${wsId}:${projectId}:${documentId}`;
}

export function putDocumentDraft(
  key: string,
  draft: DocumentDraft | undefined,
): void {
  const state = useDocumentDraftStore.getState();
  const drafts = { ...state.draft.drafts };
  if (draft) drafts[key] = draft;
  else delete drafts[key];
  state.setDraft({ drafts });
}

export function editDocumentDraft(
  key: string,
  base: DocumentSnapshot,
  patch: Partial<Pick<DocumentDraft, "title" | "body">>,
): void {
  const current = useDocumentDraftStore.getState().draft.drafts[key];
  const next: DocumentDraft = {
    ...(current ?? { base, title: base.title, body: base.body, status: "dirty" }),
    ...patch,
  };
  if (
    next.title === next.base.title &&
    next.body === next.base.body &&
    next.status !== "conflict"
  )
    putDocumentDraft(key, undefined);
  else putDocumentDraft(key, next);
}

export function acknowledgeDocumentSave(
  key: string,
  submitted: DocumentDraft,
  saved: DocumentSnapshot,
): void {
  const current = useDocumentDraftStore.getState().draft.drafts[key];
  if (!current || current.base.version !== submitted.base.version) return;
  if (current.title === submitted.title && current.body === submitted.body)
    putDocumentDraft(key, undefined);
  else
    putDocumentDraft(key, {
      ...current,
      base: { title: saved.title, body: saved.body, version: saved.version },
      status: "dirty",
      error: undefined,
    });
}

export function failDocumentSave(
  key: string,
  status: "failed" | "conflict",
  error: string,
): void {
  const current = useDocumentDraftStore.getState().draft.drafts[key];
  if (current) putDocumentDraft(key, { ...current, status, error });
}
