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
  type PipelineCandidates,
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
import { CanvasNodeForm } from "./canvas-node-form";
import { CanvasViewport } from "./canvas-viewport";
import { useT } from "../i18n";

type EdgeDraft = { id?: string; from: string; to: string; material: boolean };
export function DefinitionCanvas({
  source,
  fallbackSource,
  scope,
  canEdit,
  readOnlyReason,
  candidates,
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
  candidates?: PipelineCandidates | null;
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
  const writable = canEdit && !projection.restriction && !!candidates;
  const [selected, setSelected] = useState<string>(),
    [selectedEdge, setSelectedEdge] = useState<string>();
  const [adding, setAdding] = useState(false),
    [nodeType, setNodeType] = useState<"agent" | "manual">("agent");
  const [edgeDraft, setEdgeDraft] = useState<EdgeDraft | null>(null);
  const [pending, setPending] = useState<{
    command: CanvasCommand;
    source: string;
    conversions: string[];
  } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const addNode = useRef<HTMLButtonElement>(null),
    canvasRef = useRef<HTMLDivElement>(null);
  const node = model.nodes.find((n) => n.id === selected),
    edge = model.edges.find((e) => e.id === selectedEdge);
  const focusCanvas = () => canvasRef.current?.focus({ preventScroll: true });
  const focusNode = () => {
    const target = Array.from(
      canvasRef.current?.querySelectorAll<HTMLElement>("[data-canvas-node]") ??
        [],
    )
      .find((el) => el.dataset.canvasNode === selected)
      ?.querySelector<HTMLButtonElement>(".pipeline-node");
    if (target) target.focus({ preventScroll: true });
    else focusCanvas();
  };
  const name = (id: string) =>
    model.nodes.find((n) => n.id === id)?.title || id;
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
      const result = applyCanvasEdit(source, input),
        conversions = canvasStageConversions(source, command);
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
        requestAnimationFrame(focusCanvas);
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
  const beginEdge = (id?: string, from?: string, to?: string) => {
    if (!writable) return;
    const old = model.edges.find((e) => e.id === id);
    if (old?.kind === "gate") {
      setError(new CanvasEditError("gate"));
      return;
    }
    setEdgeDraft({
      id,
      from: old?.from ?? from ?? selected ?? model.nodes[0]?.id ?? "",
      to: old?.to ?? to ?? model.nodes.find((n) => n.id !== from)?.id ?? "",
      material: old?.kind === "material",
    });
    setError(null);
  };
  const impact =
    pending?.command.type === "delete_node"
      ? canvasDeletionImpact(model, pending.command.id)
      : null;
  return (
    <div
      ref={canvasRef}
      tabIndex={-1}
      className="space-y-4 min-w-0 outline-none"
      data-testid="pipeline-graph"
      onKeyDown={(e) => {
        if (
          (e.target as HTMLElement).closest(
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
        if (e.key === "Escape") {
          focusNode();
          setSelected(undefined);
          setSelectedEdge(undefined);
        }
        if (
          (e.key === "Delete" || e.key === "Backspace") &&
          writable &&
          (selected || selectedEdge)
        ) {
          e.preventDefault();
          requestDelete();
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
        <Dialog open={adding} onOpenChange={setAdding}>
          <DialogTrigger
            render={
              <Button
                ref={addNode}
                type="button"
                size="sm"
                disabled={!writable}
                onClick={() => {
                  if (writable) {
                    setAdding(true);
                    setError(null);
                  }
                }}
              />
            }
          >
            {t(($) => $.v17.add_node)}
          </DialogTrigger>
          <DialogContent className="sm:max-w-2xl" finalFocus={addNode}>
            <DialogHeader>
              <DialogTitle>{t(($) => $.v17.add_node)}</DialogTitle>
            </DialogHeader>
            <label className="grid gap-1 text-caption">
              {t(($) => $.v17.node_type)}
              <select
                className="pipeline-select w-full"
                value={nodeType}
                disabled={!writable}
                onChange={(e) => {
                  if (writable)
                    setNodeType(e.target.value as "agent" | "manual");
                }}
              >
                <option value="agent">{t(($) => $.v17.agent)}</option>
                <option
                  value="manual"
                  disabled={
                    model.kind === "hermes_yaml" &&
                    !model.nodes.some((n) => n.type === "agent")
                  }
                >
                  {t(($) => $.v17.manual)}
                </option>
              </select>
            </label>
            {adding && (
              <CanvasNodeForm
                key={nodeType}
                source={source}
                formKey={`${scope}:node:new:${nodeType}`}
                model={model}
                nodeType={nodeType}
                candidates={candidates}
                disabled={!writable}
                onCancel={() => setAdding(false)}
                onApply={(fields) => {
                  if (!writable) return false;
                  const ok = commit({ type: "add_node", nodeType, fields });
                  if (ok) setAdding(false);
                  return ok;
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
      </div>
      <CanvasViewport
        model={model}
        scope={scope}
        selected={selected}
        selectedEdge={selectedEdge}
        canConnect={writable}
        describeNode={(n) =>
          n.type === "manual"
            ? candidates?.humans.find((h) => h.user_id === n.ownerUserId)
                ?.name ||
              n.owner ||
              t(($) => $.v17.no_owner)
            : n.agentId
              ? candidates?.agents.find((a) => a.agent_id === n.agentId)
                  ?.name || t(($) => $.v17.binding_unavailable)
              : n.role || t(($) => $.pipeline.leader)
        }
        onSelect={(id) => {
          setSelected(id);
          setSelectedEdge(undefined);
        }}
        onSelectEdge={(id) => {
          setSelectedEdge(id);
          setSelected(undefined);
        }}
        onClear={() => {
          setSelected(undefined);
          setSelectedEdge(undefined);
        }}
        onPort={(from, to) => beginEdge(undefined, from, to)}
        onEditConnection={(id) => beginEdge(id)}
        onConnect={(from, to) => {
          if (writable) commit({ type: "add_edge", from, to });
        }}
        onReconnect={(id, from, to) => {
          if (writable) commit({ type: "reconnect_edge", id, from, to });
        }}
      />
      {node && (
        <section
          className="pipeline-box space-y-4"
          data-testid="canvas-properties"
        >
          <div className="pipeline-toolbar justify-between">
            <h3>
              {t(($) => $.canvas.node_properties)} · {node.title}
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
            key={node.id}
            source={source}
            formKey={`${scope}:node:${node.id}`}
            model={model}
            node={node}
            nodeType={node.type}
            candidates={candidates}
            disabled={!writable}
            onCancel={() => {
              focusNode();
              setSelected(undefined);
            }}
            onApply={(fields) =>
              writable && commit({ type: "update_node", id: node.id, fields })
            }
          />
        </section>
      )}
      {edge && (
        <section
          className="pipeline-box space-y-3"
          data-testid="canvas-edge-properties"
        >
          <h3>
            {name(edge.from)} → {name(edge.to)} · {edge.kind}
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
        <DialogContent finalFocus={canvasRef}>
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
                        {n.title}
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
                        {n.title}
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
        <DialogContent finalFocus={canvasRef}>
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
              {impact?.nodes.map(name).join(", ") ||
                pending?.conversions.map(name).join(", ")}
            </p>
            {impact && (
              <ul className="list-disc pl-4">
                {impact.edges.map((e) => (
                  <li key={e.id}>
                    {name(e.from)} → {name(e.to)} · {e.kind}
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
