import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";

const DraftSchema = z.object({
  source: z.string(),
  baseId: z.string(),
  baseRevision: z.number().optional(),
  operationKey: z.string(),
  name: z.string().optional(),
  catalogRevision: z.number().optional(),
  past: z.array(z.string()).optional(),
  future: z.array(z.string()).optional(),
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
  metadata?: {
    name?: string;
    catalogRevision?: number;
    previousSource?: string;
  },
) {
  const state = usePipelineDraftStore.getState();
  const previous = state.draft.drafts[key];
  const before = previous?.source ?? metadata?.previousSource;
  const changed = before !== undefined && before !== source;
  state.setDraft({
    drafts: {
      ...state.draft.drafts,
      [key]: {
        ...state.draft.drafts[key],
        ...(metadata?.name !== undefined ? { name: metadata.name } : {}),
        catalogRevision:
          state.draft.drafts[key]?.catalogRevision ?? metadata?.catalogRevision,
        source,
        baseId,
        baseRevision: state.draft.drafts[key]?.baseRevision ?? baseRevision,
        operationKey: crypto.randomUUID(),
        past: changed
          ? boundedHistory([...(previous?.past ?? []), before])
          : previous?.past,
        future: changed ? [] : previous?.future,
      },
    },
  });
}

function boundedHistory(values: string[]) {
  const result = values.slice(-20);
  while (
    result.length > 1 &&
    result.reduce((bytes, value) => bytes + value.length * 2, 0) > 1_048_576
  )
    result.shift();
  return result;
}

export function stepPipelineHistory(key: string, direction: "undo" | "redo") {
  const state = usePipelineDraftStore.getState();
  const draft = state.draft.drafts[key];
  if (!draft) return;
  const history = direction === "undo" ? draft.past : draft.future;
  const source = history?.at(-1);
  if (source === undefined) return;
  state.setDraft({
    drafts: {
      ...state.draft.drafts,
      [key]: {
        ...draft,
        source,
        operationKey: crypto.randomUUID(),
        past:
          direction === "undo"
            ? history!.slice(0, -1)
            : boundedHistory([...(draft.past ?? []), draft.source]),
        future:
          direction === "redo"
            ? history!.slice(0, -1)
            : boundedHistory([...(draft.future ?? []), draft.source]),
      },
    },
  });
}

const CanvasLayoutSchema = z.object({
  positions: z
    .record(
      z.string(),
      z.object({ x: z.number().finite(), y: z.number().finite() }),
    )
    .default({}),
  viewport: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      zoom: z.number().min(0.2).max(2),
    })
    .default({ x: 0, y: 0, zoom: 1 }),
});
export type PipelineCanvasLayout = z.infer<typeof CanvasLayoutSchema>;
export const usePipelineCanvasStore = createDraftStore<{
  layouts: Record<string, PipelineCanvasLayout>;
}>({
  storageKey: "multica_pipeline_canvas_layout",
  workspaceScoped: false,
  emptyData: { layouts: {} },
  hasMeaningful: (data) => Object.keys(data.layouts).length > 0,
  migrateData: (data) => {
    const parsed = z
      .object({ layouts: z.record(z.string(), CanvasLayoutSchema) })
      .safeParse(data);
    return parsed.success ? parsed.data : { layouts: {} };
  },
});
export function editPipelineCanvasLayout(
  key: string,
  layout: PipelineCanvasLayout,
) {
  const state = usePipelineCanvasStore.getState();
  state.setDraft({ layouts: { ...state.draft.layouts, [key]: layout } });
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

export function reviewPipelineDraft(
  key: string,
  revision: number,
  catalogRevision?: number,
) {
  const state = usePipelineDraftStore.getState();
  const draft = state.draft.drafts[key];
  if (draft)
    state.setDraft({
      drafts: {
        ...state.draft.drafts,
        [key]: {
          ...draft,
          baseRevision: revision,
          catalogRevision: catalogRevision ?? draft.catalogRevision,
        },
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
        ...(state.draft.entries[key] ?? { sessionId: "", request: "" }),
        ...patch,
      },
    },
  });
}

