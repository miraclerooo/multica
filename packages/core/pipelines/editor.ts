import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";

const DraftSchema = z.object({
  source: z.string(),
  baseId: z.string(),
  baseRevision: z.number().optional(),
  operationKey: z.string(),
  name: z.string().optional(),
  catalogRevision: z.number().optional(),
});
export const usePipelineDraftStore = createDraftStore<{
  drafts: Record<string, z.infer<typeof DraftSchema>>;
}>({
  storageKey: "multica_pipeline_drafts",
  workspaceScoped: false,
  emptyData: { drafts: {} },
  hasMeaningful: (data) => Object.keys(data.drafts).length > 0,
  migrateData: (data) => {
    const result = z
      .object({ drafts: z.record(z.string(), DraftSchema) })
      .safeParse(data);
    return result.success ? result.data : { drafts: {} };
  },
});
export function putPipelineDraft(
  key: string,
  source: string,
  baseId = "",
  baseRevision?: number,
  metadata?: {name?: string; catalogRevision?: number},
) {
  const state = usePipelineDraftStore.getState();
  state.setDraft({
    drafts: {
      ...state.draft.drafts,
      [key]: {
        ...state.draft.drafts[key],
        ...metadata,
        catalogRevision: state.draft.drafts[key]?.catalogRevision ?? metadata?.catalogRevision,
        source,
        baseId,
        baseRevision: state.draft.drafts[key]?.baseRevision ?? baseRevision,
        operationKey: crypto.randomUUID(),
      },
    },
  });
}
export function clearPipelineDraft(key: string) {
  const state = usePipelineDraftStore.getState();
  const drafts = { ...state.draft.drafts };
  delete drafts[key];
  state.setDraft({ drafts });
}

// A migrated squad history has one catalog identity, not one identity per version.
export function adoptLegacyPipelineDraft(from: string, to: string) {
  movePipelineDraftScope(from, to, true);
}

const ReviewSchema = z.object({ reason: z.string(), revision: z.number() });
export const usePipelineReviewStore = createDraftStore<{
  opinions: Record<string, z.infer<typeof ReviewSchema>>;
  selections: Record<string, string>;
}>({
  storageKey: "multica_pipeline_reviews",
  workspaceScoped: false,
  emptyData: { opinions: {}, selections: {} },
  hasMeaningful: (value) =>
    Object.keys(value.opinions).length > 0 ||
    Object.keys(value.selections).length > 0,
  migrateData: (value) => {
    const parsed = z
      .object({
        opinions: z.record(z.string(), ReviewSchema),
        selections: z.record(z.string(), z.string()),
      })
      .safeParse(value);
    return parsed.success ? parsed.data : { opinions: {}, selections: {} };
  },
});
export function selectPipelineNode(key: string, nodeId: string) {
  const state = usePipelineReviewStore.getState();
  if (state.draft.selections[key] !== nodeId)
    state.setDraft({
      selections: { ...state.draft.selections, [key]: nodeId },
    });
}
export function editPipelineReview(
  key: string,
  reason: string,
  revision: number,
) {
  const state = usePipelineReviewStore.getState();
  const opinions = { ...state.draft.opinions };
  if (reason) opinions[key] = { reason, revision };
  else delete opinions[key];
  state.setDraft({ opinions });
}

export function reviewPipelineDraft(key: string, revision: number, catalogRevision?: number) {
  const state = usePipelineDraftStore.getState();
  const draft = state.draft.drafts[key];
  if (draft)
    state.setDraft({
      drafts: {
        ...state.draft.drafts,
        [key]: { ...draft, baseRevision: revision, catalogRevision: catalogRevision ?? draft.catalogRevision },
      },
    });
}

const WorkbenchSchema = z.object({
  sessionId: z.string(),
  request: z.string(),
});
export const usePipelineWorkbenchStore = createDraftStore<{
  entries: Record<string, z.infer<typeof WorkbenchSchema>>;
}>({
  storageKey: "multica_pipeline_workbench",
  workspaceScoped: false,
  emptyData: { entries: {} },
  hasMeaningful: (data) =>
    Object.values(data.entries).some(
      (value) => !!value.sessionId || !!value.request,
    ),
  migrateData: (value) => {
    const parsed = z
      .object({ entries: z.record(z.string(), WorkbenchSchema) })
      .safeParse(value);
    return parsed.success ? parsed.data : { entries: {} };
  },
});
export function editPipelineWorkbench(
  key: string,
  patch: Partial<z.infer<typeof WorkbenchSchema>>,
) {
  const state = usePipelineWorkbenchStore.getState();
  state.setDraft({
    entries: {
      ...state.draft.entries,
      [key]: {
        ...(state.draft.entries[key] ?? {sessionId: "", request: ""}),
        ...patch,
      },
    },
  });
}

export function movePipelineDraftScope(from: string, to: string, legacy = false) {
  if (from === to) return;
  const state = usePipelineDraftStore.getState();
  const drafts = {...state.draft.drafts};
  const belongs = (key: string) => key === from || (legacy
    ? ["retained", "gitlab_yaml", "hermes_yaml"].some(suffix => key === `${from}:${suffix}` || key.startsWith(`${from}:${suffix}:`))
    : key.startsWith(`${from}:`));
  let changed = false;
  for (const [key, draft] of Object.entries(state.draft.drafts)) {
    const target = to + key.slice(from.length);
    if (belongs(key) && !drafts[target]) {drafts[target] = draft;delete drafts[key];changed = true;}
  }
  if (changed) state.setDraft({drafts});
  const workbench = usePipelineWorkbenchStore.getState();
  if (workbench.draft.entries[from] && !workbench.draft.entries[to]) {
    const entries = {...workbench.draft.entries, [to]: workbench.draft.entries[from]!};
    delete entries[from];workbench.setDraft({entries});
  }
}
