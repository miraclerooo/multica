"use client";

import { useId, useMemo, useState } from "react";
import {
  pipelineDependencies,
  type PipelinePlan,
  type PipelineRun,
} from "@multica/core/pipelines";
import {
  GitBranch,
  User,
  Plus,
  Minus,
  CheckCircle2,
  XCircle,
  CircleAlert,
  Loader2,
} from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../i18n";
import "./pipelines.css";

export function FlowGraph({
  plan,
  run,
  selected,
  onSelect,
}: {
  plan: PipelinePlan;
  run?: PipelineRun;
  selected?: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useT("squads");
  const [zoom, setZoom] = useState(1);
  const arrowId = `pipeline-arrow-${useId().replace(/:/g, "")}`;
  const [showList, setShowList] = useState(false);
  const layout = useMemo(() => {
    const depth = new Map<string, number>();
    const nodes = new Map(plan.nodes.map((n) => [n.id, n]));
    const visiting = new Set<string>();
    const level = (id: string): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const dependencies = pipelineDependencies(nodes.get(id)!).filter((dep) =>
        nodes.has(dep),
      );
      const d = dependencies.length
        ? Math.max(...dependencies.map(level)) + 1
        : 0;
      visiting.delete(id);
      depth.set(id, d);
      return d;
    };
    const rows = new Map<number, number>();
    const placed = plan.nodes.map((node) => {
      const column = level(node.id);
      const row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      return { node, x: 24 + column * 252, y: 44 + row * 120 };
    });
    return {
      placed,
      width: Math.max(600, (Math.max(0, ...depth.values()) + 1) * 252 + 24),
      height: Math.max(210, Math.max(1, ...rows.values()) * 120 + 64),
    };
  }, [plan]);
  return (
    <div className="pipeline-graph" data-testid="pipeline-graph">
      <div className="flex items-center justify-between px-4 py-2 text-caption text-muted-foreground">
        <span>{run ? run.status : t(($) => $.pipeline.preview)}</span>
        <div className="hidden sm:flex gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t(($) => $.pipeline.graph) + " −"}
            onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}
          >
            <Minus />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t(($) => $.pipeline.graph) + " +"}
            onClick={() => setZoom((z) => Math.min(1.5, z + 0.1))}
          >
            <Plus />
          </Button>
        </div>
      </div>
      <div className="hidden sm:block overflow-auto max-h-[520px] p-2">
        <div
          style={{ width: layout.width * zoom, height: layout.height * zoom }}
        >
          <div
            className="relative origin-top-left"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `scale(${zoom})`,
            }}
          >
            <svg
              className="absolute inset-0 pointer-events-none"
              width={layout.width}
              height={layout.height}
              aria-hidden="true"
            >
              <defs>
                <marker
                  id={arrowId}
                  markerWidth="6"
                  markerHeight="6"
                  refX="5"
                  refY="3"
                  orient="auto"
                >
                  <path d="M 0 0 L 6 3 L 0 6" fill="var(--muted-foreground)" />
                </marker>
              </defs>
              {layout.placed.flatMap((to) =>
                pipelineDependencies(to.node).map((id) => {
                  const from = layout.placed.find((n) => n.node.id === id);
                  if (!from) return null;
                  const x = from.x + 212,
                    y = from.y + 60;
                  return (
                    <path
                      key={`${id}:${to.node.id}`}
                      d={`M ${x} ${y} C ${x + 24} ${y}, ${to.x - 24} ${to.y + 60}, ${to.x} ${to.y + 60}`}
                      fill="none"
                      stroke="var(--border)"
                      strokeWidth="1.5"
                      markerEnd={`url(#${arrowId})`}
                    />
                  );
                }),
              )}
            </svg>
            {layout.placed.map(({ node, x, y }) => {
              const job = run?.jobs.find((j) => j.node.id === node.id);
              const StatusIcon =
                job?.status === "succeeded"
                  ? CheckCircle2
                  : ["failed", "rejected"].includes(job?.status ?? "")
                    ? XCircle
                    : job?.status === "blocked"
                      ? CircleAlert
                      : job?.status === "running"
                        ? Loader2
                        : node.type === "manual"
                          ? User
                          : GitBranch;
              return (
                <div
                  key={node.id}
                  style={{ position: "absolute", left: x, top: y, width: 212 }}
                >
                  <div className="text-micro text-muted-foreground mb-2 truncate">
                    {node.stage}
                  </div>
                  <button
                    type="button"
                    className={cn(
                      "pipeline-node",
                      selected === node.id && "is-selected",
                    )}
                    aria-pressed={selected === node.id}
                    onClick={() => onSelect(node.id)}
                  >
                    <StatusIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {node.title || node.id}
                      </span>
                      <span className="block text-micro text-muted-foreground truncate">
                        {job?.status ??
                          (node.type === "manual"
                            ? t(($) => $.pipeline.manual)
                            : node.role || t(($) => $.pipeline.leader))}
                      </span>
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="hidden sm:inline-flex m-2"
        aria-expanded={showList}
        onClick={() => setShowList((value) => !value)}
      >
        {t(($) => $.pipeline.node)}
      </Button>
      <ol className={cn("pipeline-node-list grid", !showList && "sm:hidden")}>
        {plan.nodes.map((node) => (
          <li key={node.id}>
            <button
              type="button"
              aria-pressed={selected === node.id}
              className={cn(
                "pipeline-node",
                selected === node.id && "is-selected",
              )}
              onClick={() => onSelect(node.id)}
            >
              <span className="min-w-0 break-words">
                {node.title || node.id}
                <span className="block text-micro text-muted-foreground">
                  {run?.jobs.find((j) => j.node.id === node.id)?.status ??
                    node.type}{" "}
                  · {pipelineDependencies(node).join(", ")}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
