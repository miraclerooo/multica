"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useWSEvent, useWSReconnect } from "@multica/core/realtime";
import { memberListOptions } from "@multica/core/workspace/queries";
import {
  choosePipelineProgressRun,
  expandPipelineProgressStages,
  isActivePipelineRun,
  issueExecutionOptions,
  issuePipelineRunsOptions,
  knownPipelineProgressStatus,
  pipelineNodeNeedsAttention,
  pipelineProgress,
  pipelineProgressCounts,
  pipelineRunOptions,
  selectPipelineNode,
  selectPipelineProgressRun,
  usePipelineProgressStore,
  usePipelineReviewStore,
  type PipelineProgressNode,
} from "@multica/core/pipelines";
import type { Issue } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import {
  Ban,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleAlert,
  Clock,
  Loader2,
  RefreshCw,
  SkipForward,
  User,
  XCircle,
} from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../i18n";
import { AppLink } from "../navigation";
import { PipelineRunDetails } from "./run-details";
import { ExecutionSummary, IssueExecutionPanel } from "./execution-summary";

export function PipelineProgressStatus({
  status,
  allowFailure = false,
}: {
  status: string;
  allowFailure?: boolean;
}) {
  const { t } = useT("squads");
  const Icon =
    status === "succeeded"
      ? CheckCircle2
      : status === "failed" || status === "rejected"
        ? XCircle
        : status === "skipped"
          ? SkipForward
          : status === "cancelled"
            ? Ban
            : status === "waiting_approval"
              ? User
              : status === "running"
                ? Loader2
                : status === "ready" || status === "queued"
                  ? Clock
                  : status === "pending"
                    ? Circle
                    : CircleAlert;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-caption min-w-0 break-words",
        status === "succeeded"
          ? "text-success"
          : status === "failed" || status === "rejected"
            ? "text-destructive"
            : status === "pending" ||
                status === "skipped" ||
                status === "cancelled"
              ? "text-muted-foreground"
              : "text-foreground",
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span>
        {knownPipelineProgressStatus(status)
          ? t(($) => $.v18.status[status])
          : `${t(($) => $.v18.unknown_status)} (${status || t(($) => $.v18.empty_value)})`}
        {allowFailure && status === "failed"
          ? ` · ${t(($) => $.v18.allow_failure)}`
          : ""}
      </span>
    </span>
  );
}

function Counts({
  nodes,
  uncertain = false,
}: {
  nodes: Pick<PipelineProgressNode, "status">[];
  uncertain?: boolean;
}) {
  const { t } = useT("squads"),
    counts = pipelineProgressCounts(nodes);
  return (
    <div className="space-y-1.5" data-testid="pipeline-progress-counts">
      <p className="font-medium text-caption">
        {t(($) => $.v18.success_ratio, {
          succeeded: counts.succeeded,
          total: counts.total,
        })}
      </p>
      <div className="flex gap-x-2 gap-y-1 flex-wrap text-micro text-muted-foreground">
        {(
          [
            "failed",
            "rejected",
            "skipped",
            "cancelled",
            "unfinished",
            "unknown",
          ] as const
        )
          .filter((key) => counts[key] > 0)
          .map((key) => (
            <span
              key={key}
              className={
                key === "failed" || key === "rejected"
                  ? "text-destructive"
                  : undefined
              }
            >
              {t(($) => $.v18.counts[key], { count: counts[key] })}
            </span>
          ))}
      </div>
      {counts.total > 0 && (
        <div
          className="h-1.5 flex rounded bg-muted overflow-hidden"
          aria-hidden
        >
          <span
            className={
              uncertain || counts.unknown
                ? "bg-muted-foreground/40"
                : "bg-success"
            }
            style={{ width: `${(counts.succeeded / counts.total) * 100}%` }}
          />
          <span
            className="bg-destructive/70"
            style={{
              width: `${((counts.failed + counts.rejected) / counts.total) * 100}%`,
            }}
          />
          <span
            className="bg-border"
            style={{
              width: `${((counts.skipped + counts.cancelled) / counts.total) * 100}%`,
            }}
          />
        </div>
      )}
    </div>
  );
}

// Reveal only inside the existing sidebar scroller; native scrollIntoView
// would also move the task reader or the application shell.
function revealSidebarNode(button: HTMLElement) {
  let parent = button.parentElement;
  while (parent) {
    if (
      /auto|scroll/.test(getComputedStyle(parent).overflowY) &&
      parent.scrollHeight > parent.clientHeight
    ) {
      const bounds = parent.getBoundingClientRect(),
        node = button.getBoundingClientRect();
      if (node.top < bounds.top) parent.scrollTop -= bounds.top - node.top + 8;
      else if (node.bottom > bounds.bottom)
        parent.scrollTop += node.bottom - bounds.bottom + 8;
      break;
    }
    parent = parent.parentElement;
  }
}

