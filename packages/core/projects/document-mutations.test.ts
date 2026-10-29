// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { setCurrentWorkspace } from "../platform/workspace-storage";
import type { Project, ProjectDocument, MemberWithUser } from "../types";
import {
  documentDraftKey,
  editDocumentDraft,
  readDocumentDraft,
  useProjectDocumentDraftStore,
  validDocumentFields,
} from "./document-drafts";
import {
  canDeleteProjectDocument,
  flushProjectDocument,
  retryProjectDocument,
} from "./document-mutations";
import {
  projectDocumentKeys,
  projectDocumentsOptions,
} from "./document-queries";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  api: {
    updateProjectDocument: vi.fn(),
    getProjectDocument: vi.fn(),
    listProjectDocuments: vi.fn(),
  },
}));
const doc: ProjectDocument = {
  id: "doc",
  project_id: "project",
  workspace_id: "ws",
  title: "Guidelines",
  content: "Original\n",
  revision: 1,
  position: 0,
  is_pinned: false,
  created_by: "creator",
  updated_by: "creator",
  created_at: "2026-10-29T00:00:00Z",
  updated_at: "2026-10-29T00:00:00Z",
};
const key = documentDraftKey("ws", "project", "doc");
let qc: QueryClient;
beforeEach(async () => {
  vi.clearAllMocks();
  setCurrentWorkspace("workspace", "ws");
  await Promise.resolve();
  useProjectDocumentDraftStore.getState().clearDraft();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(projectDocumentKeys.detail("ws", "project", "doc"), doc);
});

describe("document save coordination", () => {
  it("sends the backend revision field and preserves exact Markdown bytes", async () => {
    const content = "\n## Heading\n\n```ts\nconst x = 1;\n```\n";
    editDocumentDraft("ws", doc, { content });
    vi.mocked(api.updateProjectDocument).mockResolvedValue({
      ...doc,
      content,
      revision: 2,
    });
    expect(
      await flushProjectDocument(qc, "ws", "project", "doc", "workspace"),
    ).toBe(true);
    expect(api.updateProjectDocument).toHaveBeenCalledWith(
      "project",
      "doc",
      { title: doc.title, content, is_pinned: false, position: 0, revision: 1 },
      "workspace",
    );
    expect(readDocumentDraft(key)).toBeUndefined();
  });
  it("serializes flushes and metadata changes while typing continues", async () => {
    let resolve!: (value: ProjectDocument) => void;
    vi.mocked(api.updateProjectDocument)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockImplementationOnce(async (_p, _id, data) => ({
        ...doc,
        ...data,
        revision: 3,
      }));
    editDocumentDraft("ws", doc, { content: "First" });
    const first = flushProjectDocument(qc, "ws", "project", "doc");
    editDocumentDraft("ws", doc, { content: "Second", is_pinned: true });
    const second = flushProjectDocument(qc, "ws", "project", "doc");
    expect(first).toBe(second);
    expect(api.updateProjectDocument).toHaveBeenCalledTimes(1);
    resolve({ ...doc, content: "First", revision: 2 });
    expect(await second).toBe(true);
    expect(api.updateProjectDocument).toHaveBeenNthCalledWith(
      2,
      "project",
      "doc",
      expect.objectContaining({
        revision: 2,
        content: "Second",
        is_pinned: true,
      }),
      undefined,
    );
    expect(readDocumentDraft(key)).toBeUndefined();
  });
  it("keeps a revert made while the earlier write was in flight", async () => {
    let resolve!: (value: ProjectDocument) => void;
    vi.mocked(api.updateProjectDocument)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValueOnce({ ...doc, revision: 3 });
    editDocumentDraft("ws", doc, { content: "Transient" });
    const save = flushProjectDocument(qc, "ws", "project", "doc");
    editDocumentDraft("ws", doc, { content: doc.content });
    resolve({ ...doc, content: "Transient", revision: 2 });
    await save;
    expect(api.updateProjectDocument).toHaveBeenNthCalledWith(
      2,
      "project",
      "doc",
      expect.objectContaining({ revision: 2, content: doc.content }),
      undefined,
    );
  });
  it("keeps the local draft on 409 and never silently advances its revision", async () => {
    editDocumentDraft("ws", doc, { content: "My draft" });
    vi.mocked(api.updateProjectDocument).mockRejectedValue(
      new ApiError("conflict", 409, "Conflict", {
        code: "project_document_conflict",
        current_revision: 4,
      }),
    );
    expect(await flushProjectDocument(qc, "ws", "project", "doc")).toBe(false);
    expect(readDocumentDraft(key)).toMatchObject({
      content: "My draft",
      revision: 1,
      problem: { kind: "conflict", revision: 4 },
    });
    await flushProjectDocument(qc, "ws", "project", "doc");
    expect(api.updateProjectDocument).toHaveBeenCalledTimes(1);
    vi.mocked(api.getProjectDocument).mockResolvedValue({
      ...doc,
      content: "Someone else's edit",
      revision: 4,
    });
    expect(await retryProjectDocument(qc, "ws", "project", "doc")).toBe(false);
    expect(readDocumentDraft(key)?.content).toBe("My draft");
    expect(api.updateProjectDocument).toHaveBeenCalledTimes(1);
  });
  it.each([
    [403, "forbidden"],
    [404, "missing"],
    [413, "invalid"],
  ] as const)("retains the draft after HTTP %s", async (status, kind) => {
    editDocumentDraft("ws", doc, { content: "Keep me" });
    vi.mocked(api.updateProjectDocument).mockRejectedValue(
      new ApiError("failed", status, "Failed"),
    );
    await flushProjectDocument(qc, "ws", "project", "doc");
    expect(readDocumentDraft(key)).toMatchObject({
      content: "Keep me",
      problem: { kind },
    });
  });
  it("refetches an ambiguous save before retrying and recognizes an acknowledged draft", async () => {
    editDocumentDraft("ws", doc, { content: "Saved but response lost" });
    vi.mocked(api.updateProjectDocument).mockRejectedValue(
      new TypeError("offline"),
    );
    await flushProjectDocument(qc, "ws", "project", "doc");
    vi.mocked(api.getProjectDocument).mockResolvedValue({
      ...doc,
      content: "Saved but response lost",
      revision: 2,
    });
    expect(await retryProjectDocument(qc, "ws", "project", "doc")).toBe(true);
    expect(api.getProjectDocument).toHaveBeenCalledOnce();
    expect(api.updateProjectDocument).toHaveBeenCalledOnce();
    expect(readDocumentDraft(key)).toBeUndefined();
  });
  it("does not write a late save into another workspace", async () => {
    let resolve!: (value: ProjectDocument) => void;
    vi.mocked(api.updateProjectDocument).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    editDocumentDraft("ws", doc, { content: "Draft" });
    const pending = flushProjectDocument(
      qc,
      "ws",
      "project",
      "doc",
      "workspace",
    );
    setCurrentWorkspace("other-workspace", "other-ws");
    await Promise.resolve();
    const other = { ...doc, id: "other", workspace_id: "other-ws" };
    editDocumentDraft("other-ws", other, { content: "Other draft" });
    resolve({ ...doc, content: "Draft", revision: 2 });
    await pending;
    expect(
      readDocumentDraft(documentDraftKey("other-ws", "project", "other"))
        ?.content,
    ).toBe("Other draft");
    expect(api.updateProjectDocument).toHaveBeenCalledTimes(1);
  });
  it("enforces Unicode title and UTF-8 content limits before saving", () => {
    expect(validDocumentFields({ ...doc, title: "🎉".repeat(200) })).toBe(true);
    expect(validDocumentFields({ ...doc, title: "🎉".repeat(201) })).toBe(
      false,
    );
    expect(validDocumentFields({ ...doc, title: "  " })).toBe(false);
    expect(validDocumentFields({ ...doc, content: "\0" })).toBe(false);
    expect(validDocumentFields({ ...doc, content: "中".repeat(350000) })).toBe(
      false,
    );
  });
});

