import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { useState, forwardRef, type ComponentProps } from "react";
import {
  usePipelineCanvasStore,
  usePipelineNodeDraftStore,
} from "@multica/core/pipelines";
import en from "../locales/en/squads.json";
import { DefinitionCanvas } from "./definition-canvas";
import { testCandidates } from "./test-candidates";

const calls = vi.hoisted(() => ({
  change: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  connect: undefined as ((from: string, to: string) => void) | undefined,
  reconnect: undefined as
    | ((id: string, from: string, to: string) => void)
    | undefined,
  buttons: new Map<string, () => void>(),
}));
vi.mock("../i18n", () => ({
  useT: () => ({ t: (select: (value: typeof en) => string) => select(en) }),
}));
vi.mock("@multica/ui/components/ui/button", () => ({
  Button: forwardRef<
    HTMLButtonElement,
    ComponentProps<"button"> & { variant?: string; size?: string }
  >(function MockButton(
    { variant: _variant, size: _size, children, onClick, ...props },
    ref,
  ) {
    if (typeof children === "string" && onClick)
      calls.buttons.set(children, () => onClick({} as never));
    return (
      <button ref={ref} {...props} onClick={onClick}>
        {children}
      </button>
    );
  }),
}));
vi.mock("./canvas-viewport", () => ({
  CanvasViewport: (props: {
    model: { nodes: { id: string }[] };
    onSelect: (id: string) => void;
    onConnect: (from: string, to: string) => void;
    onReconnect: (id: string, from: string, to: string) => void;
  }) => {
    calls.connect = props.onConnect;
    calls.reconnect = props.onReconnect;
    return (
      <div>
        {props.model.nodes.map((n) => (
          <button key={n.id} onClick={() => props.onSelect(n.id)}>
            {n.id}
          </button>
        ))}
      </div>
    );
  },
}));
const original =
  "kind: gitlab_yaml\nstages: [work]\nalpha: {stage: work, instructions: Keep the full original instruction., needs: []}\nbeta: {stage: work, instructions: Original beta, needs: [alpha]}\n";
