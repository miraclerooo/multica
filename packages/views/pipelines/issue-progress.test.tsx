import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError } from "@multica/core/api";
import {
  PipelineRunSchema,
  usePipelineProgressStore,
  usePipelineReviewStore,
} from "@multica/core/pipelines";
import type { Issue } from "@multica/core/types";
import en from "../locales/en/squads.json";
import { IssuePipelineCard } from "./issue-progress";

const state = vi.hoisted(() => ({
  ws: "ws",
  list: vi.fn(),
  detail: vi.fn(),
  execution: vi.fn(),
  events: new Map<string, (event?: unknown) => void>(),
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => state.ws }));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ pipelineRun: (id: string) => `/runs/${id}` }),
}));
vi.mock("@multica/core/realtime", () => ({
  useWSEvent: (name: string, handler: (event: unknown) => void) =>
    state.events.set(name, handler),
  useWSReconnect: (handler: () => void) =>
    state.events.set("reconnect", handler),
}));
vi.mock("@multica/core/api", async (original) => ({
  ...(await original<typeof import("@multica/core/api")>()),
  api: {
    listPipelineRuns: state.list,
    getPipelineRun: state.detail,
    getIssueExecution: state.execution,
    listMembers: async () => [{ user_id: "human", name: "Actual owner" }],
  },
}));
vi.mock("../i18n", () => ({
  useT: () => ({
    t: (
      select: (v: typeof en) => unknown,
      params: Record<string, unknown> = {},
    ) => {
      const value = select(en);
      return typeof value === "string"
        ? value.replace(/\{\{(\w+)\}\}/g, (_, key) => String(params[key] ?? ""))
        : value;
    },
  }),
}));
vi.mock("../navigation", () => ({
  AppLink: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
// Action guards are canonical in run-details.test.tsx; this test owns the
// sidebar's run/node selection wiring into that existing detail component.
vi.mock("./run-details", () => ({
  PipelineRunDetails: ({ runId }: { runId: string }) => {
    const node = usePipelineReviewStore(
      (s) => s.draft.selections[`${state.ws}:${runId}`],
    );
    return (
      <output>
        {runId}/{node}
      </output>
    );
  },
}));

const clients: QueryClient[] = [];
beforeEach(() => {
  state.ws = "ws";
  state.events.clear();
  vi.resetAllMocks();
  state.list.mockResolvedValue({ items: [], limit: 50, offset: 0 });
  state.execution.mockResolvedValue({ execution: null });
});
afterEach(() => {
  cleanup();
  clients.forEach((c) => c.clear());
  clients.length = 0;
  usePipelineProgressStore.getState().clearDraft();
  usePipelineReviewStore.getState().clearDraft();
});
function snapshot(id = "active", issueId = "issue", status = "running") {
  const nodes = [
    {
      id: "build",
      source_id: "build",
      title: "Frozen implementation",
      stage: "Work",
      type: "agent",
      when: "on_success",
      needs: [],
      artifact_sources: [],
      paths: [],
      retry: 2,
      allow_failure: false,
    },
    {
      id: "gate",
      source_id: "gate",
      title: "Frozen sign-off",
      stage: "Review",
      type: "manual",
      when: "manual",
      owner_user_id: "human",
      needs: [],
      artifact_sources: [],
      paths: [],
      retry: 0,
      allow_failure: false,
    },
  ];
  return PipelineRunSchema.parse({
    id,
    workspace_id: state.ws,
    issue_id: issueId,
    squad_id: "s",
    definition_id: "frozen-definition",
    pipeline_name: "Frozen workflow",
    definition_revision: 3,
    creator_id: "human",
    revision: 1,
    status,
    reason: "",
    plan: {
      kind: "gitlab_yaml",
      compiler_version: "2",
      source_hash: "original",
      stages: ["Work", "Review"],
      nodes,
    },
    policy: "",
    issue_title: "Original",
    issue_description: "",
    issue_revision: 1,
    project_id: "",
    workflow_id: "",
    workflow_step: "",
    projected_status: "",
    jobs: nodes.map((node, i) => ({
      node,
      status: i ? "waiting_approval" : "running",
      reason: i ? "Owner review needed" : "",
      revision: 1,
      executor_id: "agent",
      attempts: [],
      decision: null,
    })),
    created_at:
      id === "latest" ? "2026-11-03T02:00:00Z" : "2026-11-03T01:00:00Z",
    updated_at: "",
  });
}
const issue = (id = "issue", execution: unknown = null) =>
  ({ id, execution, assignee_type: "squad", assignee_id: "s" }) as Issue;
it("distinguishes concurrent active instances in the history control", async () => {
  const first = snapshot("old"),
    next = { ...snapshot("latest"), status: "queued" };
  state.list.mockResolvedValue({ items: [first, next], limit: 50, offset: 0 });
  state.detail.mockResolvedValue(next);
  mount();
  expect(await screen.findByText("2 active runs")).toBeTruthy();
  const picker = screen.getByRole("combobox") as HTMLSelectElement;
  expect(picker.value).toBe("latest");
  expect(
    [...picker.options].every((option) =>
      option.textContent?.includes("Active"),
    ),
  ).toBe(true);
});
function mount(value = issue()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  clients.push(client);
  const content = (v: Issue) => (
    <QueryClientProvider client={client}>
      <IssuePipelineCard issue={v} />
    </QueryClientProvider>
  );
  const view = render(content(value));
  return { client, rerender: (v: Issue) => view.rerender(content(v)) };
}
it("keeps a selected historical frozen snapshot on matching events/reconnect and opens its exact node without introducing sidebar write actions", async () => {
  const active = snapshot(),
    history = snapshot("latest", "issue", "failed");
  history.jobs[0]!.status = "failed";
  state.list.mockResolvedValue({
    items: [history, active],
    limit: 50,
    offset: 0,
  });
  state.detail.mockImplementation(async (id: string) =>
    id === "latest" ? history : active,
  );
  mount();
  await screen.findByText("Frozen implementation");
  expect(
    screen.getByTestId("issue-pipeline-card").getAttribute("data-progress-run"),
  ).toBe("active");
  expect(await screen.findByText("Approval owner: Actual owner")).toBeTruthy();
  for (const name of ["Approve", "Reject", "Retry", "Cancel run", "Start run"])
    expect(screen.queryByRole("button", { name })).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Run history" }), {
    target: { value: "latest" },
  });
  await waitFor(() =>
    expect(
      screen
        .getByTestId("issue-pipeline-card")
        .getAttribute("data-progress-run"),
    ).toBe("latest"),
  );
  await act(async () => {
    state.events.get("pipeline:updated")?.({ issue_id: "issue" });
    state.events.get("reconnect")?.();
  });
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(
    "latest",
  );
  fireEvent.click(screen.getByRole("button", { name: /Frozen sign-off/ }));
  expect(await screen.findByText("latest/gate")).toBeTruthy();
  expect(screen.getByTestId("pipeline-node-details")).toBeTruthy();
});
it("renders loading before any response is acknowledged", () => {
  state.list.mockReturnValue(new Promise(() => {}));
  mount(issue("issue", { mode: "pipeline" }));
  expect(screen.getByRole("status").textContent).toBe(en.pipeline.loading);
});
it.each([
  [403, en.v18.forbidden],
  [503, en.v18.load_failed],
  [200, en.v18.invalid_response],
])("renders a distinct response state for HTTP %s", async (status, text) => {
  state.list.mockRejectedValue(
    status === 200
      ? new Error("Invalid pipeline run list response")
      : new ApiError("unavailable", status, "Error"),
  );
  mount();
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(text));
});
it("does not infer pipeline execution from a later squad default but retains actual history", async () => {
  const v = mount();
  await waitFor(() => expect(state.list).toHaveBeenCalled());
  expect(screen.queryByTestId("issue-pipeline-card")).toBeNull();
  const old = snapshot("old");
  state.list.mockResolvedValue({ items: [old], limit: 50, offset: 0 });
  state.detail.mockResolvedValue(old);
  await act(async () => {
    await v.client.invalidateQueries();
  });
  expect(await screen.findByText("Frozen implementation")).toBeTruthy();
});
it("does not cross task or workspace boundaries when an old slow request finishes", async () => {
  let finish!: (value: unknown) => void;
  const old = snapshot("old"),
    next = snapshot("next", "other");
  state.list.mockImplementation(({ issue_id }: { issue_id: string }) =>
    issue_id === "issue"
      ? new Promise((resolve) => (finish = resolve))
      : Promise.resolve({ items: [next], limit: 50, offset: 0 }),
  );
  state.detail.mockResolvedValue(next);
  const v = mount();
  v.rerender(issue("other"));
  await screen.findByText("Frozen implementation");
  await act(async () => finish({ items: [old], limit: 50, offset: 0 }));
  expect(
    screen.getByTestId("issue-pipeline-card").getAttribute("data-progress-run"),
  ).toBe("next");
  state.ws = "other-ws";
  state.list.mockResolvedValue({ items: [], limit: 50, offset: 0 });
  v.rerender(issue("other"));
  await waitFor(() =>
    expect(screen.queryByTestId("issue-pipeline-card")).toBeNull(),
  );
});
it("marks future and incomplete node data unknown without a green success meter", async () => {
  const run = snapshot();
  run.jobs[0]!.status = "future_policy_hold";
  run.jobs[1]!.status = "succeeded";
  state.list.mockResolvedValue({ items: [run], limit: 50, offset: 0 });
  state.detail.mockResolvedValue(run);
  mount();
  expect(
    await screen.findByText("Unknown status (future_policy_hold)"),
  ).toBeTruthy();
  expect(screen.getByText(en.v18.uncertain)).toBeTruthy();
  expect(screen.getByTestId("pipeline-progress-counts").textContent).toContain(
    "Succeeded 1/2",
  );
  expect(
    screen.getByTestId("pipeline-progress-counts").querySelector(".bg-success"),
  ).toBeNull();
});
