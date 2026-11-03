// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import {
  usePipelineReviewStore,
  selectPipelineNode,
  editPipelineReview,
  usePipelineDraftStore,
  putPipelineDraft,
  reviewPipelineDraft,
  adoptLegacyPipelineDraft,
  movePipelineDraftScope,
  usePipelineWorkbenchStore,
  editPipelineWorkbench,
  stepPipelineHistory,
  usePipelineNodeDraftStore,
  putPipelineNodeDraft,
  clearPipelineNodeDraft,
  usePipelineCanvasStore,
  editPipelineCanvasLayout,
} from "./editor";
afterEach(() => {
  usePipelineReviewStore.getState().clearDraft();
  usePipelineDraftStore.getState().clearDraft();
  usePipelineWorkbenchStore.getState().clearDraft();
  usePipelineCanvasStore.getState().clearDraft();
  usePipelineNodeDraftStore.getState().clearDraft();
});
it("shares source history across YAML and canvas edits without rebasing the reviewed catalog", () => {
  putPipelineDraft("w:s:p", "Canvas edit", "definition", 4, {
    catalogRevision: 2,
    previousSource: "Original complete YAML",
  });
  putPipelineDraft("w:s:p", "YAML edit", "definition", 8, {
    catalogRevision: 7,
  });
  stepPipelineHistory("w:s:p", "undo");
  expect(usePipelineDraftStore.getState().draft.drafts["w:s:p"]).toMatchObject({
    source: "Canvas edit",
    baseRevision: 4,
    catalogRevision: 2,
  });
  stepPipelineHistory("w:s:p", "undo");
  expect(usePipelineDraftStore.getState().draft.drafts["w:s:p"]?.source).toBe(
    "Original complete YAML",
  );
  stepPipelineHistory("w:s:p", "redo");
  stepPipelineHistory("w:s:p", "redo");
  expect(usePipelineDraftStore.getState().draft.drafts["w:s:p"]?.source).toBe(
    "YAML edit",
  );
  stepPipelineHistory("w:s:p", "undo");
  putPipelineDraft("w:s:p", "New branch of edits");
  stepPipelineHistory("w:s:p", "redo");
  expect(usePipelineDraftStore.getState().draft.drafts["w:s:p"]?.source).toBe(
    "New branch of edits",
  );
});
it("keeps layouts and histories separate between logical pipelines and transfers the new pipeline's preference", () => {
  putPipelineDraft("w:s:new", "new source", "", 3, { previousSource: "" });
  putPipelineDraft("w:s:other", "other source", "old", 4, {
    previousSource: "original other",
  });
  editPipelineCanvasLayout("w:s:new", {
    positions: { custom: { x: 70, y: 90 } },
    viewport: { x: 12, y: 18, zoom: 0.7 },
  });
  movePipelineDraftScope("w:s:new", "w:s:created");
  stepPipelineHistory("w:s:created", "undo");
  expect(
    usePipelineDraftStore.getState().draft.drafts["w:s:created"]?.source,
  ).toBe("");
  expect(
    usePipelineDraftStore.getState().draft.drafts["w:s:other"]?.source,
  ).toBe("other source");
  expect(
    usePipelineCanvasStore.getState().draft.layouts["w:s:created"]?.positions
      .custom,
  ).toEqual({ x: 70, y: 90 });
  expect(
    usePipelineCanvasStore.getState().draft.layouts["w:s:new"],
  ).toBeUndefined();
});
it("moves alternate dialect drafts and the conversation from a new catalog draft to its stable identity", () => {
  putPipelineDraft("w:s:new:hermes_yaml", "Original alternate dialect");
  putPipelineDraft("w:s:other", "Other independent pipeline");
  editPipelineWorkbench("w:s:new", {
    sessionId: "conversation",
    request: "Unsent prompt",
  });
  movePipelineDraftScope("w:s:new", "w:s:created");
  expect(
    usePipelineDraftStore.getState().draft.drafts["w:s:created:hermes_yaml"]
      ?.source,
  ).toBe("Original alternate dialect");
  expect(
    usePipelineDraftStore.getState().draft.drafts["w:s:other"]?.source,
  ).toBe("Other independent pipeline");
  expect(
    usePipelineWorkbenchStore.getState().draft.entries["w:s:created"],
  ).toEqual({ sessionId: "conversation", request: "Unsent prompt" });
  expect(
    usePipelineWorkbenchStore.getState().draft.entries["w:s:new"],
  ).toBeUndefined();
});
it("adopts the old squad draft into its migrated catalog without overwriting a newer draft", () => {
  putPipelineDraft("w:s", "Original YAML", "old-definition", 8);
  adoptLegacyPipelineDraft("w:s", "w:s:legacy");
  expect(
    usePipelineDraftStore.getState().draft.drafts["w:s:legacy"],
  ).toMatchObject({
    source: "Original YAML",
    baseId: "old-definition",
    baseRevision: 8,
  });
  expect(usePipelineDraftStore.getState().draft.drafts["w:s"]).toBeUndefined();
  putPipelineDraft("w:s", "Retained old YAML");
  adoptLegacyPipelineDraft("w:s", "w:s:legacy");
  expect(
    usePipelineDraftStore.getState().draft.drafts["w:s:legacy"]?.source,
  ).toBe("Original YAML");
  expect(usePipelineDraftStore.getState().draft.drafts["w:s"]?.source).toBe(
    "Retained old YAML",
  );
});
it("retains the selected gate and reviewed revision independently of server refresh and component lifetime", () => {
  selectPipelineNode("workspace:run", "custom_gate");
  editPipelineReview("workspace:run:custom_gate", "My unsent opinion", 3);
  expect(usePipelineReviewStore.getState().draft).toEqual({
    selections: { "workspace:run": "custom_gate" },
    opinions: {
      "workspace:run:custom_gate": { reason: "My unsent opinion", revision: 3 },
    },
  });
  selectPipelineNode("workspace:run", "another_node");
  expect(
    usePipelineReviewStore.getState().draft.opinions[
      "workspace:run:custom_gate"
    ]?.revision,
  ).toBe(3);
  editPipelineReview("workspace:run:custom_gate", "", 4);
  expect(usePipelineReviewStore.getState().draft.opinions).toEqual({});
});
it("retains separate dialect drafts without copying a server snapshot into another kind", () => {
  putPipelineDraft(
    "w:s:gitlab_yaml",
    "kind: gitlab_yaml\ncustom: original\n",
    "v1",
  );
  putPipelineDraft("w:s:hermes_yaml", "kind: hermes_yaml\nstates: {}\n", "v2");
  expect(
    usePipelineDraftStore.getState().draft.drafts["w:s:gitlab_yaml"]?.source,
  ).toContain("custom: original");
  expect(
    usePipelineDraftStore.getState().draft.drafts["w:s:hermes_yaml"]?.source,
  ).toContain("states: {}");
});

