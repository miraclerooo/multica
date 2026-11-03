"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  editPipelineCanvasLayout,
  usePipelineCanvasStore,
  type CanvasDocument,
  type CanvasNode,
  type PipelineCanvasLayout,
} from "@multica/core/pipelines";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../i18n";

type Point = { x: number; y: number };
type Gesture = {
  start: Point;
  origin: Point;
  node?: string;
  connection?: { from: string; edgeId?: string; side?: "from" | "to" };
};
const emptyLayout: PipelineCanvasLayout = {
  positions: {},
  viewport: { x: 16, y: 16, zoom: 1 },
};

export function CanvasViewport({
  model,
  scope,
  selected,
  selectedEdge,
  canConnect,
  onSelect,
  onSelectEdge,
  onConnect,
  onReconnect,
  onClear,
  onPort,
  onEditConnection,
  describeNode,
}: {
  model: CanvasDocument;
  scope: string;
  selected?: string;
  selectedEdge?: string;
  canConnect: boolean;
  onSelect: (id: string) => void;
  onSelectEdge: (id: string) => void;
  onConnect: (from: string, to: string) => void;
  onReconnect: (id: string, from: string, to: string) => void;
  onClear: () => void;
  onPort: (from?: string, to?: string) => void;
  onEditConnection: (id: string) => void;
  describeNode: (node: CanvasNode) => string;
}) {
  const { t } = useT("squads");
  const layout =
    usePipelineCanvasStore((s) => s.draft.layouts[scope]) ?? emptyLayout;
  const viewportRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null),
    moved = useRef(false);
  const [pending, setPending] = useState<{ from: Point; to: Point } | null>(
    null,
  );
  const marker = `canvas-arrow-${useId().replace(/:/g, "")}`;
  const save = (next: PipelineCanvasLayout) =>
    editPipelineCanvasLayout(scope, next);
  const positions = useMemo(() => {
    const depth = new Map<string, number>(),
      visiting = new Set<string>(),
      ids = new Set(model.nodes.map((n) => n.id));
    const level = (id: string): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const incoming = model.edges
        .filter((e) => e.to === id && ids.has(e.from))
        .map((e) => e.from);
      const d = incoming.length ? Math.max(...incoming.map(level)) + 1 : 0;
      depth.set(id, d);
      visiting.delete(id);
      return d;
    };
    const rows = new Map<number, number>(),
      result: Record<string, Point> = {};
    for (const n of model.nodes) {
      const column = level(n.id),
        row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      result[n.id] = layout.positions[n.id] ?? {
        x: 24 + column * 280,
        y: 36 + row * 150,
      };
    }
    return result;
  }, [model, layout.positions]);
  const fit = useCallback(() => {
    const points = Object.values(positions),
      width = viewportRef.current?.clientWidth ?? 0;
    if (width <= 0) return;
    const left = Math.min(0, ...points.map((p) => p.x)),
      top = Math.min(0, ...points.map((p) => p.y));
    const right = Math.max(260, ...points.map((p) => p.x + 230)),
      bottom = Math.max(160, ...points.map((p) => p.y + 110));
    const zoom = Math.max(
      0.2,
      Math.min(
        1.2,
        (width - 32) / (right - left + 24),
        320 / (bottom - top + 24),
      ),
    );
    editPipelineCanvasLayout(scope, {
      ...layout,
      viewport: { x: 16 - left * zoom, y: 16 - top * zoom, zoom },
    });
  }, [layout, positions, scope]);
  useEffect(() => {
    const initialize = () => {
      if (!usePipelineCanvasStore.getState().draft.layouts[scope]) fit();
    };
    initialize();
    if (typeof ResizeObserver === "undefined" || !viewportRef.current) return;
    const observer = new ResizeObserver(initialize);
    observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [fit, scope]);
  const localPoint = (x: number, y: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    return {
      x: (x - (rect?.left ?? 0) - layout.viewport.x) / layout.viewport.zoom,
      y: (y - (rect?.top ?? 0) - layout.viewport.y) / layout.viewport.zoom,
    };
  };
  const port = (id: string, side: "from" | "to"): Point => {
    const p = positions[id] ?? { x: 0, y: 0 };
    return { x: p.x + (side === "from" ? 220 : 0), y: p.y + 62 };
  };
  const capture = (e: PointerEvent<HTMLElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const beginConnection = (
    e: PointerEvent<HTMLElement>,
    from: string,
    edgeId?: string,
    side?: "from" | "to",
  ) => {
    if (!canConnect || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    capture(e);
    moved.current = false;
    const old = model.edges.find((v) => v.id === edgeId);
    const start =
      old && side === "from" ? port(old.to, "to") : port(from, "from");
    gesture.current = {
      start: { x: e.clientX, y: e.clientY },
      origin: start,
      connection: { from, edgeId, side },
    };
    setPending({ from: start, to: localPoint(e.clientX, e.clientY) });
  };
  const pointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.start.x,
      dy = e.clientY - g.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved.current = true;
    if (g.connection)
      setPending({ from: g.origin, to: localPoint(e.clientX, e.clientY) });
    else if (g.node)
      save({
        ...layout,
        positions: {
          ...layout.positions,
          [g.node]: {
            x: g.origin.x + dx / layout.viewport.zoom,
            y: g.origin.y + dy / layout.viewport.zoom,
          },
        },
      });
    else
      save({
        ...layout,
        viewport: {
          ...layout.viewport,
          x: g.origin.x + dx,
          y: g.origin.y + dy,
        },
      });
  };
  const pointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    setPending(null);
    if (g && !g.node && !g.connection && !moved.current) onClear();
    if (!g?.connection || !canConnect) return;
    const c = g.connection,
      old = model.edges.find((v) => v.id === c.edgeId);
    const target = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest(
        c.side === "from" ? "[data-canvas-output]" : "[data-canvas-input]",
      );
    const id = target?.getAttribute(
      c.side === "from" ? "data-canvas-output" : "data-canvas-input",
    );
    if (!id) return;
    if (old)
      onReconnect(
        old.id,
        c.side === "from" ? id : old.from,
        c.side === "from" ? old.to : id,
      );
    else onConnect(c.from, id);
  };
  const connection = model.edges.find((e) => e.id === selectedEdge);
  return (
    <div className="pipeline-graph" data-testid="pipeline-canvas">
      <div className="pipeline-toolbar justify-between p-2">
        <p className="pipeline-metadata">{t(($) => $.canvas.layout_note)}</p>
        <div className="pipeline-toolbar">
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={() =>
              save({
                ...layout,
                viewport: {
                  ...layout.viewport,
                  zoom: Math.max(0.2, layout.viewport.zoom - 0.1),
                },
              })
            }
            aria-label={t(($) => $.canvas.zoom_out)}
          >
            −
          </Button>
          <span className="text-caption">
            {Math.round(layout.viewport.zoom * 100)}%
          </span>
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={() =>
              save({
                ...layout,
                viewport: {
                  ...layout.viewport,
                  zoom: Math.min(2, layout.viewport.zoom + 0.1),
                },
              })
            }
            aria-label={t(($) => $.canvas.zoom_in)}
          >
            +
          </Button>
          <Button size="sm" variant="outline" type="button" onClick={fit}>
            {t(($) => $.canvas.fit)}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={() => save(emptyLayout)}
          >
            {t(($) => $.canvas.reset_layout)}
          </Button>
        </div>
      </div>
      <div
        ref={viewportRef}
        className="pipeline-canvas-viewport"
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={() => {
          gesture.current = null;
          setPending(null);
        }}
        onPointerDown={(e) => {
          if (
            e.button !== 0 ||
            (e.target as Element).closest("button,[data-canvas-edge]")
          )
            return;
          capture(e);
          moved.current = false;
          gesture.current = {
            start: { x: e.clientX, y: e.clientY },
            origin: { x: layout.viewport.x, y: layout.viewport.y },
          };
        }}
      >
        <div
          className="pipeline-canvas-plane"
          style={{
            transform: `translate(${layout.viewport.x}px,${layout.viewport.y}px) scale(${layout.viewport.zoom})`,
          }}
        >
          <svg
            className="pipeline-canvas-lines"
            width="10000"
            height="10000"
            aria-label={t(($) => $.canvas.connection)}
          >
            <defs>
              <marker
                id={marker}
                markerWidth="7"
                markerHeight="7"
                refX="6"
                refY="3"
                orient="auto"
              >
                <path d="M 0 0 L 6 3 L 0 6" fill="var(--muted-foreground)" />
              </marker>
            </defs>
            {model.edges.map((edge) => {
              if (!positions[edge.from] || !positions[edge.to]) return null;
              const from = port(edge.from, "from"),
                to = port(edge.to, "to"),
                offset = edge.kind === "material" ? 12 : 0;
              const d = `M ${from.x} ${from.y + offset} C ${from.x + 38} ${from.y + offset}, ${to.x - 38} ${to.y + offset}, ${to.x} ${to.y + offset}`;
              return (
                <g key={edge.id} data-canvas-edge={edge.id}>
                  <path
                    d={d}
                    className={cn(
                      "pipeline-canvas-edge",
                      edge.kind,
                      selectedEdge === edge.id && "is-selected",
                    )}
                    markerEnd={`url(#${marker})`}
                  />
                  <path
                    d={d}
                    stroke="transparent"
                    strokeWidth="18"
                    fill="none"
                    pointerEvents="stroke"
                    role="button"
                    tabIndex={0}
                    aria-label={`${model.nodes.find((n) => n.id === edge.from)?.title || edge.from} → ${model.nodes.find((n) => n.id === edge.to)?.title || edge.to} · ${edge.kind}`}
                    onClick={() => onSelectEdge(edge.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectEdge(edge.id);
                      }
                    }}
                  />
                </g>
              );
            })}
            {pending && (
              <path
                d={`M ${pending.from.x} ${pending.from.y} L ${pending.to.x} ${pending.to.y}`}
                stroke="var(--brand)"
                strokeWidth="2"
                strokeDasharray="5 4"
              />
            )}
          </svg>
          {model.nodes.map((node) => {
            const p = positions[node.id]!;
            return (
              <div
                key={node.id}
                data-canvas-node={node.id}
                className="pipeline-canvas-card"
                style={{ left: p.x, top: p.y }}
              >
                <div className="h-5" aria-hidden />
                <button
                  type="button"
                  className={cn(
                    "pipeline-node",
                    node.type === "manual" && "pipeline-canvas-manual",
                    selected === node.id && "is-selected",
                  )}
                  aria-pressed={selected === node.id}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    capture(e);
                    moved.current = false;
                    gesture.current = {
                      node: node.id,
                      start: { x: e.clientX, y: e.clientY },
                      origin: p,
                    };
                  }}
                  onClick={(e) => {
                    if (!moved.current || e.detail === 0) onSelect(node.id);
                  }}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {node.title || node.id}
                    </span>
                    <span className="block truncate text-caption text-muted-foreground">
                      {describeNode(node)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="pipeline-canvas-port input"
                  data-canvas-input={node.id}
                  disabled={!canConnect}
                  aria-label={`${t(($) => $.canvas.connect_to)} ${node.title || node.id}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    if (canConnect) onPort(undefined, node.id);
                  }}
                />
                <button
                  type="button"
                  className="pipeline-canvas-port output"
                  data-canvas-output={node.id}
                  disabled={!canConnect}
                  aria-label={`${t(($) => $.canvas.connect_from)} ${node.title || node.id}`}
                  onPointerDown={(e) => beginConnection(e, node.id)}
                  onClick={(e) => {
                    if (canConnect && (!moved.current || e.detail === 0))
                      onPort(node.id);
                  }}
                />
              </div>
            );
          })}
          {connection &&
            connection.kind !== "gate" &&
            canConnect &&
            (["from", "to"] as const).map((side) => {
              const p = port(
                side === "from" ? connection.from : connection.to,
                side,
              );
              return (
                <button
                  key={side}
                  type="button"
                  className="pipeline-canvas-reconnect"
                  style={{ left: p.x - 7, top: p.y + 12 }}
                  aria-label={
                    side === "from"
                      ? t(($) => $.canvas.reconnect_from)
                      : t(($) => $.canvas.reconnect_to)
                  }
                  onPointerDown={(e) =>
                    beginConnection(e, connection.from, connection.id, side)
                  }
                  onClick={(e) => {
                    if (canConnect && (!moved.current || e.detail === 0))
                      onEditConnection(connection.id);
                  }}
                />
              );
            })}
        </div>
      </div>
      <p className="pipeline-metadata p-3">
        {t(($) => $.v17.port_help)} {t(($) => $.canvas.legend)}
      </p>
    </div>
  );
}
