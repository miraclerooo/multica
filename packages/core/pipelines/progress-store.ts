import { z } from "zod";
import { createDraftStore } from "../drafts/create-draft-store";

const ProgressViewSchema = z.object({
  runs: z.record(z.string(), z.string()).default({}),
  expanded: z.record(z.string(), z.array(z.string())).default({}),
});
export const usePipelineProgressStore = createDraftStore<
  z.infer<typeof ProgressViewSchema>
>({
  storageKey: "multica_pipeline_progress",
  workspaceScoped: false,
  emptyData: { runs: {}, expanded: {} },
  hasMeaningful: (data) =>
    Object.keys(data.runs).length > 0 || Object.keys(data.expanded).length > 0,
  migrateData: (value) => {
    const parsed = ProgressViewSchema.safeParse(value);
    return parsed.success ? parsed.data : { runs: {}, expanded: {} };
  },
});
export function selectPipelineProgressRun(key: string, runId: string) {
  const store = usePipelineProgressStore.getState();
  if (store.draft.runs[key] !== runId)
    store.setDraft({ runs: { ...store.draft.runs, [key]: runId } });
}
export function expandPipelineProgressStages(key: string, stages: string[]) {
  const store = usePipelineProgressStore.getState();
  store.setDraft({ expanded: { ...store.draft.expanded, [key]: stages } });
}
