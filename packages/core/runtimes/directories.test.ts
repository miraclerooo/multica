// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWithFallback } from "../api/schema";
import {
  DirectoryBrowseRequestSchema,
  MALFORMED_DIRECTORY_REQUEST,
} from "./directories-schema";
import { isAbsoluteDirectoryPath, resolveDirectoryBrowse } from "./directories";
import { api } from "../api";
vi.mock("../api", () => ({
  api: { initiateDirectoryBrowse: vi.fn(), getDirectoryBrowse: vi.fn() },
}));

afterEach(() => vi.restoreAllMocks());

describe("directory request responses", () => {
  it("fails closed for malformed or unknown response shapes", () => {
    for (const value of [
      null,
      {},
      {
        id: "r",
        runtime_id: "rt",
        daemon_id: "d",
        status: "completed",
        result: { entries: [{ name: "private" }] },
      },
    ]) {
      expect(
        parseWithFallback(
          value,
          DirectoryBrowseRequestSchema,
          MALFORMED_DIRECTORY_REQUEST,
          { endpoint: "directories" },
        ).status,
      ).toBe("failed");
    }
    expect(
      DirectoryBrowseRequestSchema.parse({
        id: "r",
        runtime_id: "rt",
        daemon_id: "d",
        status: "new-status",
      }).status,
    ).toBe("failed");
  });

  it("never treats a successful status without a directory result as a selection", async () => {
    vi.spyOn(api, "initiateDirectoryBrowse").mockResolvedValue({
      id: "r",
      runtime_id: "rt",
      daemon_id: "d",
      status: "completed",
      error: "",
    });
    await expect(
      resolveDirectoryBrowse("rt", { operation: "validate", path: "/project" }),
    ).rejects.toThrow();
  });

  it("returns only a completed validated result", async () => {
    const result = {
      path: "/project",
      real_path: "/disk/project",
      parent: "",
      entries: [],
      truncated: false,
      is_git_repo: true,
    };
    vi.spyOn(api, "initiateDirectoryBrowse").mockResolvedValue({
      id: "r",
      runtime_id: "rt",
      daemon_id: "d",
      status: "completed",
      result,
      error: "",
    });
    expect(
      await resolveDirectoryBrowse("rt", {
        operation: "validate",
        path: "/project",
      }),
    ).toEqual(result);
  });

  it("cancels polling when the picker closes", async () => {
    vi.spyOn(api, "initiateDirectoryBrowse").mockResolvedValue({
      id: "r",
      runtime_id: "rt",
      daemon_id: "d",
      status: "pending",
      error: "",
    });
    const poll = vi.spyOn(api, "getDirectoryBrowse");
    const controller = new AbortController();
    controller.abort();
    await expect(
      resolveDirectoryBrowse("rt", { operation: "roots" }, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(poll).not.toHaveBeenCalled();
  });
});

describe("absolute directory paths", () => {
  it.each([
    "/projects/app",
    "C:\\projects\\app",
    "D:/projects/app",
    "\\\\server\\share\\app",
  ])("accepts %s", (path) => {
    expect(isAbsoluteDirectoryPath(path)).toBe(true);
  });
  it.each(["", "./app", "../app", "~/app", "C:app", "app"])(
    "rejects %s",
    (path) => {
      expect(isAbsoluteDirectoryPath(path)).toBe(false);
    },
  );
});
