import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PipelineRunSchema, pipelineKeys, usePipelineReviewStore,
} from "@multica/core/pipelines";
import en from "../locales/en/squads.json";
import { PipelineRunDetails } from "./run-details";

const state = vi.hoisted(() => ({
  run: {} as unknown,
  member: true,
  decide: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
  handlers: new Map<string, () => void>(),
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multica/core/permissions", () => ({
  useCurrentMember: () => ({
    member: state.member ? { user_id: "human", role: "member" } : null,
  }),
}));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => "/issues/" + id }),
}));
vi.mock("@multica/core/realtime", () => ({
  useWSEvent: () => {}, useWSReconnect: () => {},
}));
vi.mock("../i18n", () => ({
  useT: () => ({ t: (select: (value: typeof en) => string) => select(en) }),
}));
vi.mock("../editor", () => ({
  ReadonlyContent: ({ content }: { content: string }) => <pre>{content}</pre>,
}));
vi.mock("../navigation", () => ({
  AppLink: ({ children, href }: { children: ReactNode; href: string }) =>
    <a href={href}>{children}</a>,
  useNavigation: () => ({}),
}));
vi.mock("../projects/documents/associate-document", () => ({ AssociateDocument: () => null }));
// Capture callbacks so disabled controls cannot conceal an unguarded handler.
vi.mock("@multica/ui/components/ui/button", () => ({
  Button: ({ children, onClick, disabled }: {
    children?: ReactNode; onClick?: () => void; disabled?: boolean;
  }) => {
    if (typeof children === "string" && onClick) state.handlers.set(children, onClick);
    return <button disabled={disabled} onClick={onClick}>{children}</button>;
  },
}));
vi.mock("@multica/core/api", async (original) => ({
  ...(await original<typeof import("@multica/core/api")>()),
  api: {
    getPipelineRun: async () => state.run,
    listPipelineArtifacts: async () => ({ items: [], limit: 50, offset: 0 }),
    listMembers: async () => [], listAgents: async () => [],
    decidePipelineJob: state.decide,
    cancelPipelineRun: state.cancel,
    retryPipelineJob: state.retry,
  },
}));

const clients: QueryClient[] = [];
beforeEach(() => {
  state.member = true;
  state.handlers.clear();
  for (const call of [state.decide, state.cancel, state.retry]) {
    call.mockReset().mockImplementation(async () => state.run);
  }
});
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  usePipelineReviewStore.getState().clearDraft();
  vi.restoreAllMocks();
});

type SnapshotOptions = {
  status?: string;
  kind?: string;
  version?: string;
  nodeType?: string;
  jobStatus?: string;
  parallel?: boolean;
  parallelWhen?: string;
};
function snapshot({
  status = "waiting_approval", kind = "gitlab_yaml", version = "1",
  nodeType = "manual", jobStatus = "waiting_approval", parallel = false, parallelWhen = "on_success",
}: SnapshotOptions = {}) {
  const node = {
    id: "review", source_id: "review", title: "Review gate", type: nodeType,
    instructions: "Original review instructions", needs: [], artifact_sources: [],
    paths: [], when: nodeType === "manual" ? "manual" : "on_success",
    allow_failure: status === "succeeded", retry: 0,
  };
  const worker = { ...node, id: "worker", source_id: "worker", title: "Parallel worker", type: "agent", when: parallelWhen };
  const nodes = parallel ? [node, worker] : [node];
  return PipelineRunSchema.parse({
    id: "run", workspace_id: "ws", issue_id: "issue", squad_id: "s", definition_id: "d",
    creator_id: "human", revision: 1, status, reason: "",
    plan: { kind, compiler_version: version, source_hash: "hash", stages: nodes.map((n) => n.id), nodes },
    policy: "", issue_title: "Compatibility probe", issue_description: "", issue_revision: 1,
    project_id: "", workflow_id: "", workflow_step: "", projected_status: "in_review",
    jobs: nodes.map((n) => ({
      node: n, status: n.id === "review" ? jobStatus : "running", reason: "",
      revision: 1, executor_id: "", attempts: [], decision: null,
    })),
    created_at: "", updated_at: "",
  });
}
function mount(options: SnapshotOptions = {}) {
  state.run = snapshot(options);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><PipelineRunDetails runId="run" /></QueryClientProvider>);
  return client;
}
async function force(name: string) {
  const handler = state.handlers.get(name);
  expect(handler).toBeTypeOf("function");
  await act(async () => { handler!(); });
}
async function replace(client: QueryClient, run: ReturnType<typeof snapshot>) {
  state.run = run;
  await act(async () => { client.setQueryData(pipelineKeys.run("ws", "run"), run); });
}

