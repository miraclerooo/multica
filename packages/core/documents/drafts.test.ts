// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  acknowledgeDocumentSave,
  documentDraftKey,
  editDocumentDraft,
  failDocumentSave,
  putDocumentDraft,
  useDocumentDraftStore,
} from "./drafts";

const base = { title: "Original", body: "- [ ] Acceptance", version: 4 };
const a = documentDraftKey("workspace-a", "project-a", "doc-a");
const b = documentDraftKey("workspace-a", "project-a", "doc-b");
beforeEach(() => useDocumentDraftStore.getState().clearDraft());
const drafts = () => useDocumentDraftStore.getState().draft.drafts;

describe("project document drafts", () => {
  it("isolates workspace, project and document, retaining the original base after remote refreshes", () => {
    editDocumentDraft(a, base, { title: "My title" });
    editDocumentDraft(b, base, { body: "B content" });
    editDocumentDraft(
      a,
      { ...base, title: "Remote", version: 5 },
      { body: "My content" },
    );
    expect(drafts()[a]).toMatchObject({
      title: "My title",
      body: "My content",
      base,
    });
    expect(drafts()[b]?.body).toBe("B content");
    expect(
      drafts()[documentDraftKey("workspace-b", "project-a", "doc-a")],
    ).toBeUndefined();
    expect(
      drafts()[documentDraftKey("workspace-a", "project-b", "doc-a")],
    ).toBeUndefined();
  });
  it("acknowledges only the submitted document even after switching", () => {
    editDocumentDraft(a, base, { body: "saved A" });
    const sent = drafts()[a]!;
    editDocumentDraft(b, base, { title: "B draft" });
    acknowledgeDocumentSave(a, sent, { ...base, body: sent.body, version: 5 });
    expect(drafts()[a]).toBeUndefined();
    expect(drafts()[b]?.title).toBe("B draft");
  });
  it("preserves edits made during save and advances their base to the acknowledged snapshot", () => {
    editDocumentDraft(a, base, { body: "first edit" });
    const sent = drafts()[a]!;
    editDocumentDraft(a, base, { title: "second title", body: "second edit" });
    acknowledgeDocumentSave(a, sent, {
      title: base.title,
      body: sent.body,
      version: 5,
    });
    expect(drafts()[a]).toEqual({
      title: "second title",
      body: "second edit",
      base: { title: base.title, body: "first edit", version: 5 },
      status: "dirty",
      error: undefined,
    });
  });
  it("keeps failure and conflict content until explicitly discarded", () => {
    editDocumentDraft(a, base, { title: "Local title", body: "Local body" });
    failDocumentSave(a, "failed", "network unavailable");
    expect(drafts()[a]?.status).toBe("failed");
    failDocumentSave(a, "conflict", "remote advanced");
    editDocumentDraft(a, { ...base, version: 5 }, { body: "merged body" });
    expect(drafts()[a]).toMatchObject({
      title: "Local title",
      body: "merged body",
      status: "conflict",
      base,
    });
    putDocumentDraft(a, undefined);
    expect(drafts()[a]).toBeUndefined();
  });
  it("never resurrects a discarded draft from a late failure or success", () => {
    editDocumentDraft(a, base, { body: "temporary" });
    const sent = drafts()[a]!;
    putDocumentDraft(a, undefined);
    failDocumentSave(a, "failed", "late");
    acknowledgeDocumentSave(a, sent, { ...base, version: 5 });
    expect(drafts()).toEqual({});
  });
});
