// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { usePipelineEditorStore } from "./pipeline-editor-store";
import { useNewIssueDraftStore } from "./new-issue-draft-store";
afterEach(() => {usePipelineEditorStore.getState().reset();useNewIssueDraftStore.getState().reset();});
it("retains separate source and revision drafts through pipeline and squad changes", () => {
  const s=usePipelineEditorStore.getState();
  s.edit("w:s:a",{source:"original Hermes text",catalogRevision:1});
  s.selectPipeline("w:s","b");s.edit("w:s:b",{source:"other GitLab text",catalogRevision:4});
  s.selectSquad("w","other");s.selectSquad("w","s");s.selectPipeline("w:s","a");
  expect(usePipelineEditorStore.getState().drafts).toEqual({"w:s:a":{source:"original Hermes text",catalogRevision:1},"w:s:b":{source:"other GitLab text",catalogRevision:4}});
  s.reset();expect(usePipelineEditorStore.getState().drafts).toEqual({});
});
it("keeps legitimate per-squad task choices and removes them on a new-draft reset", () => {
  const s=useNewIssueDraftStore.getState();
  s.setExecutionSelection("a",{mode:"pipeline",pipeline_id:"p-a",definition_id:"d-a"});
  s.setExecutionSelection("b",{mode:"markdown"});s.setAssignee(null);
  expect(useNewIssueDraftStore.getState().executionSelections.a).toEqual({mode:"pipeline",pipeline_id:"p-a",definition_id:"d-a"});
  s.reset();expect(useNewIssueDraftStore.getState().executionSelections).toEqual({});
});
