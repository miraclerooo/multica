// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  issuePipelineRunsOptions,
  pipelineRunOptions,
  issueExecutionOptions,
} from "./queries";
import type { PipelineRun } from "./schema";
const calls = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
  execution: vi.fn(),
}));
vi.mock("../api", () => ({
  api: {
    listPipelineRuns: calls.list,
    getPipelineRun: calls.detail,
    getIssueExecution: calls.execution,
  },
}));
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
afterEach(() => {
  client.clear();
  vi.resetAllMocks();
});
const run = (id: string) =>
  ({
    id,
    workspace_id: "w",
    issue_id: "i",
    revision: 1,
    status: "running",
  }) as PipelineRun;
it("reads all pages, including activity and selected history beyond the first 50 instances", async () => {
  calls.list.mockImplementation(async ({ offset }: { offset: number }) => ({
    items: Array.from({ length: offset ? 3 : 50 }, (_, i) =>
      run(`r${offset + i}`),
    ),
    limit: 50,
    offset,
  }));
  const result = await client.fetchQuery(issuePipelineRunsOptions("w", "i"));
  expect(result).toHaveLength(53);
  expect(result.at(-1)?.id).toBe("r52");
  expect(calls.list).toHaveBeenCalledTimes(2);
});
it.each(["identity", "pagination"])(
  "rejects a mismatched %s instead of presenting it as an empty or unrelated task",
  async (cause) => {
    calls.list.mockResolvedValue({
      items: [
        cause === "identity"
          ? { ...run("r"), issue_id: "different" }
          : run("r"),
      ],
      limit: 50,
      offset: cause === "pagination" ? 10 : 0,
    });
    await expect(
      client.fetchQuery(issuePipelineRunsOptions("w", "i")),
    ).rejects.toThrow("Invalid pipeline");
  },
);
it("rejects non-advancing full pages", async () => {
  calls.list.mockImplementation(async ({ offset }: { offset: number }) => ({
    items: Array.from({ length: 50 }, () => run("duplicate")),
    limit: 50,
    offset,
  }));
  await expect(
    client.fetchQuery(issuePipelineRunsOptions("w", "i")),
  ).rejects.toThrow("Invalid pipeline run pagination");
});
it.each([null, { ...run("other") }, { ...run("r"), workspace_id: "other" }])(
  "rejects a missing or mismatched run detail %j",
  async (value) => {
    calls.detail.mockResolvedValue(value);
    await expect(
      client.fetchQuery(pipelineRunOptions("w", "r")),
    ).rejects.toThrow("Invalid pipeline run response");
  },
);
it("distinguishes malformed execution data from an acknowledged absent execution", async () => {
  calls.execution.mockResolvedValue(null);
  await expect(
    client.fetchQuery(issueExecutionOptions("w", "i")),
  ).rejects.toThrow("Invalid pipeline execution response");
  calls.execution.mockResolvedValue({ execution: null });
  expect(await client.fetchQuery(issueExecutionOptions("w", "i"))).toEqual({
    execution: null,
  });
});
