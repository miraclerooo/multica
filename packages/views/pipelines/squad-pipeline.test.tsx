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
import type { Squad } from "@multica/core/types";
import {
  putPipelineDraft,
  usePipelineDraftStore,
  usePipelineWorkbenchStore,
} from "@multica/core/pipelines";
import en from "../locales/en/squads.json";
import { SquadPipeline } from "./squad-pipeline";

const calls = vi.hoisted(() => ({
  save: vi.fn(),
  validate: vi.fn(),
  createSession: vi.fn(),
  send: vi.fn(),
  active: false,
  messages: [] as { id: string; role: string; content: string }[],
  events: {} as Record<string, (payload: unknown) => void>,
  compiler: "1",
}));
vi.mock("@multica/core/realtime", async () => {
  const { useEffect } = await import("react");
  return {
    useWSEvent: (event: string, handler: (payload: unknown) => void) => {
      useEffect(() => {
        calls.events[event] = handler;
        return () => {
          if (calls.events[event] === handler) delete calls.events[event];
        };
      }, [event, handler]);
    },
  };
});
vi.mock("../editor", () => ({
  ReadonlyContent: ({ content }: { content: string }) => <pre>{content}</pre>,
}));
vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws" }));
vi.mock("../i18n", () => ({
  useT: () => ({ t: (selector: (value: typeof en) => string) => selector(en) }),
}));
vi.mock("@multica/core/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@multica/core/api")>()),
  api: {
    getPipelineCapabilities: async () => ({
      schema_version: 1,
      compiler_version: calls.compiler,
      kinds: ["gitlab_yaml", "hermes_yaml"],
      features: {custom_nodes:true,manual_gates:true,gitlab_dag:true,hermes_forward_chain:true},
      limits: {},
    }),
    listPipelineDefinitions: async () => ({ items: [], limit: 50, offset: 0 }),
    validatePipeline: calls.validate,
    createPipelineDefinition: calls.save,
    listAgents: async () => [
      { id: "mika", system_key: "mika", archived_at: null },
    ],
    createChatSession: calls.createSession,
    sendChatMessage: calls.send,
    listChatMessages: async () => calls.messages,
    getPendingChatTask: async () =>
      calls.active ? { task_id: "task", status: "running" } : {},
  },
}));
const squad: Squad = {
  id: "s",
  workspace_id: "ws",
  name: "Solo squad",
  description: "",
  instructions: "Original policy",
  avatar_url: null,
  leader_id: "leader",
  creator_id: "owner",
  created_at: "",
  updated_at: "",
  archived_at: null,
  archived_by: null,
  revision: 1,
  instructions_mode: "markdown",
};
const source =
  "kind: gitlab_yaml\nstages: [custom]\ncollect:\n  stage: custom\n  instructions: Preserve my original instructions.\n";
