import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import type { ReactNode } from "react";
import { IssueExecutionSchema } from "@multica/core/pipelines";
import { useIssueDraftStore } from "@multica/core/issues/stores/draft-store";
import en from "../locales/en/squads.json";
import {
  ExecutionSelectionField,
  useExecutionSelection,
} from "./execution-selection";
import { SquadPipelineCatalog } from "./catalog-workspace";
import { IssueExecutionPanel } from "./execution-summary";
import { testCandidates } from "./test-candidates";

const state = vi.hoisted(() => ({
  execution: {} as unknown,
  member: true,
  supported: true,
  catalogSupported: true,
  rename: vi.fn(),
  start: vi.fn(),
  updateSquad: vi.fn(),
  preview: vi.fn(),
  handlers: new Map<string, () => void>(),
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("@multica/core/permissions", () => ({
  useCurrentMember: () => ({
    member: state.member ? { user_id: "human" } : null,
  }),
}));
vi.mock("@multica/core/paths", () => ({
  useWorkspacePaths: () => ({ issueDetail: (id: string) => `/issues/${id}` }),
}));
vi.mock("@multica/core/realtime", () => ({
  useWSEvent: () => {},
  useWSReconnect: () => {},
}));
vi.mock("../i18n", () => ({
  useT: () => ({ t: (select: (v: typeof en) => string) => select(en) }),
}));
vi.mock("../navigation", () => ({
  AppLink: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@multica/ui/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => {
    if (typeof children === "string" && onClick)
      state.handlers.set(children, onClick);
    return (
      <button disabled={disabled} onClick={onClick}>
        {children}
      </button>
    );
  },
}));
vi.mock("@multica/core/api", async (original) => ({
  ...(await original<typeof import("@multica/core/api")>()),
  api: {
    getPipelineCandidates: async () => testCandidates,
    getPipelineCapabilities: async () => ({
      schema_version: 1,
      compiler_version: "2",
      kinds: ["gitlab_yaml", "hermes_yaml"],
      features: {
        human_owner_identity: true,
        stable_agent_binding: true,
        node_display_names: true,
        deliverable_descriptions: true,
        custom_nodes: true,
        manual_gates: true,
        gitlab_dag: true,
        hermes_forward_chain: true,
        pipeline_catalog: state.catalogSupported,
        task_execution_selection: state.supported,
        waiting_runtime_resume: state.supported,
        runtime_compatibility: state.supported,
      },
    }),
    listPipelineCatalog: async ({ squad_id }: { squad_id: string }) => ({
      items: [
        {
          id: `p-${squad_id}`,
          squad_id,
          name: `Named ${squad_id}`,
          executable_definition_id: `d-${squad_id}`,
        },
      ],
      limit: 100,
      offset: 0,
    }),
    getPipelineDefinition: async (id: string) => ({
      id,
      revision: 2,
      kind: "hermes_yaml",
      plan: {
        kind: "hermes_yaml",
        compiler_version: "2",
        source_hash: "hash",
        stages: [],
        nodes: [],
      },
    }),
    preflightPipelineExecution: state.preview,
    getIssueExecution: async () => ({ execution: state.execution }),
    startIssueExecution: state.start,
    updateSquad: state.updateSquad,
    renamePipelineCatalog: state.rename,
    listPipelineDefinitions: async () => ({ items: [], limit: 50, offset: 0 }),
  },
}));
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((c) => c.clear());
  clients.length = 0;
  useIssueDraftStore.getState().clearDraft();
  state.supported = true;
  state.catalogSupported = true;
  state.member = true;
  state.handlers.clear();
  vi.clearAllMocks();
});
function mount(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  clients.push(client);
  render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
  return client;
}
function execution(
  stateValue = "waiting_runtime",
  runtimeStatus = "supported",
  disk: boolean = true,
) {
  return IssueExecutionSchema.parse({
    requested_mode: "pipeline",
    mode: "pipeline",
    squad_id: "s1",
    pipeline_id: "p-s1",
    pipeline_name: "Named s1",
    definition_id: "d-s1",
    definition_revision: 2,
    creator_id: "human",
    state: stateValue,
    readiness: {
      ready: true,
      runtimes: [
        {
          runtime_id: "runtime",
          name: "Actual selected environment",
          status: runtimeStatus,
          reason: "actual_reason",
          required_capabilities: ["pipeline-task-selection-v1"],
          daemon: {
            version: "daemon-version",
            capabilities: ["pipeline-task-selection-v1"],
          },
          disk: disk
            ? {
                version: "disk-version",
                capabilities: ["pipeline-task-selection-v1"],
              }
            : null,
        },
      ],
    },
  });
}
function Harness() {
  const [squad, setSquad] = useState<string | undefined>("s1");
  const value = useExecutionSelection(squad);
  return (
    <>
      <button onClick={() => setSquad("s2")}>Other squad</button>
      <button onClick={() => setSquad(undefined)}>Personal</button>
      <button onClick={() => setSquad("s1")}>Original squad</button>
      <ExecutionSelectionField value={value} />
      <output data-testid="submitted">
        {JSON.stringify(value.submitSelection)}
      </output>
    </>
  );
}
it("scopes choices to the current squad, freezes its preview and remembers only valid selections", async () => {
  state.preview.mockImplementation(
    async ({ squad_id, execution: selection }) => ({
      ...execution(),
      squad_id,
      requested_mode: selection.mode,
      pipeline_id: `p-${squad_id}`,
      definition_id: `d-${squad_id}`,
    }),
  );
  mount(<Harness />);
  const selector = await screen.findByRole("combobox");
  await waitFor(() => expect(selector).toBeEnabled());
  await screen.findByRole("option", { name: /Named s1/ });
  fireEvent.change(selector, { target: { value: "p-s1" } });
  await waitFor(() =>
    expect(screen.getByTestId("submitted")).toHaveTextContent(
      '"definition_id":"d-s1"',
    ),
  );
  fireEvent.click(screen.getByText("Other squad"));
  await waitFor(() => expect(selector).toHaveValue("default"));
  expect(
    screen.queryByRole("option", { name: /Named s1/ }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Personal"));
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.getByTestId("submitted")).toBeEmptyDOMElement();
  fireEvent.click(screen.getByText("Original squad"));
  await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("p-s1"));
});
it.each(["future_state", "started"])(
  "does not enable a continuation handler for %s",
  async (value) => {
    state.execution = execution(value);
    mount(<IssueExecutionPanel issueId="existing" />);
    await screen.findByText("Named s1 · v2");
    const start = screen.queryByRole("button", { name: en.execution.start });
    if (start) {
      expect(start).toBeDisabled();
      await act(async () => state.handlers.get(en.execution.start)?.());
    }
    expect(state.start).not.toHaveBeenCalled();
  },
);
it.each(["unknown", "insufficient", "daemon_pending"])(
  "never starts from %s readiness even if ready is true",
  async (status) => {
    state.execution = execution("waiting_runtime", status);
    mount(<IssueExecutionPanel issueId="existing" />);
    const start = await screen.findByRole("button", {
      name: en.execution.start,
    });
    expect(start).toBeDisabled();
    await act(async () => state.handlers.get(en.execution.start)?.());
    expect(state.start).not.toHaveBeenCalled();
  },
);
it("keeps unknown disk identity separate and blocks a forced start", async () => {
  state.execution = execution("waiting_runtime", "supported", false);
  mount(<IssueExecutionPanel issueId="existing" />);
  await screen.findByText("Installed CLI: Unknown");
  expect(
    screen.getByText("Running daemon: daemon-version"),
  ).toBeInTheDocument();
  await act(async () => state.handlers.get(en.execution.start)?.());
  expect(state.start).not.toHaveBeenCalled();
});
it("starts only the existing issue and reflects the confirmed response", async () => {
  state.execution = execution();
  state.start.mockImplementation(async () => {
    state.execution = execution("started");
    return { execution: state.execution, run: { id: "one-run" } };
  });
  mount(<IssueExecutionPanel issueId="existing" />);
  const start = await screen.findByRole("button", { name: en.execution.start });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await waitFor(() => expect(state.start).toHaveBeenCalledWith("existing"));
  await screen.findByText(en.execution.started);
});
it.each(["member", "server"])(
  "keeps continuation read-only without known %s permission/capability",
  async (cause) => {
    state.member = cause !== "member";
    state.supported = cause !== "server";
    state.execution = execution();
    mount(<IssueExecutionPanel issueId="existing" />);
    const start = await screen.findByRole("button", {
      name: en.execution.start,
    });
    expect(start).toBeDisabled();
    await act(async () => state.handlers.get(en.execution.start)?.());
    expect(state.start).not.toHaveBeenCalled();
  },
);

it("catalog viewers can read names and versions but cannot force a squad-default write", async () => {
  mount(
    <SquadPipelineCatalog
      squad={{
        id: "s1",
        workspace_id: "ws",
        name: "Team",
        description: "",
        instructions: "",
        avatar_url: null,
        leader_id: "agent",
        creator_id: "human",
        created_at: "",
        updated_at: "",
        archived_at: null,
        archived_by: null,
        revision: 1,
        instructions_mode: "markdown",
      }}
      members={[]}
      canManage={false}
      getName={(_, id) => id}
      onDirtyChange={() => {}}
    />,
  );
  const list = await screen.findByRole("combobox", {
    name: en.v17.choose_pipeline,
  });
  expect(list).toHaveValue("p-s1");
  expect(
    screen.queryByRole("combobox", { name: en.execution.default_mode }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: en.v17.new_pipeline }),
  ).toBeDisabled();
  await act(async () => state.handlers.get(en.v17.new_pipeline)?.());
  expect(state.updateSquad).not.toHaveBeenCalled();
  expect(screen.getByText(en.execution.readonly)).toBeInTheDocument();
});