it("keeps the configuration revision reviewed when editing until explicit conflict resolution", () => {
  putPipelineDraft("w:s", "original", "v1", 3);
  putPipelineDraft("w:s", "my edits", "v1", 4);
  expect(
    usePipelineDraftStore.getState().draft.drafts["w:s"]?.baseRevision,
  ).toBe(3);
  reviewPipelineDraft("w:s", 4);
  expect(usePipelineDraftStore.getState().draft.drafts["w:s"]).toMatchObject({
    source: "my edits",
    baseRevision: 4,
  });
});

it("retains unapplied node fields and their source through catalog creation without touching another pipeline", () => {
  const values = {
    id: "",
    title: "Kept name",
    stage: "work",
    instructions: "Full instructions.",
    executor: "leader",
    ownerChoice: "none",
    when: "on_success" as const,
    retry: 0,
    allowFailure: false,
    deliverables: [
      {
        path: "a/report.md",
        name: "report.md",
        description: "First paragraph.\n\nSecond paragraph.\n",
      },
    ],
    output: "",
    exitCheck: "",
    afterState: "",
  };
  putPipelineNodeDraft("w:s:new:node:node_1", "original source", values);
  putPipelineNodeDraft("w:s:other:node:node_1", "other source", {
    ...values,
    title: "Other",
  });
  movePipelineDraftScope("w:s:new", "w:s:created");
  expect(
    usePipelineNodeDraftStore.getState().draft.forms["w:s:created:node:node_1"],
  ).toEqual({ source: "original source", values });
  expect(
    usePipelineNodeDraftStore.getState().draft.forms["w:s:new:node:node_1"],
  ).toBeUndefined();
  clearPipelineNodeDraft("w:s:created:node:node_1");
  expect(
    usePipelineNodeDraftStore.getState().draft.forms["w:s:other:node:node_1"]
      ?.values.title,
  ).toBe("Other");
});
