// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import {
  usePipelineReviewStore,
  selectPipelineNode,
  editPipelineReview,
  usePipelineDraftStore,
  putPipelineDraft,
  reviewPipelineDraft,
} from "./editor";
afterEach(() => {
  usePipelineReviewStore.getState().clearDraft();
  usePipelineDraftStore.getState().clearDraft();
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