it("keeps a cached catalog read-only when the server withdraws catalog capability", async () => {
  const client = mount(
    <SquadPipelineCatalog
      squad={{
        id: "s1",
        workspace_id: "ws",
        name: "Team",
        description: "",
        instructions: "",
        avatar_url: null,
        leader_id: "agent",
        creator_id: "human",
        created_at: "",
        updated_at: "",
        archived_at: null,
        archived_by: null,
        revision: 1,
        instructions_mode: "markdown",
      }}
      members={[]}
      canManage
      getName={(_, id) => id}
      onDirtyChange={() => {}}
    />,
  );
  const name = await screen.findByRole("textbox", { name: en.execution.name });
  await waitFor(() => expect(name).toHaveValue("Named s1"));
  fireEvent.change(name, { target: { value: "Preserved rename draft" } });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: en.execution.rename }),
    ).toBeEnabled(),
  );
  state.catalogSupported = false;
  await act(async () => {
    await client.invalidateQueries({
      queryKey: ["pipelines", "ws", "capabilities"],
    });
  });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: en.execution.rename }),
    ).toBeDisabled(),
  );
  expect(name).toHaveValue("Preserved rename draft");
  await act(async () => state.handlers.get(en.execution.rename)?.());
  expect(
    screen.queryByRole("combobox", { name: en.execution.default_mode }),
  ).not.toBeInTheDocument();
  expect(state.rename).not.toHaveBeenCalled();
  expect(state.updateSquad).not.toHaveBeenCalled();
});
