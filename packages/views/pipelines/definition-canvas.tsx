"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyCanvasEdit,
  canvasDeletionImpact,
  canvasStageConversions,
  CanvasEditError,
  readCanvasDocument,
  editPipelineCanvasLayout,
  usePipelineCanvasStore,
  type CanvasCommand,
  type CanvasDocument,
} from "@multica/core/pipelines";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogFooter,
  DialogHeader,
  DialogDescription,
  DialogTrigger,
} from "@multica/ui/components/ui/dialog";
import { CanvasNodeForm, type CanvasRole } from "./canvas-node-form";
import { CanvasViewport } from "./canvas-viewport";
import { useT } from "../i18n";

type EdgeDraft = { id?: string; from: string; to: string; material: boolean };
export function DefinitionCanvas({
  source,
  fallbackSource,
  scope,
  canEdit,
  readOnlyReason,
  roles,
  emptyKinds = ["gitlab_yaml"],
  onChange,
  onShowYAML,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: {
  source: string;
  fallbackSource?: string;
  scope: string;
  canEdit: boolean;
  readOnlyReason?: string;
  roles: CanvasRole[];
  emptyKinds?: string[];
  onChange: (source: string) => void;
  onShowYAML: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}) {
  const { t } = useT("squads");
  const projection = useMemo(() => readCanvasDocument(source), [source]);
  const previous = useRef<CanvasDocument | null>(null);
  useEffect(() => {
    if (!projection.restriction) previous.current = projection;
  }, [projection]);
  const fallback = useMemo(
    () => (fallbackSource ? readCanvasDocument(fallbackSource) : null),
    [fallbackSource],
  );
  const model = projection.restriction
    ? (previous.current ??
      (fallback?.restriction ? null : fallback) ??
      projection)
    : projection;
  const writable = canEdit && !projection.restriction;
  const [selected, setSelected] = useState<string>();
  const [selectedEdge, setSelectedEdge] = useState<string>();
  const [adding, setAdding] = useState<"agent" | "manual" | null>(null);
  const [edgeDraft, setEdgeDraft] = useState<EdgeDraft | null>(null);
  const [pending, setPending] = useState<{
    command: CanvasCommand;
    source: string;
    conversions: string[];
  } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const addAgent = useRef<HTMLButtonElement>(null),
    addGate = useRef<HTMLButtonElement>(null),
    addEdge = useRef<HTMLButtonElement>(null),
    nodePicker = useRef<HTMLSelectElement>(null);
  const addFocus = useRef<"agent" | "manual">("agent");
  const node = model.nodes.find((n) => n.id === selected),
    edge = model.edges.find((e) => e.id === selectedEdge);
  const errorText = (error: unknown) =>
    error instanceof CanvasEditError
      ? `${t(($) => $.canvas.errors[error.code])}${error.detail ? ` · ${error.detail}` : ""}`
      : error instanceof Error
        ? error.message
        : String(error);
  const commit = (command: CanvasCommand, confirmed = false): boolean => {
    if (!writable) return false;
    try {
      const input =
        command.type === "add_edge" ||
        command.type === "delete_edge" ||
        command.type === "reconnect_edge"
          ? { ...command, confirmInferred: true }
          : command;
      const result = applyCanvasEdit(source, input);
      const conversions = canvasStageConversions(source, command);
      if (
        !confirmed &&
        (command.type === "delete_node" || conversions.length)
      ) {
        setPending({ command, source, conversions });
        return true;
      }
      onChange(result.source);
      setError(null);
      if (result.selected) {
        setSelected(result.selected);
        setSelectedEdge(undefined);
        if (command.type === "update_node" && command.id !== result.selected) {
          const layout = usePipelineCanvasStore.getState().draft.layouts[scope];
          if (layout?.positions[command.id]) {
            const positions = {
              ...layout.positions,
              [result.selected]: layout.positions[command.id]!,
            };
            delete positions[command.id];
            editPipelineCanvasLayout(scope, { ...layout, positions });
          }
        }
      } else if (command.type === "delete_node") {
        setSelected(undefined);
        requestAnimationFrame(() => nodePicker.current?.focus());
      }
      setSelectedEdge(undefined);
      return true;
    } catch (error) {
      setError(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  };
  const requestDelete = () => {
    if (!writable) return;
    if (node) commit({ type: "delete_node", id: node.id });
    else if (edge) commit({ type: "delete_edge", id: edge.id });
  };
  const beginEdge = (id?: string) => {
    if (!writable) return;
    const old = model.edges.find((e) => e.id === id);
    if (old?.kind === "gate") {
      setError(new CanvasEditError("gate"));
      return;
    }
    setEdgeDraft({
      id,
      from: old?.from ?? selected ?? model.nodes[0]?.id ?? "",
      to: old?.to ?? model.nodes[1]?.id ?? "",
      material: old?.kind === "material",
    });
  };
  const impact =
    pending?.command.type === "delete_node"
      ? canvasDeletionImpact(model, pending.command.id)
      : null;
  return (
    <div
      className="space-y-4 min-w-0"
      data-testid="pipeline-graph"
      onKeyDown={(e) => {
        const target = e.target as HTMLElement;
        if (
          target.closest(
            "input,textarea,select,[contenteditable=true],[role=dialog]",
          )
        )
          return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
          if (canEdit) {
            e.preventDefault();
            if (e.shiftKey) onRedo();
            else onUndo();
          }
          return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
          if (writable && (selected || selectedEdge)) {
            e.preventDefault();
            requestDelete();
          }
        }
      }}
    >
      {!canEdit && readOnlyReason !== "" && (
        <p role="status" className="pipeline-metadata">
          {readOnlyReason ?? t(($) => $.pipeline.readonly)}
        </p>
      )}
      {projection.restriction && (
        <div role="alert" className="pipeline-error space-y-2">
          <p>{t(($) => $.canvas.stale)}</p>
          <p>{errorText(projection.restriction)}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onShowYAML}
          >
            {t(($) => $.canvas.read_yaml)}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="pipeline-error">
          {errorText(error)}
        </p>
      )}
      <div className="pipeline-toolbar">
        <Dialog
          open={adding !== null}
          onOpenChange={(open) => {
            if (!open) setAdding(null);
          }}
        >
          <DialogTrigger
            render={
              <Button
                ref={addAgent}
                type="button"
                size="sm"
                disabled={!writable}
                onClick={() => {
                  if (writable) {
                    addFocus.current = "agent";
                    setAdding("agent");
                    setError(null);
                  }
                }}
              />
            }
          >
            {t(($) => $.canvas.add_agent)}
          </DialogTrigger>
          <Button
            ref={addGate}
            type="button"
            variant="outline"
            size="sm"
            disabled={
              !writable ||
              (model.kind === "hermes_yaml" &&
                !model.nodes.some((n) => n.type === "agent"))
            }
            onClick={() => {
              if (writable) {
                addFocus.current = "manual";
                setAdding("manual");
                setError(null);
              }
            }}
          >
            {t(($) => $.canvas.add_manual)}
          </Button>
          <DialogContent
            className="sm:max-w-2xl"
            finalFocus={addFocus.current === "manual" ? addGate : addAgent}
          >
            <DialogHeader>
              <DialogTitle>
                {adding === "manual"
                  ? t(($) => $.canvas.add_manual)
                  : t(($) => $.canvas.add_agent)}
              </DialogTitle>
            </DialogHeader>
            {adding && (
              <CanvasNodeForm
                key={adding}
                model={model}
                nodeType={adding}
                roles={roles}
                disabled={!writable}
                onCancel={() => setAdding(null)}
                onApply={(fields) => {
                  if (!writable) return;
                  if (commit({ type: "add_node", nodeType: adding, fields }))
                    setAdding(null);
                }}
              />
            )}
            {error && (
              <p role="alert" className="pipeline-error">
                {errorText(error)}
              </p>
            )}
          </DialogContent>
        </Dialog>
        <Button
          ref={addEdge}
          type="button"
          size="sm"
          variant="outline"
          disabled={!writable || model.nodes.length < 2}
          onClick={() => beginEdge()}
        >
          {t(($) => $.canvas.add_edge)}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!canEdit || !canUndo}
          onClick={() => {
            if (canEdit && canUndo) onUndo();
          }}
        >
          {t(($) => $.canvas.undo)}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!canEdit || !canRedo}
          onClick={() => {
            if (canEdit && canRedo) onRedo();
          }}
        >
          {t(($) => $.canvas.redo)}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onShowYAML}>
          {t(($) => $.canvas.read_yaml)}
        </Button>
      </div>
      {!source.trim() && (
        <div className="pipeline-toolbar">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canEdit || !emptyKinds.includes("gitlab_yaml")}
            onClick={() => {
              if (canEdit && emptyKinds.includes("gitlab_yaml"))
                onChange("kind: gitlab_yaml\nstages: []\n");
            }}
          >
            {t(($) => $.canvas.blank_gitlab)}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canEdit || !emptyKinds.includes("hermes_yaml")}
            onClick={() => {
              if (canEdit && emptyKinds.includes("hermes_yaml"))
                onChange(
                  "kind: hermes_yaml\nroles: {}\nstates: {}\ngates: {}\nedges: []\n",
                );
            }}
          >
            {t(($) => $.canvas.blank_hermes)}
          </Button>
        </div>
      )}
      <CanvasViewport
        model={model}
        scope={scope}
        selected={selected}
        selectedEdge={selectedEdge}
        canConnect={writable}
        onSelect={(id) => {
          setSelected(id);
          setSelectedEdge(undefined);
        }}
        onSelectEdge={(id) => {
          setSelectedEdge(id);
          setSelected(undefined);
        }}
        onConnect={(from, to) => {
          if (writable) commit({ type: "add_edge", from, to });
        }}
        onReconnect={(id, from, to) => {
          if (writable) commit({ type: "reconnect_edge", id, from, to });
        }}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-caption">
          {t(($) => $.canvas.select_node)}
          <select
            ref={nodePicker}
            className="pipeline-select w-full"
            value={selected ?? ""}
            onChange={(e) => {
              setSelected(e.target.value);
              setSelectedEdge(undefined);
            }}
          >
            <option value="">{t(($) => $.canvas.select_node)}</option>
            {model.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.gateId
                  ? `${n.gateId} · ${n.sourceId}`
                  : n.title && n.title !== n.id
                    ? `${n.title} · ${n.id}`
                    : n.id}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-caption">
          {t(($) => $.canvas.select_edge)}
          <select
            className="pipeline-select w-full"
            value={selectedEdge ?? ""}
            onChange={(e) => {
              setSelectedEdge(e.target.value);
              setSelected(undefined);
            }}
          >
            <option value="">{t(($) => $.canvas.select_edge)}</option>
            {model.edges.map((e) => (
              <option key={e.id} value={e.id}>
                {e.from} → {e.to} · {e.kind}
              </option>
            ))}
          </select>
        </label>
      </div>
      {node && (
        <section
          className="pipeline-box space-y-4"
          data-testid="canvas-properties"
        >
          <div className="pipeline-toolbar justify-between">
            <h3>
              {t(($) => $.canvas.node_properties)} · {node.title || node.id}
            </h3>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={!writable}
              onClick={requestDelete}
            >
              {t(($) => $.canvas.delete_node)}
            </Button>
          </div>
          <CanvasNodeForm
            key={`${node.id}:${source}`}
            model={model}
            node={node}
            nodeType={node.type}
            roles={roles}
            disabled={!writable}
            onCancel={() => {
              setSelected(undefined);
              nodePicker.current?.focus();
            }}
            onApply={(fields) => {
              if (writable)
                commit({ type: "update_node", id: node.id, fields });
            }}
          />
        </section>
      )}
      {edge && (
        <section
          className="pipeline-box space-y-3"
          data-testid="canvas-edge-properties"
        >
          <h3>
            {edge.from} → {edge.to} · {edge.kind}
          </h3>
          {edge.kind === "gate" ? (
            <p className="pipeline-metadata">
              {t(($) => $.canvas.errors.gate)}
            </p>
          ) : (
            <div className="pipeline-toolbar">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!writable}
                onClick={() => beginEdge(edge.id)}
              >
                {t(($) => $.canvas.edit_edge)}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={!writable}
                onClick={requestDelete}
              >
                {t(($) => $.canvas.delete_edge)}
              </Button>
            </div>
          )}
        </section>
      )}
      <Dialog
        open={edgeDraft !== null}
        onOpenChange={(open) => {
          if (!open) setEdgeDraft(null);
        }}
      >
        <DialogContent finalFocus={addEdge}>
          <DialogHeader>
            <DialogTitle>
              {edgeDraft?.id
                ? t(($) => $.canvas.edit_edge)
                : t(($) => $.canvas.add_edge)}
            </DialogTitle>
          </DialogHeader>
          {edgeDraft && (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!writable) return;
                const command: CanvasCommand = edgeDraft.id
                  ? {
                      type: "reconnect_edge",
                      id: edgeDraft.id,
                      from: edgeDraft.from,
                      to: edgeDraft.to,
                    }
                  : {
                      type: "add_edge",
                      from: edgeDraft.from,
                      to: edgeDraft.to,
                      material: edgeDraft.material,
                    };
                if (commit(command)) setEdgeDraft(null);
              }}
            >
              <fieldset disabled={!writable} className="space-y-3">
                <label className="grid gap-1 text-caption">
                  {t(($) => $.canvas.from)}
                  <select
                    className="pipeline-select w-full"
                    required
                    value={edgeDraft.from}
                    onChange={(e) =>
                      setEdgeDraft({ ...edgeDraft, from: e.target.value })
                    }
                  >
                    {model.nodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-caption">
                  {t(($) => $.canvas.to)}
                  <select
                    className="pipeline-select w-full"
                    required
                    value={edgeDraft.to}
                    onChange={(e) =>
                      setEdgeDraft({ ...edgeDraft, to: e.target.value })
                    }
                  >
                    {model.nodes.map((n) => (
                      <option
                        key={n.id}
                        value={n.id}
                        disabled={
                          model.kind === "hermes_yaml" && n.type === "manual"
                        }
                      >
                        {n.id}
                      </option>
                    ))}
                  </select>
                </label>
                {model.kind === "gitlab_yaml" && !edgeDraft.id && (
                  <label className="flex gap-2 items-center text-caption">
                    <input
                      type="checkbox"
                      checked={edgeDraft.material}
                      onChange={(e) =>
                        setEdgeDraft({
                          ...edgeDraft,
                          material: e.target.checked,
                        })
                      }
                    />
                    {t(($) => $.canvas.material)}
                  </label>
                )}
              </fieldset>
              {error && (
                <p role="alert" className="pipeline-error">
                  {errorText(error)}
                </p>
              )}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEdgeDraft(null)}
                >
                  {t(($) => $.pipeline.cancel)}
                </Button>
                <Button type="submit" disabled={!writable}>
                  {t(($) => $.canvas.apply)}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <DialogContent finalFocus={nodePicker}>
          <DialogHeader>
            <DialogTitle>
              {impact
                ? t(($) => $.canvas.delete_title)
                : t(($) => $.canvas.convert_title)}
            </DialogTitle>
            <DialogDescription>
              {impact
                ? t(($) => $.canvas.delete_help)
                : t(($) => $.canvas.convert_help)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-caption break-words">
            <p>
              {t(($) => $.canvas.affected)}:{" "}
              {impact?.nodes.join(", ") || pending?.conversions.join(", ")}
            </p>
            {impact && (
              <ul className="list-disc pl-4">
                {impact.edges.map((e) => (
                  <li key={e.id}>
                    {e.from} → {e.to} · {e.kind}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPending(null)}
            >
              {t(($) => $.pipeline.cancel)}
            </Button>
            <Button
              type="button"
              variant={impact ? "destructive" : "default"}
              disabled={!writable}
              onClick={() => {
                if (!writable || !pending) return;
                if (pending.source !== source) {
                  setError(
                    new CanvasEditError(
                      "mapping",
                      t(($) => $.canvas.source_changed),
                    ),
                  );
                  return;
                }
                if (commit(pending.command, true)) setPending(null);
              }}
            >
              {t(($) => $.canvas.confirm)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