export function IssuePipelineCard({ issue }: { issue: Issue }) {
  const wsId = useWorkspaceId();
  return <IssueProgress key={`${wsId}:${issue.id}`} issue={issue} />;
}
function IssueProgress({ issue }: { issue: Issue }) {
  const { t } = useT("squads"),
    wsId = useWorkspaceId(),
    paths = useWorkspacePaths();
  const issueKey = `${wsId}:${issue.id}`;
  const explicit = usePipelineProgressStore((s) => s.draft.runs[issueKey]);
  const runs = useQuery(issuePipelineRunsOptions(wsId, issue.id));
  const execution = useQuery({
    ...issueExecutionOptions(wsId, issue.id),
    enabled: !!issue.execution,
  });
  const chosen = choosePipelineProgressRun(runs.data ?? [], explicit),
    runId = explicit || chosen?.id || "";
  const detail = useQuery(pipelineRunOptions(wsId, runId));
  const snapshot = detail.data?.issue_id === issue.id ? detail.data : undefined;
  const [expanded, setExpanded] = useState(true),
    [opened, setOpened] = useState<{
      issueKey: string;
      runId: string | null;
    } | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null),
    heading = useRef<HTMLButtonElement | null>(null);
  const selectionKey = `${wsId}:${runId}`;
  const selectedNode = usePipelineReviewStore(
    (s) => s.draft.selections[selectionKey],
  );
  const storedExpanded = usePipelineProgressStore(
    (s) => s.draft.expanded[`${issueKey}:${runId}`],
  );
  const members = useQuery({ ...memberListOptions(wsId), enabled: !!snapshot });
  const refresh = () => {
    void runs.refetch();
    if (runId) void detail.refetch();
    if (issue.execution) void execution.refetch();
  };
  useWSEvent("pipeline:updated", (event) => {
    if (
      event &&
      typeof event === "object" &&
      "issue_id" in event &&
      event.issue_id === issue.id
    )
      refresh();
  });
  useWSReconnect(refresh);
  const failed = (error: unknown) =>
    error instanceof ApiError && error.status === 403
      ? t(($) => $.v18.forbidden)
      : error instanceof Error && error.message.startsWith("Invalid pipeline")
        ? t(($) => $.v18.invalid_response)
        : t(($) => $.v18.load_failed);
  const executionValue = execution.data
    ? execution.data.execution
    : issue.execution;
  if (
    !runs.isPending &&
    !runs.isError &&
    !runs.data?.length &&
    !explicit &&
    executionValue?.mode !== "pipeline"
  )
    return null;
  if (runs.isPending && !issue.execution && !explicit) return null;
  const progress = snapshot ? pipelineProgress(snapshot) : undefined;
  const openStages =
    storedExpanded ??
    progress?.groups
      .filter((group) =>
        group.nodes.some(
          (item) =>
            pipelineNodeNeedsAttention(item) || item.node.id === selectedNode,
        ),
      )
      .map((group) => group.stage) ??
    [];
  const available = runs.data ?? [];
  const options =
    snapshot && !available.some((run) => run.id === snapshot.id)
      ? [snapshot, ...available]
      : available;
  const showingDetails =
    opened?.issueKey === issueKey &&
    (!opened.runId || opened.runId === runId) &&
    !runs.isError &&
    !detail.isError;
  const openNode = (button: HTMLButtonElement, nodeId: string) => {
    if (!snapshot || detail.isError || runs.isError) return;
    trigger.current = button;
    selectPipelineProgressRun(issueKey, snapshot.id);
    selectPipelineNode(`${wsId}:${snapshot.id}`, nodeId);
    setOpened({ issueKey, runId: snapshot.id });
  };
  const renderNode = (item: PipelineProgressNode) => {
    const ownerId = item.job?.owner_id || item.node.owner_user_id;
    const owner = ownerId
      ? members.data?.find((member) => member.user_id === ownerId)?.name ||
        t(($) => $.v18.owner_unavailable)
      : item.node.owner;
    return (
      <button
        key={item.node.id}
        type="button"
        className={cn(
          "w-full text-left rounded-md border p-2 space-y-1 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
          selectedNode === item.node.id
            ? "border-primary bg-primary/5"
            : pipelineNodeNeedsAttention(item)
              ? "border-border bg-muted/40"
              : "border-transparent",
        )}
        data-progress-node={item.node.id}
        aria-pressed={selectedNode === item.node.id}
        onClick={(event) => openNode(event.currentTarget, item.node.id)}
      >
        <span className="block font-medium text-caption break-words">
          {item.node.title || item.node.id}
        </span>
        <PipelineProgressStatus
          status={item.status}
          allowFailure={item.node.allow_failure}
        />
        {item.attempt && (
          <span className="block text-micro text-muted-foreground">
            {t(($) => $.pipeline.attempt)} {item.attempt.number}
          </span>
        )}
        {item.node.type === "manual" && owner && (
          <span className="block text-micro break-words">
            {t(($) => $.v18.owner)}: {owner}
          </span>
        )}
        {item.job?.reason && (
          <span className="block text-micro break-words text-muted-foreground">
            {item.job.reason}
          </span>
        )}
      </button>
    );
  };
  return (
    <section
      className="pipeline-box space-y-3 min-w-0"
      data-testid="issue-pipeline-card"
      data-progress-run={snapshot?.id}
    >
      <div className="flex items-center justify-between gap-2">
        <button
          ref={heading}
          type="button"
          className="inline-flex items-center gap-1 font-medium text-label text-left"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronRight
            className={cn("size-3.5", expanded && "rotate-90")}
            aria-hidden
          />
          {t(($) => $.v18.title)}
        </button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={t(($) => $.pipeline.refresh)}
          disabled={
            runs.isFetching || detail.isFetching || execution.isFetching
          }
          onClick={refresh}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      {expanded && (
        <>
          {runs.isPending ? (
            <p role="status">{t(($) => $.pipeline.loading)}</p>
          ) : runs.isError ? (
            <p role="alert" className="pipeline-error">
              {failed(runs.error)}
            </p>
          ) : (
            <>
              {options.length > 0 && (
                <label className="grid gap-1 text-caption">
                  {t(($) => $.v18.run)}
                  <select
                    className="pipeline-select w-full"
                    value={runId}
                    onChange={(event) => {
                      setOpened(null);
                      selectPipelineProgressRun(issueKey, event.target.value);
                    }}
                  >
                    {!options.some((run) => run.id === runId) && (
                      <option value={runId}>
                        {t(($) => $.v18.selected_run)}
                      </option>
                    )}
                    {options.map((run) => {
                      const status = run.status;
                      return (
                        <option key={run.id} value={run.id}>
                          {`${run.pipeline_name || t(($) => $.pipeline.title)} · ${t(($) => $.pipeline.version)} ${run.definition_revision ?? "?"} · ${
                            knownPipelineProgressStatus(status)
                              ? t(($) => $.v18.status[status])
                              : status
                          } · #${run.id.slice(-8)}`}
                          {isActivePipelineRun(run)
                            ? ` · ${t(($) => $.v18.active)}`
                            : ""}
                        </option>
                      );
                    })}
                  </select>
                </label>
              )}
              {available.filter(isActivePipelineRun).length > 1 && (
                <p className="pipeline-metadata">
                  {t(($) => $.v18.active_runs, {
                    count: available.filter(isActivePipelineRun).length,
                  })}
                </p>
              )}
              {runId ? (
                detail.isPending ? (
                  <p role="status">{t(($) => $.pipeline.loading)}</p>
                ) : detail.isError || !snapshot ? (
                  <p role="alert" className="pipeline-error">
                    {failed(
                      detail.error ??
                        new Error("Invalid pipeline run identity"),
                    )}
                  </p>
                ) : (
                  progress && (
                    <>
                      <div className="space-y-1">
                        <p className="font-medium break-words text-label">
                          {snapshot.pipeline_name || t(($) => $.pipeline.title)}
                        </p>
                        <p className="pipeline-metadata">
                          {`${t(($) => $.v18.frozen)} ${snapshot.definition_revision ?? "?"} · #${snapshot.id.slice(-8)}`}
                        </p>
                        <PipelineProgressStatus status={snapshot.status} />
                        {snapshot.reason && (
                          <p className="text-caption break-words">
                            {snapshot.reason}
                          </p>
                        )}
                      </div>
                      <Counts
                        nodes={progress.nodes}
                        uncertain={progress.uncertain}
                      />
                      {progress.uncertain && (
                        <p role="status" className="pipeline-metadata">
                          {t(($) => $.v18.uncertain)}
                        </p>
                      )}
                      {!progress.nodes.length && (
                        <p role="status" className="pipeline-metadata">
                          {t(($) => $.v18.empty_plan)}
                        </p>
                      )}
                      <div className="space-y-2">
                        {progress.groups.map((group) =>
                          snapshot.plan.stages.length ? (
                            <div
                              key={group.stage}
                              className="rounded-md border border-border overflow-hidden"
                            >
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 p-2 text-left hover:bg-accent"
                                aria-expanded={openStages.includes(group.stage)}
                                onClick={() => {
                                  selectPipelineProgressRun(
                                    issueKey,
                                    snapshot.id,
                                  );
                                  expandPipelineProgressStages(
                                    `${issueKey}:${runId}`,
                                    openStages.includes(group.stage)
                                      ? openStages.filter(
                                          (stage) => stage !== group.stage,
                                        )
                                      : [...openStages, group.stage],
                                  );
                                }}
                              >
                                <ChevronRight
                                  aria-hidden
                                  className={cn(
                                    "size-3.5 shrink-0",
                                    openStages.includes(group.stage) &&
                                      "rotate-90",
                                  )}
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block font-medium text-caption break-words">
                                    {group.stage || t(($) => $.v18.no_stage)}
                                  </span>
                                  <span className="block text-micro text-muted-foreground">
                                    {t(($) => $.v18.success_ratio, {
                                      succeeded: pipelineProgressCounts(
                                        group.nodes,
                                      ).succeeded,
                                      total: group.nodes.length,
                                    })}
                                    {(
                                      [
                                        "failed",
                                        "rejected",
                                        "skipped",
                                        "cancelled",
                                        "unfinished",
                                        "unknown",
                                      ] as const
                                    )
                                      .filter(
                                        (key) =>
                                          pipelineProgressCounts(group.nodes)[
                                            key
                                          ] > 0,
                                      )
                                      .map((key) => (
                                        <span key={key}>
                                          {" "}
                                          ·{" "}
                                          {t(($) => $.v18.counts[key], {
                                            count: pipelineProgressCounts(
                                              group.nodes,
                                            )[key],
                                          })}
                                        </span>
                                      ))}
                                  </span>
                                </span>
                              </button>
                              {openStages.includes(group.stage) && (
                                <div className="px-1 pb-1 space-y-1">
                                  {group.nodes.map(renderNode)}
                                </div>
                              )}
                            </div>
                          ) : (
                            <div key="nodes" className="space-y-1">
                              {group.nodes.map(renderNode)}
                            </div>
                          ),
                        )}
                      </div>
                      <details className="text-caption min-w-0">
                        <summary className="cursor-pointer">
                          {t(($) => $.v18.identity)}
                        </summary>
                        <div className="grid gap-1 mt-1 text-micro break-all">
                          <code>{snapshot.id}</code>
                          <code>{snapshot.definition_id}</code>
                          <time dateTime={snapshot.created_at}>
                            {snapshot.created_at}
                          </time>
                        </div>
                      </details>
                      <AppLink
                        className="text-primary underline text-caption"
                        href={paths.pipelineRun(snapshot.id)}
                      >
                        {t(($) => $.v18.run_details)}
                      </AppLink>
                    </>
                  )
                )
              ) : executionValue?.mode === "pipeline" ? (
                <div className="space-y-2" data-testid="pipeline-without-run">
                  {execution.isPending ? (
                    <p role="status">{t(($) => $.pipeline.loading)}</p>
                  ) : execution.isError ? (
                    <p role="alert" className="pipeline-error">
                      {failed(execution.error)}
                    </p>
                  ) : (
                    <>
                      <ExecutionSummary execution={executionValue} />
                      <p className="pipeline-metadata">
                        {t(($) => $.v18.no_run_yet)}
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={(event) => {
                          trigger.current = event.currentTarget;
                          setOpened({ issueKey, runId: null });
                        }}
                      >
                        {t(($) => $.v18.execution_details)}
                      </Button>
                    </>
                  )}
                </div>
              ) : (
                <p role="status" className="pipeline-metadata">
                  {t(($) => $.pipeline.no_runs)}
                </p>
              )}
            </>
          )}
        </>
      )}
      <Dialog
        open={!!showingDetails}
        onOpenChange={(open) => {
          if (!open) setOpened(null);
        }}
      >
        <DialogContent
          className="sm:max-w-6xl max-h-[94dvh] overflow-y-auto"
          data-testid="pipeline-node-details"
          finalFocus={() => {
            const button = trigger.current?.isConnected
              ? trigger.current
              : heading.current;
            if (button) revealSidebarNode(button);
            return button;
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {opened?.runId
                ? t(($) => $.v18.run_details)
                : t(($) => $.v18.execution_details)}
            </DialogTitle>
          </DialogHeader>
          <div className="pipeline-toolbar">
            <DialogClose
              render={<Button type="button" size="sm" variant="outline" />}
            >
              {t(($) => $.v18.back_to_node)}
            </DialogClose>
          </div>
          {showingDetails &&
            (opened?.runId ? (
              <PipelineRunDetails
                key={`${wsId}:${opened.runId}`}
                runId={opened.runId}
                nodeFirst
              />
            ) : (
              <IssueExecutionPanel issueId={issue.id} />
            ))}
        </DialogContent>
      </Dialog>
    </section>
  );
}
