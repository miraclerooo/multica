// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import { parseProjectDocument, parseProjectDocuments } from "./document-schema";

const document = {
  id: "doc-1", workspace_id: "ws-1", project_id: "project-1", title: "Spec", content: "# Hello\n",
  revision: 1, created_by: "user-1", updated_by: "user-1", created_at: "2026-10-29T00:00:00Z", updated_at: "2026-10-29T00:00:00Z",
};

function respond(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(status === 204 ? null : JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  })));
}

afterEach(() => vi.unstubAllGlobals());

describe("project document API contract", () => {
  it("defaults optional metadata and preserves new server fields", () => {
    expect(parseProjectDocument({ ...document, future: true }, "test")).toEqual({
      ...document, is_pinned: false, position: 0, future: true,
    });
  });

  it.each([null, {}, { ...document, content: null }, { ...document, revision: undefined }, { ...document, revision: 0 }, { ...document, revision: "1" }])(
    "rejects malformed detail/save responses without inventing saved content (%j)", (body) => {
      expect(() => parseProjectDocument(body, "test")).toThrow("Malformed response");
    },
  );

  it("rejects malformed list responses", () => {
    expect(() => parseProjectDocuments({ documents: "bad", total: 1 }, "test")).toThrow("Malformed response");
    expect(() => parseProjectDocuments({ documents: [document], total: -1, limit: 50, offset: 0 }, "test")).toThrow("Malformed response");
  });

  it("parses paginated summaries and requests the chosen page", async () => {
    const { content: _content, ...summary } = document;
    respond({ documents: [{ ...summary, excerpt: "# Hello" }], total: 3, limit: 1, offset: 1 });
    const client = new ApiClient("https://api.example.test");
    const page = await client.listProjectDocuments("project-1", { limit: 1, offset: 1 });
    expect(page.documents[0]?.excerpt).toBe("# Hello");
    expect(page.total).toBe(3);
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/projects/project-1/documents?limit=1&offset=1", expect.any(Object));
  });

  it("sends revision preconditions for save and delete", async () => {
    const client = new ApiClient("https://api.example.test");
    respond({ ...document, revision: 2 });
    const data = { revision: 1, content: "" };
    expect((await client.updateProjectDocument("project-1", "doc-1", data)).revision).toBe(2);
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/projects/project-1/documents/doc-1", expect.objectContaining({ method: "PATCH", body: JSON.stringify(data) }));
    respond(null, 204);
    await client.deleteProjectDocument("project-1", "doc-1", 2);
    expect(fetch).toHaveBeenCalledWith("https://api.example.test/api/projects/project-1/documents/doc-1?revision=2", expect.objectContaining({ method: "DELETE" }));
  });

  it("validates responses from all document endpoints", async () => {
    const client = new ApiClient("https://api.example.test");
    for (const call of [
      () => client.listProjectDocuments("project-1"),
      () => client.getProjectDocument("project-1", "doc-1"),
      () => client.createProjectDocument("project-1", { title: "Spec" }),
      () => client.updateProjectDocument("project-1", "doc-1", { title: "Spec", revision: 1 }),
    ]) {
      respond({});
      await expect(call()).rejects.toThrow("Malformed response");
    }
  });

  it("retains structured conflicts for the editor", async () => {
    const client = new ApiClient("https://api.example.test");
    const conflict = { error: "document changed", code: "project_document_conflict", current_revision: 4 };
    respond(conflict, 409);
    const err = await client.updateProjectDocument("project-1", "doc-1", { revision: 1, title: "Spec" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, body: conflict });
  });
});