it("loads every server page for filtering while retaining the server total", async () => {
  vi.mocked(api.listProjectDocuments)
    .mockResolvedValueOnce({
      documents: [{ ...doc, excerpt: "One" }],
      total: 2,
      limit: 100,
      offset: 0,
    })
    .mockResolvedValueOnce({
      documents: [{ ...doc, id: "doc2", excerpt: "Two" }],
      total: 2,
      limit: 100,
      offset: 1,
    });
  const result = await qc.fetchQuery(
    projectDocumentsOptions("ws", "project", "workspace"),
  );
  expect(result.documents.map((d) => d.id)).toEqual(["doc", "doc2"]);
  expect(api.listProjectDocuments).toHaveBeenNthCalledWith(
    2,
    "project",
    { limit: 100, offset: 1 },
    "workspace",
  );
});

it("matches deletion permissions, including member versus agent project leads", () => {
  const project = { lead_type: "member", lead_id: "lead" } as Project;
  const members = [
    { user_id: "creator", role: "member" },
    { user_id: "lead", role: "member" },
    { user_id: "admin", role: "admin" },
    { user_id: "other", role: "member" },
  ] as MemberWithUser[];
  expect(canDeleteProjectDocument(doc, project, "creator", members)).toBe(true);
  expect(canDeleteProjectDocument(doc, project, "lead", members)).toBe(true);
  expect(canDeleteProjectDocument(doc, project, "admin", members)).toBe(true);
  expect(canDeleteProjectDocument(doc, project, "other", members)).toBe(false);
  expect(
    canDeleteProjectDocument(
      doc,
      { ...project, lead_type: "agent" },
      "lead",
      members,
    ),
  ).toBe(false);
  expect(canDeleteProjectDocument(doc, project, "creator", [])).toBe(false);
});