it("allows a known waiting approval as a control", async () => {
  mount();
  expect(await screen.findByRole("button", { name: "Approve" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(state.decide).toHaveBeenCalledWith("run", "review", expect.objectContaining({
    decision: "approve", expected_revision: 1, idempotency_key: expect.any(String),
  })));
});
it.each(["on_success", "on_failure"])("allows a gate while a v1 %s agent keeps the run running", async (parallelWhen) => {
  mount({ status: "running", parallel: true, parallelWhen });
  expect(await screen.findByRole("button", { name: "Approve" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(state.decide).toHaveBeenCalledTimes(1));
});
it.each([
  { options: { status: "future_policy_hold" }, message: en.pipeline.readonly_status, value: "future_policy_hold" },
  { options: { kind: "future_yaml" }, message: en.pipeline.readonly_plan, value: "future_yaml" },
  { options: { version: "2" }, message: en.pipeline.readonly_plan, value: "compiler_version=2" },
  { options: { jobStatus: "future_node_hold" }, message: en.pipeline.readonly_job, value: "review: future_node_hold" },
  { options: { status: "running", parallel: true, parallelWhen: "always" }, message: en.pipeline.readonly_plan, value: "node.when=always" },
])("preserves reading/opinions and guards both decision handlers for $value", async ({ options, message, value }) => {
  const client = mount();
  await screen.findByRole("button", { name: "Approve" });
  fireEvent.change(screen.getByLabelText(en.pipeline.reason), { target: { value: "Retain my opinion" } });
  await replace(client, snapshot(options));
  await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled());
  expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  expect(screen.getByLabelText(en.pipeline.reason)).toHaveValue("Retain my opinion");
  expect(screen.getByRole("status")).toHaveTextContent(message);
  expect(screen.getByRole("status")).toHaveTextContent(value);
  expect(screen.getByText("Original review instructions")).toBeVisible();
  await force("Approve");
  await force("Reject");
  expect(state.decide).not.toHaveBeenCalled();
});
it.each([{ status: "future_policy_hold" }, { kind: "future_yaml" }, { parallelWhen: "always" }])(
  "guards retry and cancellation callbacks for an unfamiliar snapshot %j",
  async (unknown) => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const client = mount({ status: "running", nodeType: "agent", jobStatus: "failed", parallel: true });
    await screen.findByRole("button", { name: en.pipeline.retry });
    await replace(client, snapshot({
      status: "running", nodeType: "agent", jobStatus: "failed", parallel: true, ...unknown,
    }));
    await waitFor(() => expect(screen.getByRole("button", { name: en.pipeline.retry })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeDisabled();
    await force(en.pipeline.retry);
    await force("Cancel run");
    expect(state.retry).not.toHaveBeenCalled();
    expect(state.cancel).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  },
);
it.each(["failed", "succeeded"])("keeps a known %s run's failed agent retryable", async (status) => {
  mount({ status, nodeType: "agent", jobStatus: "failed" });
  const retry = await screen.findByRole("button", { name: en.pipeline.retry });
  expect(retry).toBeEnabled();
  fireEvent.click(retry);
  await waitFor(() => expect(state.retry).toHaveBeenCalledWith("run", "review", expect.objectContaining({
    expected_revision: 1, idempotency_key: expect.any(String),
  })));
});
it("keeps cancellation available for an understood active run", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  mount({ status: "running", parallel: true });
  const cancel = await screen.findByRole("button", { name: "Cancel run" });
  expect(cancel).toBeEnabled();
  fireEvent.click(cancel);
  await waitFor(() => expect(state.cancel).toHaveBeenCalledTimes(1));
});
it("retains the reviewed revision and opinion until the user reviews a competing update", async () => {
  const client = mount();
  await screen.findByRole("button", { name: "Approve" });
  fireEvent.change(screen.getByLabelText(en.pipeline.reason), { target: { value: "My reviewed opinion" } });
  const changed = snapshot();
  changed.jobs[0]!.revision = 2;
  await replace(client, changed);
  await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled());
  expect(screen.getByLabelText(en.pipeline.reason)).toHaveValue("My reviewed opinion");
  await force("Approve");
  await force("Reject");
  expect(state.decide).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: en.pipeline.review_latest }));
  expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(state.decide).toHaveBeenCalledWith("run", "review", expect.objectContaining({
    expected_revision: 2, reason: "My reviewed opinion",
  })));
});
it("still requires human operation permission", async () => {
  state.member = false;
  mount();
  expect(await screen.findByRole("button", { name: "Approve" })).toBeDisabled();
  await force("Approve");
  expect(state.decide).not.toHaveBeenCalled();
});
it("does not send a blank rejection even if its disabled handler is invoked", async () => {
  mount();
  expect(await screen.findByRole("button", { name: "Reject" })).toBeDisabled();
  await force("Reject");
  expect(state.decide).not.toHaveBeenCalled();
});
it("continues to block inaccessible approval materials", async () => {
  const client = mount();
  await screen.findByRole("button", { name: "Approve" });
  const run = snapshot({ parallel: true });
  const gate = run.jobs[0]!;
  gate.node.needs = ["worker"];
  gate.node.artifact_sources = ["worker"];
  run.jobs[1]!.status = "succeeded";
  run.jobs[1]!.attempts = [{
    number: 1, task_id: "task", executor_id: "agent", status: "completed",
    inputs: [], usage: [], report: {
      result: "succeeded", report: "", artifacts: [{
        id: "missing", job_id: "worker", attempt: 1, path: "evidence.md", status: "missing",
      }],
    },
  }];
  await replace(client, run);
  await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled());
  await force("Approve");
  expect(state.decide).not.toHaveBeenCalled();
});