function Harness({
  canEdit = true,
  reason = "",
}: {
  canEdit?: boolean;
  reason?: string;
}) {
  const [source, setSource] = useState(original);
  return (
    <>
      <button onClick={() => setSource("kind: gitlab_yaml\nstages: [")}>
        Invalid YAML input
      </button>
      <output data-testid="source">{source}</output>
      <DefinitionCanvas
        source={source}
        scope="w:s:p"
        canEdit={canEdit}
        readOnlyReason={reason}
        candidates={testCandidates}
        onChange={(value) => {
          calls.change(value);
          setSource(value);
        }}
        onShowYAML={() => {}}
        onUndo={calls.undo}
        onRedo={calls.redo}
        canUndo
        canRedo
      />
    </>
  );
}
afterEach(() => {
  cleanup();
  usePipelineNodeDraftStore.getState().clearDraft();
  usePipelineCanvasStore.getState().clearDraft();
  vi.clearAllMocks();
  calls.buttons.clear();
});
it("adds a source node and opens its properties; cancelling an earlier add keeps the source", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: en.v17.add_node }));
  let dialog = screen.getByRole("dialog", { name: en.v17.add_node });
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: en.v17.node_name }),
    { target: { value: "cancelled" } },
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: en.pipeline.cancel }),
  );
  expect(calls.change).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: en.v17.add_node })).toHaveFocus(),
  );
  fireEvent.click(screen.getByRole("button", { name: en.v17.add_node }));
  dialog = screen.getByRole("dialog", { name: en.v17.add_node });
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: en.v17.node_name }),
    { target: { value: "custom" } },
  );
  fireEvent.click(
    within(dialog).getByRole("tab", { name: en.v17.instructions }),
  );
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: en.canvas.instructions }),
    { target: { value: "Complete new instructions.\nSecond line." } },
  );
  fireEvent.submit(within(dialog).getByTestId("canvas-node-form"));
  expect(calls.change).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("canvas-properties")).toBeInTheDocument();
  expect(
    within(screen.getByTestId("canvas-properties")).getByRole("textbox", {
      name: en.v17.node_name,
    }),
  ).toHaveValue("custom");
});
it.each(["permission", "request", "capability"])(
  "blocks the actual form and forced connection handlers after losing %s",
  (reason) => {
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: en.v17.add_node }));
    const dialog = screen.getByRole("dialog", { name: en.v17.add_node });
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: en.v17.node_name }),
      { target: { value: "not_written" } },
    );
    fireEvent.click(
      within(dialog).getByRole("tab", { name: en.v17.instructions }),
    );
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: en.canvas.instructions }),
      { target: { value: "Do not write" } },
    );
    view.rerender(<Harness canEdit={false} reason={reason} />);
    expect(
      within(dialog).getByRole("textbox", { name: en.canvas.instructions }),
    ).toBeDisabled();
    fireEvent.submit(within(dialog).getByTestId("canvas-node-form"));
    calls.connect?.("alpha", "beta");
    calls.reconnect?.("edge", "alpha", "beta");
    calls.buttons.get(en.v17.add_node)?.();
    calls.buttons.get(en.canvas.undo)?.();
    expect(calls.change).not.toHaveBeenCalled();
    expect(calls.undo).not.toHaveBeenCalled();
    expect(screen.getByTestId("source").textContent).toBe(original);
  },
);
it("retains invalid YAML and the previous read-only graph without writing from it", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Invalid YAML input" }));
  expect(screen.getByText(en.canvas.stale)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "alpha" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: en.v17.add_node })).toBeDisabled();
  calls.connect?.("alpha", "beta");
  calls.buttons.get(en.v17.add_node)?.();
  expect(calls.change).not.toHaveBeenCalled();
  expect(screen.getByTestId("source").textContent).toBe(
    "kind: gitlab_yaml\nstages: [",
  );
});
it("ignores Delete in an input, confirms deletion from the node and supports cancellation", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "alpha" }));
  const properties = screen.getByTestId("canvas-properties"),
    id = within(properties).getByRole("textbox", { name: en.v17.node_name });
  id.focus();
  fireEvent.keyDown(id, { key: "Delete" });
  expect(
    screen.queryByRole("dialog", { name: en.canvas.delete_title }),
  ).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("button", { name: "alpha" }), {
    key: "Delete",
  });
  let dialog = screen.getByRole("dialog", { name: en.canvas.delete_title });
  expect(dialog).toHaveTextContent("alpha → beta");
  fireEvent.click(
    within(dialog).getByRole("button", { name: en.pipeline.cancel }),
  );
  expect(calls.change).not.toHaveBeenCalled();
  fireEvent.click(
    within(properties).getByRole("button", { name: en.canvas.delete_node }),
  );
  dialog = screen.getByRole("dialog", { name: en.canvas.delete_title });
  fireEvent.click(
    within(dialog).getByRole("button", { name: en.canvas.confirm }),
  );
  expect(calls.change).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("source")).toHaveTextContent("needs: []");
  expect(
    screen.queryByRole("button", { name: "alpha" }),
  ).not.toBeInTheDocument();
});
it("does not expose executor fields for a Hermes manual gate", () => {
  const text =
    "kind: hermes_yaml\ngates: {review: {type: manual}}\nstates: {work: {entry: Full original entry, gate: review}}\n";
  render(
    <DefinitionCanvas
      source={text}
      scope="w:s:h"
      canEdit
      candidates={testCandidates}
      onChange={calls.change}
      onShowYAML={() => {}}
      onUndo={calls.undo}
      onRedo={calls.redo}
      canUndo={false}
      canRedo={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "work.gate.review" }));
  const properties = within(screen.getByTestId("canvas-properties"));
  fireEvent.click(properties.getByText(en.v17.advanced));
  expect(
    properties.getByRole("textbox", { name: en.canvas.gate_id }),
  ).toHaveValue("review");
  expect(
    properties.queryByRole("combobox", { name: en.v17.executor }),
  ).not.toBeInTheDocument();
  expect(properties.queryByRole("spinbutton")).not.toBeInTheDocument();
  expect(
    properties.queryByRole("checkbox", { name: en.canvas.allow_failure }),
  ).not.toBeInTheDocument();
  expect(
    properties.queryByRole("textbox", { name: en.canvas.output }),
  ).not.toBeInTheDocument();
});
it("edits the supported GitLab manual failure policy without exposing executor configuration", () => {
  const source =
    "kind: gitlab_yaml\nstages: [review]\ngate: {stage: review, when: manual}\n";
  render(
    <DefinitionCanvas
      source={source}
      scope="w:s:g"
      canEdit
      candidates={testCandidates}
      onChange={calls.change}
      onShowYAML={() => {}}
      onUndo={calls.undo}
      onRedo={calls.redo}
      canUndo={false}
      canRedo={false}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "gate" }));
  const properties = within(screen.getByTestId("canvas-properties"));
  fireEvent.click(properties.getByText(en.v17.advanced));
  fireEvent.click(
    properties.getByRole("checkbox", { name: en.canvas.allow_failure }),
  );
  fireEvent.submit(properties.getByTestId("canvas-node-form"));
  expect(calls.change).toHaveBeenCalledOnce();
  expect(calls.change.mock.calls[0]![0]).toContain("allow_failure: true");
  expect(properties.queryByRole("spinbutton")).not.toBeInTheDocument();
});
it("retains unapplied properties across selections and makes source conflicts explicit", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "alpha" }));
  let form = within(screen.getByTestId("canvas-properties"));
  fireEvent.change(form.getByRole("textbox", { name: en.v17.node_name }), {
    target: { value: "Retained name" },
  });
  fireEvent.click(screen.getByRole("button", { name: "beta" }));
  fireEvent.click(screen.getByRole("button", { name: "alpha" }));
  form = within(screen.getByTestId("canvas-properties"));
  expect(form.getByRole("textbox", { name: en.v17.node_name })).toHaveValue(
    "Retained name",
  );
  expect(calls.change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Invalid YAML input" }));
  fireEvent.submit(form.getByTestId("canvas-node-form"));
  expect(calls.change).not.toHaveBeenCalled();
});
it("never invents candidate identities when candidate loading is unavailable", () => {
  render(
    <DefinitionCanvas
      source={original}
      scope="w:s:missing"
      canEdit
      candidates={null}
      onChange={calls.change}
      onShowYAML={() => {}}
      onUndo={calls.undo}
      onRedo={calls.redo}
      canUndo={false}
      canRedo={false}
    />,
  );
  expect(screen.getByRole("button", { name: en.v17.add_node })).toBeDisabled();
  calls.connect?.("alpha", "beta");
  expect(calls.change).not.toHaveBeenCalled();
});
