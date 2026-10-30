// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import { parseDocumentResponse } from "./schema";

const document = {
  id: "doc",
  workspace_id: "ws",
  project_id: "project",
  title: "Title",
  body: "Body",
  kind: "spec",
  version: 2,
  base_version: 1,
};
afterEach(() => vi.unstubAllGlobals());

describe("document API boundary", () => {
  it("keeps unknown kinds readable and defaults missing attribution to unknown", () => {
    expect(
      parseDocumentResponse({ ...document, kind: "future-kind" }, "test"),
    ).toMatchObject({
      kind: "document",
      author_type: "unknown",
      title: "Title",
      body: "Body",
    });
  });
  it.each([
    { ...document, body: null },
    { ...document, version: 0 },
    { ...document, base_version: "bad" },
    { ...document, id: "" },
  ])(
    "rejects malformed snapshots so saves cannot clear drafts on an invalid acknowledgement",
    (raw) => {
      expect(() => parseDocumentResponse(raw, "PUT document")).toThrow(
        "Invalid document response",
      );
    },
  );
  it("serializes explicit full snapshots and protects all new response collections", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(document), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetch);
    const client = new ApiClient("https://api.example.test");
    await client.saveProjectDocument("project", "doc", {
      title: "New title",
      body: "New body",
      base_version: 1,
    });
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
      title: "New title",
      body: "New body",
      base_version: 1,
    });
    fetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ documents: "broken", revisions: null }), {
          status: 200,
        }),
      ),
    );
    expect(await client.listProjectDocuments("project")).toEqual({
      documents: [],
      total: 0,
    });
    expect(await client.listProjectDocumentRevisions("project", "doc")).toEqual(
      { revisions: [], total: 0 },
    );
    fetch.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ resources: "broken" }), { status: 200 }),
      ),
    );
    expect(await client.listProjectResources("project")).toEqual({
      resources: [],
      total: 0,
    });
  });
});