function mount(canManage: boolean, busy = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <SquadPipeline
        catalog={{id: "p", workspace_id: "ws", squad_id: "s", name: "Custom", revision: 1, executable_definition_id: null, legacy: false, created_at: "", updated_at: ""}}
        squad={squad}
        members={[]}
        canManage={canManage}
        externalBusy={busy}
        getName={(_type, id) => id}
        onDirtyChange={() => {}}
      />
    </QueryClientProvider>,
  );
  return client;
}
afterEach(() => {
  cleanup();
  usePipelineDraftStore.getState().clearDraft();
  usePipelineWorkbenchStore.getState().clearDraft();
  calls.active = false;
  calls.messages = [];
  calls.events = {};
  calls.compiler = "1";
  vi.clearAllMocks();
});
it.each(["compiler", "pending", "plan"])("blocks definition canvas and save handlers for %s uncertainty", async cause => {
  calls.compiler=cause==="compiler"?"future":"1";
  calls.validate.mockResolvedValue({kind:"gitlab_yaml",syntax_valid:true,binding_valid:true,diagnostics:[],plan:{kind:"gitlab_yaml",compiler_version:cause==="plan"?"future":"1",source_hash:"hash",stages:["custom"],nodes:[]}});
  putPipelineDraft("ws:s:p",source,"",1);
  const client=mount(true,cause==="pending");
  await waitFor(()=>expect(calls.validate).toHaveBeenCalled());
  const editor=screen.getByRole("textbox",{name:"YAML"});
  if(cause!=="plan") {
    expect(editor).toHaveAttribute("readonly");
    fireEvent.change(editor,{target:{value:"forbidden replacement"}});
    expect(editor).toHaveValue(source);
  }
  fireEvent.keyDown(editor,{key:"s",ctrlKey:true});
  expect(screen.getByRole("button",{name:"Save version"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button",{name:"Flow graph"}));
  await waitFor(()=>expect(screen.getByRole("button",{name:"Add execution node"})).toBeDisabled());
  fireEvent.click(screen.getByRole("button",{name:"Add execution node"}));
  expect(screen.queryByRole("dialog",{name:"Add execution node"})).not.toBeInTheDocument();
  expect(calls.save).not.toHaveBeenCalled();client.clear();
});
it("allows a viewer to read the original draft while refusing edits and keyboard saves", async () => {
  calls.validate.mockResolvedValue({
    kind: "gitlab_yaml",
    syntax_valid: true,
    binding_valid: true,
    diagnostics: [],
    plan: {
      kind: "gitlab_yaml",
      compiler_version: "1",
      source_hash: "hash",
      stages: ["custom"],
      nodes: [],
    },
  });
  putPipelineDraft("ws:s:p", source, "", 1);
  const client = mount(false);
  const editor = screen.getByRole("textbox", { name: "YAML" });
  expect(editor).toHaveValue(source);
  expect(editor).toHaveAttribute("readonly");
  expect(screen.queryByRole("combobox", { name: "Execution mode" })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Save and enable" }),
  ).not.toBeInTheDocument();
  fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
  expect(calls.save).not.toHaveBeenCalled();
  await waitFor(() => expect(calls.validate).toHaveBeenCalled());
  client.clear();
});
it("keeps an unknown dialect readable and disables actions until the user supplies a supported definition", async () => {
  putPipelineDraft("ws:s:p", "kind: future_yaml\ncustom: untouched\n", "", 1);
  const client = mount(true);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Dialect" })).toHaveValue(
      "future_yaml",
    ),
  );
  expect(screen.getByRole("textbox", { name: "YAML" })).toHaveValue(
    "kind: future_yaml\ncustom: untouched\n",
  );
  expect(screen.getByRole("button", { name: "Save version" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Save and enable" }),
  ).toBeDisabled();
  expect(calls.validate).not.toHaveBeenCalled();
  client.clear();
});

it("keeps Mika's session and unsent request when closing, and consumes the real chat completion event without publishing", async () => {
  calls.validate.mockResolvedValue({
    kind: "gitlab_yaml",
    syntax_valid: true,
    binding_valid: true,
    diagnostics: [],
    plan: {
      kind: "gitlab_yaml",
      compiler_version: "1",
      source_hash: "hash",
      stages: ["custom"],
      nodes: [],
    },
  });
  calls.createSession.mockResolvedValue({ id: "session" });
  calls.send.mockImplementation(async () => {
    calls.active = true;
    return {};
  });
  putPipelineDraft("ws:s:p", source, "", 1);
  const client = mount(true);
  fireEvent.click(screen.getByRole("button", { name: "Mika workbench" }));
  fireEvent.change(screen.getByLabelText("Requirements for Mika"), {
    target: { value: "Include a summary" },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Ask Mika" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Ask Mika" }));
  await waitFor(() => expect(calls.send).toHaveBeenCalled());
  expect(calls.send.mock.calls[0]?.[1]).toContain("Preserve kind gitlab_yaml");
  expect(calls.send.mock.calls[0]?.[1]).toContain("Original policy");
  await screen.findByText("Waiting for Mika");
  fireEvent.change(screen.getByLabelText("Requirements for Mika"), {
    target: { value: "Keep this unsent request" },
  });
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Mika workbench" }));
  expect(screen.getByLabelText("Requirements for Mika")).toHaveValue(
    "Keep this unsent request",
  );
  const proposed = source.replace(
    "Preserve my original instructions.",
    "Preserve my original instructions. Include a summary.",
  );
  calls.messages = [
    {
      id: "reply",
      role: "assistant",
      content: ["```yaml", proposed].join(String.fromCharCode(10)) + "```",
    },
  ];
  calls.active = false;
  await screen.findByRole("dialog", { name: "Mika workbench" });
  await waitFor(() => expect(calls.events["chat:done"]).toBeTypeOf("function"));
  await act(async () => {
    calls.events["chat:done"]?.({
      chat_session_id: "session",
      task_id: "task",
    });
  });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Use complete YAML draft" }),
    ).toBeEnabled(),
  );
  expect(calls.createSession).toHaveBeenCalledTimes(1);
  expect(calls.save).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Use complete YAML draft" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("textbox", { name: "YAML" })).toHaveValue(proposed);
  expect(calls.save).not.toHaveBeenCalled();
  client.clear();
});
