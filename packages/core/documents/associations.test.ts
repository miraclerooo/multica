// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import { ApiError } from "../api";
import { PipelineArtifactSchema } from "../pipelines/schema";
import { DocumentSourceSchema, parseAssociationResponse, type AssociateDocumentInput } from "./associations";
import { documentGroupsOptions, issueDocumentsOptions, documentRevisionOptions } from "./association-queries";
import { documentDraftKey, editDocumentDraft, useDocumentDraftStore } from "./drafts";

const document = {
  id: "doc", workspace_id: "ws", project_id: "project", kind: "document", title: "Human title", body: "Human paragraph",
  version: 3, base_version: 2,
};
const source = {
  kind: "pipeline_artifact", issue_id: "issue", run_id: "run", job_id: "produce", attempt: 2,
  path: "result.md", task_id: "task", label: "Result", href: "/api/pipeline-runs/run/artifact-content?artifact_id=pinned",
  verified: true, mutable: false, markdown: "[Result](</api/pipeline-runs/run/artifact-content?artifact_id=pinned>)",
  artifact: { id: "pinned", job_id: "produce", attempt: 2, path: "result.md", status: "accessible", document_id: "source-doc", document_version: 1 },
};
afterEach(() => { vi.unstubAllGlobals(); useDocumentDraftStore.getState().clearDraft(); });

describe("Markdown task associations", () => {
  it("preserves pinned provenance and treats unqualified external content as unverified", () => {
    expect(DocumentSourceSchema.parse(source)).toMatchObject({ artifact: { document_id: "source-doc", document_version: 1 }, attempt: 2 });
    expect(DocumentSourceSchema.parse({ kind: "future", issue_id: "issue", label: "Source", href: "https://example.org", markdown: "[Source](https://example.org)" })).toMatchObject({ verified: false, mutable: true });
    expect(PipelineArtifactSchema.safeParse({ ...source.artifact, document_version: 0 }).success).toBe(false);
  });

  it.each([
    { document: { ...document, version: 0 }, inserted: true, replayed: false, linked: true },
    { document, inserted: "yes", replayed: false, linked: true },
    { document, inserted: true, replayed: null, linked: true },
    { document, inserted: true, replayed: false },
  ])("rejects malformed write acknowledgements without dropping drafts", raw => {
    const key = documentDraftKey("ws", "project", "doc");
    editDocumentDraft(key, document, { body: "Local unsaved prose" });
    expect(() => parseAssociationResponse(raw)).toThrow("Invalid document association response");
    expect(useDocumentDraftStore.getState().draft.drafts[key]?.body).toBe("Local unsaved prose");
  });

  it("sends explicit source versions and retains the latest snapshot on a 409", async () => {
    const input: AssociateDocumentInput = {
      document_id: "doc", base_version: 2, idempotency_key: "same-request", label: "Design", description: "Review rationale",
      source: { kind: "document", document_id: "design", document_version: 1 },
    };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "document_version_conflict", error: "Document changed", latest: document }), { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    const client = new ApiClient("https://api.example.test");
    const key = documentDraftKey("ws", "project", "doc");
    editDocumentDraft(key, document, { body: "Local draft" });
    try { await client.associateIssueDocument("issue", input); expect.fail("expected conflict"); }
    catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 409, body: { code: "document_version_conflict", latest: document } });
    }
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(input);
    expect(useDocumentDraftStore.getState().draft.drafts[key]?.body).toBe("Local draft");
    fetch.mockResolvedValue(new Response(JSON.stringify({ document, inserted: false, replayed: true, linked: false }), { status: 200 }));
    expect(await client.associateIssueDocument("issue", input)).toMatchObject({ replayed: true, linked: false });
  });

  it("validates grouped, reverse and source collections, preserving stable task IDs", async () => {
    const collection = {
      documents: [document], total: 1,
      groups: [{ issue_id: "stable-task", identifier: "PROJ-7", title: "Renamed task", count: 1, documents: [document] }],
      references: [{ issue_id: "stable-task", document_id: "doc", document_version: 2, sources: [{ source_key: "key", document_version: 2, source }] }],
    };
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(collection), { status: 200 })));
    vi.stubGlobal("fetch", fetch);
    const client = new ApiClient("https://api.example.test");
    expect((await client.listProjectDocumentGroups("project", { issue_id: "stable-task", q: "Renamed task" })).groups[0]?.issue_id).toBe("stable-task");
    expect(fetch.mock.calls[0]![0]).toContain("issue_id=stable-task&q=Renamed+task");
    expect((await client.listIssueDocuments("stable-task")).references[0]?.sources[0]?.source.artifact?.document_version).toBe(1);
    fetch.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ ...collection, groups: [{ ...collection.groups[0], count: "bad" }] }), { status: 200 })));
    expect(await client.listIssueDocuments("stable-task")).toEqual({ documents: [], total: 0, groups: [], references: [] });
    fetch.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ sources: [{ source_key: "key", document_version: 0, source }], total: 1 }), { status: 200 })));
    expect(await client.listProjectDocumentSources("project", "doc")).toEqual({ sources: [], total: 0 });
  });

  it("uses separate workspace and revision keys, and unlinks only the relation endpoint", async () => {
    expect(documentGroupsOptions("ws-a", "project", { q: "research" }).queryKey).not.toEqual(documentGroupsOptions("ws-b", "project", { q: "research" }).queryKey);
    expect(issueDocumentsOptions("ws", "project", "task-a").queryKey).not.toEqual(issueDocumentsOptions("ws", "project", "task-b").queryKey);
    expect(documentRevisionOptions("ws", "project", "doc", 1).queryKey).not.toEqual(documentRevisionOptions("ws", "project", "doc", 2).queryKey);
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const client = new ApiClient("https://api.example.test");
    await client.unlinkIssueDocument("issue", "doc");
    expect(fetch.mock.calls[0]![0]).toContain("/api/issues/issue/documents/doc");
    expect(fetch.mock.calls[0]![1].method).toBe("DELETE");
  });
});
