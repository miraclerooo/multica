import { create } from "zustand";

export type PipelineEditorDraft = {source?: string; name?: string; catalogRevision?: number};
export const usePipelineEditorStore = create<{
  squads: Record<string, string>;
  pipelines: Record<string, string>;
  versions: Record<string, string>;
  drafts: Record<string, PipelineEditorDraft>;
  selectSquad: (wsId: string, id: string) => void;
  selectPipeline: (key: string, id: string) => void;
  selectVersion: (key: string, id: string) => void;
  edit: (key: string, draft: PipelineEditorDraft) => void;
  clear: (key: string) => void;
  reset: () => void;
}>(set => ({
  squads: {}, pipelines: {}, versions: {}, drafts: {},
  reset: () => set({squads: {}, pipelines: {}, versions: {}, drafts: {}}),
  selectSquad: (key, id) => set(s => ({squads: {...s.squads, [key]: id}})),
  selectPipeline: (key, id) => set(s => ({pipelines: {...s.pipelines, [key]: id}})),
  selectVersion: (key, id) => set(s => ({versions: {...s.versions, [key]: id}})),
  edit: (key, draft) => set(s => ({drafts: {...s.drafts, [key]: {...s.drafts[key], ...draft}}})),
  clear: key => set(s => {const drafts = {...s.drafts}; delete drafts[key]; return {drafts};}),
}));