export function movePipelineDraftScope(
  from: string,
  to: string,
  legacy = false,
) {
  if (from === to) return;
  const state = usePipelineDraftStore.getState();
  const drafts = { ...state.draft.drafts };
  const belongs = (key: string) =>
    key === from ||
    (legacy
      ? ["retained", "gitlab_yaml", "hermes_yaml"].some(
          (suffix) =>
            key === `${from}:${suffix}` || key.startsWith(`${from}:${suffix}:`),
        )
      : key.startsWith(`${from}:`));
  let changed = false;
  for (const [key, draft] of Object.entries(state.draft.drafts)) {
    const target = to + key.slice(from.length);
    if (belongs(key) && !drafts[target]) {
      drafts[target] = draft;
      delete drafts[key];
      changed = true;
    }
  }
  if (changed) state.setDraft({ drafts });
  const workbench = usePipelineWorkbenchStore.getState();
  if (workbench.draft.entries[from] && !workbench.draft.entries[to]) {
    const entries = {
      ...workbench.draft.entries,
      [to]: workbench.draft.entries[from]!,
    };
    delete entries[from];
    workbench.setDraft({ entries });
  }
  const canvas = usePipelineCanvasStore.getState();
  if (canvas.draft.layouts[from] && !canvas.draft.layouts[to]) {
    const layouts = {
      ...canvas.draft.layouts,
      [to]: canvas.draft.layouts[from]!,
    };
    delete layouts[from];
    canvas.setDraft({ layouts });
  }
  const forms = usePipelineNodeDraftStore.getState();
  const next = { ...forms.draft.forms };
  for (const [key, value] of Object.entries(next))
    if (key.startsWith(`${from}:node:`)) {
      const target = to + key.slice(from.length);
      if (!next[target]) {
        next[target] = value;
        delete next[key];
      }
    }
  forms.setDraft({ forms: next });
}

const NodeFormValuesSchema = z.object({
  id: z.string(),
  title: z.string(),
  stage: z.string(),
  instructions: z.string(),
  executor: z.string(),
  ownerChoice: z.string(),
  when: z.enum(["on_success", "on_failure", "manual"]),
  retry: z.number(),
  allowFailure: z.boolean(),
  deliverables: z.array(
    z.object({ path: z.string(), name: z.string(), description: z.string() }),
  ),
  output: z.string(),
  exitCheck: z.string(),
  afterState: z.string(),
});
export type PipelineNodeFormValues = z.infer<typeof NodeFormValuesSchema>;
const NodeFormDraftSchema = z.object({
  source: z.string(),
  values: NodeFormValuesSchema,
});
export const usePipelineNodeDraftStore = createDraftStore<{
  forms: Record<string, z.infer<typeof NodeFormDraftSchema>>;
}>({
  storageKey: "multica_pipeline_node_drafts",
  workspaceScoped: false,
  emptyData: { forms: {} },
  hasMeaningful: (data) => Object.keys(data.forms).length > 0,
  migrateData: (data) => {
    const parsed = z
      .object({ forms: z.record(z.string(), NodeFormDraftSchema) })
      .safeParse(data);
    return parsed.success ? parsed.data : { forms: {} };
  },
});
export function putPipelineNodeDraft(
  key: string,
  source: string,
  values: PipelineNodeFormValues,
) {
  const state = usePipelineNodeDraftStore.getState();
  state.setDraft({
    forms: { ...state.draft.forms, [key]: { source, values } },
  });
}
export function clearPipelineNodeDraft(key: string) {
  const state = usePipelineNodeDraftStore.getState(),
    forms = { ...state.draft.forms };
  delete forms[key];
  state.setDraft({ forms });
}
