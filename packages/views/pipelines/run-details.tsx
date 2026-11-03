"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { publishedMaterialContentType } from "@multica/core/documents/links";
import { ApiError, api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useCurrentMember } from "@multica/core/permissions";
import { useWSEvent, useWSReconnect } from "@multica/core/realtime";
import { taskMessagesOptions } from "@multica/core/chat/queries";
import {
  memberListOptions,
  agentListOptions,
} from "@multica/core/workspace/queries";
import {
  usePipelineReviewStore,
  selectPipelineNode,
  editPipelineReview,
  pipelineRunsOptions,
  pipelineRunOptions,
  pipelineArtifactsOptions,
  pipelineDependencies,
  pipelineUsage,
  pipelineRunActions,
  useCancelPipelineRun,
  usePipelineDecision,
  useRetryPipelineJob,
  type PipelineArtifact,
  type PipelineJob,
  type PipelineRun,
} from "@multica/core/pipelines";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@multica/ui/components/ui/dialog";
import { useT } from "../i18n";
import { AppLink, useNavigation } from "../navigation";
import { ReadonlyContent } from "../editor";
import { buildTimeline } from "../common/task-transcript";
import { BreadcrumbHeader } from "../layout/breadcrumb-header";
import { AssociateDocument } from "../projects/documents/associate-document";
import { FlowGraph } from "./flow-graph";
import "./pipelines.css";

export function PipelineHistory({
  issueId,
  squadId,
}: {
  issueId?: string;
  squadId?: string;
}) {
  const { t } = useT("squads");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const [offset, setOffset] = useState(0);
  const runs = useQuery(
    pipelineRunsOptions(wsId, {
      issue_id: issueId,
      squad_id: squadId,
      limit: 20,
      offset,
    }),
  );
  return (
    <details className="space-y-3" open={!!squadId}>
      <summary className="text-label cursor-pointer">
        {t(($) => $.pipeline.runs)}
      </summary>
      {runs.isError && (
        <p role="alert" className="pipeline-error">
          {t(($) => $.pipeline.failed)}
        </p>
      )}
      {!runs.isLoading && !runs.data?.items.length && (
        <p className="pipeline-metadata">{t(($) => $.pipeline.no_runs)}</p>
      )}
      {runs.data?.items.map((run) => (
        <AppLink
          key={run.id}
          className="block pipeline-material text-caption hover:bg-accent"
          href={paths.pipelineRun(run.id)}
        >
          <strong>
            {run.issue_title} · {run.status}
          </strong>
          <span>{run.created_at}</span>
          <Usage run={run} />
        </AppLink>
      ))}
      <div className="pipeline-toolbar">
        <Button
          size="sm"
          variant="ghost"
          disabled={!offset}
          onClick={() => setOffset((o) => Math.max(0, o - 20))}
        >
          {t(($) => $.pipeline.back)}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={(runs.data?.items.length ?? 0) < 20}
          onClick={() => setOffset((o) => o + 20)}
        >
          {t(($) => $.pipeline.more)}
        </Button>
      </div>
    </details>
  );
}

export function PipelineRunPage() {
  const navigation = useNavigation();
  const id = navigation.pathname.split("/").pop() ?? "";
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const { t } = useT("squads");
  const query = useQuery(pipelineRunOptions(wsId, id));
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <BreadcrumbHeader
        segments={
          query.data
            ? [
                {
                  href: paths.issueDetail(query.data.issue_id),
                  label: query.data.issue_title,
                },
              ]
            : []
        }
        leaf={<span>{t(($) => $.pipeline.title)}</span>}
      />
      <div className="flex-1 overflow-y-auto p-3 md:p-6">
        <PipelineRunDetails runId={id} />
      </div>
    </div>
  );
}

function Usage({ run }: { run: PipelineRun }) {
  const { t } = useT("squads");
  const usage = pipelineUsage(run);
  const duration = Math.max(
    0,
    Date.parse(run.updated_at) - Date.parse(run.created_at),
  );
  return (
    <span className="pipeline-metadata">
      {`${t(($) => $.pipeline.attempt)} ${usage.attempts} · ${t(($) => $.pipeline.tokens)} ${usage.tokens.toLocaleString()} · ${usage.unpriced ? t(($) => $.pipeline.unpriced) : `$${(usage.ticks / 10_000_000_000).toFixed(4)}`}`}{" "}
      · {t(($) => $.pipeline.duration)}{" "}
      {Number.isFinite(duration) ? `${Math.round(duration / 1000)}s` : "—"}
    </span>
  );
}

export function PipelineRunDetails({ runId, nodeFirst = false }: { runId: string; nodeFirst?: boolean }) {
  const { t } = useT("squads");
  const wsId = useWorkspaceId();
  const currentMember = useCurrentMember(wsId);
  const run = useQuery(pipelineRunOptions(wsId, runId));
  const selectionKey = `${wsId}:${runId}`;
  const selected =
    usePipelineReviewStore((s) => s.draft.selections[selectionKey]) ?? "";
  const setSelected = (id: string) => selectPipelineNode(selectionKey, id);
  const cancel = useCancelPipelineRun(wsId, runId);
  const cancelKey = useRef(crypto.randomUUID());
  const refresh = () => {
    void run.refetch();
  };
  useWSEvent("pipeline:updated", refresh);
  useWSReconnect(refresh);
  const snapshot = run.data;
  useEffect(() => {
    if (!selected && snapshot)
      selectPipelineNode(
        selectionKey,
        snapshot.jobs.find((j) => j.status === "waiting_approval")?.node.id ??
          snapshot.jobs[0]?.node.id ??
          "",
      );
  }, [selected, snapshot, selectionKey]);
  if (run.isLoading)
    return <p aria-busy="true">{t(($) => $.pipeline.loading)}</p>;
  if (!snapshot || run.isError)
    return (
      <div role="alert" className="pipeline-error">
        {t(($) => $.pipeline.failed)}
        <Button variant="outline" onClick={refresh}>
          {t(($) => $.pipeline.refresh)}
        </Button>
      </div>
    );
  const job =
    snapshot.jobs.find((j) => j.node.id === selected) ??
    snapshot.jobs.find((j) => j.status === "waiting_approval") ??
    snapshot.jobs[0];
  const actions = pipelineRunActions(snapshot);
  const graph = <FlowGraph plan={snapshot.plan} run={snapshot} selected={job?.node.id} onSelect={setSelected} />;
  return (
    <div
      className="pipeline-panel space-y-4 max-w-7xl mx-auto"
      data-testid="pipeline-run-details"
    >
      <div className="pipeline-toolbar justify-between">
        <div>
          <h2 className="text-title font-semibold break-words">
            {snapshot.issue_title}
          </h2>
          <p className="pipeline-metadata">
            {snapshot.plan.kind} · {snapshot.status} · {snapshot.reason}
          </p>
        </div>
        <div className="pipeline-toolbar">
          <Button variant="ghost" size="sm" onClick={refresh}>
            {t(($) => $.pipeline.refresh)}
          </Button>
          {currentMember.member && (actions.cancel || actions.restriction) && (
            <Button
              variant="outline"
              size="sm"
              disabled={!actions.cancel || cancel.isPending}
              onClick={() => {
                if (
                  !actions.cancel ||
                  !currentMember.member ||
                  cancel.isPending
                )
                  return;
                if (window.confirm(t(($) => $.pipeline.cancel_confirm)))
                  cancel.mutate({
                    reason: "Cancelled from pipeline view",
                    idempotency_key: cancelKey.current,
                  });
              }}
            >
              {t(($) => $.pipeline.cancel_run)}
            </Button>
          )}
        </div>
      </div>
      {actions.restriction && (
        <p role="status" className="pipeline-error">
          {actions.restriction.code === "status"
            ? t(($) => $.pipeline.readonly_status)
            : actions.restriction.code === "job_status"
              ? t(($) => $.pipeline.readonly_job)
              : t(($) => $.pipeline.readonly_plan)}{" "}
          <code>{actions.restriction.value}</code>
        </p>
      )}
      <Usage run={snapshot} />
      <p className="pipeline-metadata">
        {t(($) => $.pipeline.version)}: <code>{snapshot.definition_id}</code> ·{" "}
        {snapshot.plan.source_hash}
      </p>
      {cancel.error && (
        <p role="alert" className="pipeline-error">
          {cancel.error.message}
        </p>
      )}
      {!nodeFirst && graph}
      {job && (
        <JobDetails
          key={job.node.id}
          run={snapshot}
          job={job}
          canOperate={!!currentMember.member}
        />
      )}
      {nodeFirst && graph}
      <ArtifactCatalog run={snapshot} />
    </div>
  );
}

function JobDetails({
  run,
  job,
  canOperate,
}: {
  run: PipelineRun;
  job: PipelineJob;
  canOperate: boolean;
}) {
  const { t } = useT("squads");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const [attemptNumber, setAttemptNumber] = useState<number | null>(null);
  const opinionKey = `${wsId}:${run.id}:${job.node.id}`;
  const opinion = usePipelineReviewStore((s) => s.draft.opinions[opinionKey]);
  const reason = opinion?.reason ?? "";
  const setReason = (text: string) =>
    editPipelineReview(opinionKey, text, opinion?.revision ?? reviewedRevision);
  const [initialRevision, setInitialRevision] = useState(job.revision);
  const reviewedRevision = opinion?.revision ?? initialRevision;
  const setReviewedRevision = (revision: number) => {
    setInitialRevision(revision);
    if (reason) editPipelineReview(opinionKey, reason, revision);
  };
  const operation = useRef({ body: "", key: "" });
  const decision = usePipelineDecision(wsId, run.id, job.node.id);
  const retry = useRetryPipelineJob(wsId, run.id, job.node.id);
  const members = useQuery(memberListOptions(wsId));
  const agents = useQuery(agentListOptions(wsId));
  const name = (id: string) =>
    agents.data?.find((a) => a.id === id)?.name ??
    members.data?.find((m) => m.user_id === id)?.name ??
    id;
  const attempt =
    job.attempts.find((a) => a.number === attemptNumber) ?? job.attempts.at(-1);
  const dependencies = pipelineDependencies(job.node);
  const materials =
    job.decision?.materials ??
    job.node.artifact_sources.flatMap(
      (id) =>
        run.jobs.find((j) => j.node.id === id)?.attempts.at(-1)?.report
          ?.artifacts ?? [],
    );
  const conflict = reviewedRevision !== job.revision;
  const actions = pipelineRunActions(run, job);
  const ready =
    canOperate &&
    actions.decide &&
    !conflict &&
    materials.every((a) => a.status === "accessible");
  const submit = async (value: "approve" | "reject") => {
    if (!ready || decision.isPending || (value === "reject" && !reason.trim()))
      return;
    const body = JSON.stringify({ revision: reviewedRevision, value, reason });
    if (operation.current.body !== body)
      operation.current = { body, key: crypto.randomUUID() };
    try {
      const saved = await decision.mutateAsync({
        expected_revision: reviewedRevision,
        idempotency_key: operation.current.key,
        decision: value,
        reason,
      });
      if (!saved) throw new Error(t(($) => $.pipeline.failed));
      setReason("");
    } catch {
      /* Mutation invalidation refreshes the snapshot without clearing the opinion. */
    }
  };
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <section className="pipeline-box space-y-3">
        <h3>{job.node.title || job.node.id}</h3>
        <p className="pipeline-metadata">
          {t(($) => $.pipeline.status)}: {job.status} · {job.reason}
        </p>
        <p className="pipeline-metadata">
          {t(($) => $.pipeline.executor)}:{" "}
          {job.node.type === "manual"
            ? job.decision
              ? name(job.decision.actor_id)
              : t(($) => $.pipeline.manual)
            : name(attempt?.executor_id ?? job.executor_id) || "—"}
          {job.node.type === "agent" &&
            !job.node.agent_id &&
            ` · ${job.node.role || t(($) => $.pipeline.leader)}`}
        </p>
        {(job.node.owner_user_id || job.node.owner) && (
          <p className="pipeline-metadata">
            {job.node.owner_user_id
              ? t(($) => $.v17.human_owner)
              : t(($) => $.pipeline.owner)}
            :{" "}
            {job.node.owner_user_id
              ? name(job.node.owner_user_id)
              : job.node.owner}
          </p>
        )}
        <pre className="text-caption whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
          {job.node.instructions}
        </pre>
        <h3>
          {t(($) => $.pipeline.dependencies)} ({dependencies.length})
        </h3>
        {dependencies.map((id) => {
          const upstream = run.jobs.find((j) => j.node.id === id);
          return (
            <p className="pipeline-metadata" key={id}>
              {id} · {upstream?.status} · {upstream?.reason}
            </p>
          );
        })}
        {job.node.type === "agent" &&
          canOperate &&
          ["failed", "blocked"].includes(job.status) && (
            <Button
              variant="outline"
              size="sm"
              disabled={!actions.retry || retry.isPending}
              onClick={() => {
                if (!actions.retry || !canOperate || retry.isPending) return;
                retry.mutate({
                  expected_revision: job.revision,
                  idempotency_key: crypto.randomUUID(),
                });
              }}
            >
              {t(($) => $.pipeline.retry)}
            </Button>
          )}
        {retry.error && (
          <p role="alert" className="pipeline-error">
            {retry.error.message}
          </p>
        )}
        {!!job.attempts.length && (
          <label className="pipeline-metadata block">
            {t(($) => $.pipeline.attempt)}{" "}
            <select
              className="pipeline-select"
              value={attempt?.number}
              onChange={(e) => setAttemptNumber(Number(e.target.value))}
            >
              {job.attempts.map((a) => (
                <option
                  key={a.number}
                  value={a.number}
                >{`${a.number} · ${a.status} · ${name(a.executor_id)}`}</option>
              ))}
            </select>
          </label>
        )}
        {attempt && (
          <>
            <p className="pipeline-metadata">
              {attempt.started_at} → {attempt.completed_at ?? "—"}
            </p>
            <TaskLogs taskId={attempt.task_id} />
            {attempt.report && (
              <ReadonlyContent content={attempt.report.report} />
            )}
            {attempt.inputs.map((a) => (
              <ArtifactMaterial key={a.id} run={run} artifact={a} />
            ))}
          </>
        )}
      </section>
      <section className="pipeline-box space-y-3">
        <h3>
          {job.node.type === "manual"
            ? t(($) => $.pipeline.manual)
            : t(($) => $.pipeline.artifacts)}
        </h3>
        {materials.map((a) => (
          <ArtifactMaterial
            key={`${a.job_id}:${a.attempt}:${a.id}`}
            artifact={a}
            run={run}
          />
        ))}
        {job.node.type === "manual" && (
          <>
            {job.decision ? (
              <div className="pipeline-material">
                <strong>
                  {t(($) => $.pipeline.decision)} · {job.decision.decision}
                </strong>
                <span>
                  {name(job.decision.actor_id)} · {job.decision.created_at}
                </span>
                <p className="whitespace-pre-wrap">{job.decision.reason}</p>
                {reason && (
                  <label className="block text-label">
                    {t(($) => $.pipeline.kept)}
                    <textarea
                      readOnly
                      value={reason}
                      className="mt-2 w-full rounded-md border p-3 text-body bg-background"
                    />
                  </label>
                )}
              </div>
            ) : (
              <>
                {job.status !== "waiting_approval" && (
                  <p className="pipeline-metadata">
                    {t(($) => $.pipeline.waiting)} · {job.reason || job.status}
                  </p>
                )}
                {!canOperate && (
                  <p className="pipeline-error">
                    {t(($) => $.pipeline.permission)}
                  </p>
                )}
                {conflict && (
                  <div role="alert" className="pipeline-error">
                    {t(($) => $.pipeline.decision_conflict)}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setReviewedRevision(job.revision)}
                    >
                      {t(($) => $.pipeline.review_latest)}
                    </Button>
                  </div>
                )}
                <label className="block text-label">
                  {t(($) => $.pipeline.reason)}
                  <textarea
                    rows={4}
                    className="mt-2 w-full rounded-md border p-3 text-body bg-background"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    readOnly={
                      !canOperate || !!actions.restriction || decision.isPending
                    }
                  />
                </label>
                {!reason.trim() && (
                  <p className="pipeline-metadata">
                    {t(($) => $.pipeline.reason_required)}
                  </p>
                )}
                <div className="pipeline-toolbar">
                  <Button
                    disabled={!ready || decision.isPending}
                    aria-busy={decision.isPending}
                    onClick={() => void submit("approve")}
                  >
                    {t(($) => $.pipeline.approve)}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!ready || !reason.trim() || decision.isPending}
                    onClick={() => void submit("reject")}
                  >
                    {t(($) => $.pipeline.reject)}
                  </Button>
                </div>
                {decision.error && (
                  <p role="alert" className="pipeline-error">
                    {decision.error instanceof ApiError &&
                    decision.error.status === 409
                      ? t(($) => $.pipeline.decision_conflict)
                      : decision.error.message}
                  </p>
                )}
              </>
            )}
          </>
        )}
        {job.node.paths.map((path) => {
          const file = job.node.deliverables.find((d) => d.path === path);
          return (
            <div key={path} className="space-y-1">
              <p className="pipeline-metadata">
                {t(($) => $.pipeline.declared)}:{" "}
                <strong>{file?.name || path}</strong>
              </p>
              {file?.description && (
                <p className="whitespace-pre-wrap break-words">
                  {file.description}
                </p>
              )}
              <code className="text-caption break-all">{path}</code>
            </div>
          );
        })}
        <AppLink
          className="text-caption underline"
          href={paths.issueDetail(run.issue_id)}
        >
          {t(($) => $.pipeline.back)}
        </AppLink>
      </section>
    </div>
  );
}

function TaskLogs({ taskId }: { taskId: string }) {
  const { t } = useT("squads");
  const logs = useQuery(taskMessagesOptions(taskId));
  useWSEvent("task:message", (payload) => {
    if (
      payload &&
      typeof payload === "object" &&
      "task_id" in payload &&
      payload.task_id === taskId
    )
      void logs.refetch();
  });
  useWSReconnect(() => {
    void logs.refetch();
  });
  return (
    <details>
      <summary className="text-caption cursor-pointer">
        {t(($) => $.pipeline.logs)}
      </summary>
      <div className="max-h-72 overflow-auto text-caption">
        {logs.isError && (
          <p role="alert" className="pipeline-error">
            {t(($) => $.pipeline.failed)}
          </p>
        )}
        {!logs.isLoading && !logs.data?.length && (
          <p className="pipeline-metadata">{t(($) => $.pipeline.no_logs)}</p>
        )}
        {buildTimeline(logs.data ?? []).map((m, i) => (
          <pre className="whitespace-pre-wrap break-words my-2" key={i}>
            {m.tool ? `${m.type} · ${m.tool}\n` : ""}
            {m.content || m.output || JSON.stringify(m.input ?? {})}
          </pre>
        ))}
      </div>
    </details>
  );
}

function ArtifactCatalog({ run }: { run: PipelineRun }) {
  const wsId = useWorkspaceId();
  const { t } = useT("squads");
  const [offset, setOffset] = useState(0);
  const artifacts = useQuery(
    pipelineArtifactsOptions(wsId, run.id, { limit: 50, offset }),
  );
  return (
    <section className="pipeline-box space-y-3">
      <h3>{t(($) => $.pipeline.artifacts)}</h3>
      {artifacts.isError && (
        <p role="alert" className="pipeline-error">
          {t(($) => $.pipeline.failed)}
        </p>
      )}
      {artifacts.data?.items.map((a) => (
        <ArtifactMaterial key={a.id} run={run} artifact={a} collect />
      ))}
      <div className="pipeline-toolbar">
        <Button
          size="sm"
          variant="ghost"
          disabled={!offset}
          onClick={() => setOffset((o) => Math.max(0, o - 50))}
        >
          {t(($) => $.pipeline.back)}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={(artifacts.data?.items.length ?? 0) < 50}
          onClick={() => setOffset((o) => o + 50)}
        >
          {t(($) => $.pipeline.more)}
        </Button>
      </div>
    </section>
  );
}

function ArtifactMaterial({
  artifact: a,
  run,
  collect = false,
}: {
  artifact: PipelineArtifact;
  run: PipelineRun;
  collect?: boolean;
}) {
  const { t } = useT("squads");
  const [open, setOpen] = useState(false);
  return (
    <div className="pipeline-material text-caption">
      <strong>{a.name || a.path}</strong>
      {a.description && (
        <p className="whitespace-pre-wrap break-words">{a.description}</p>
      )}
      {a.name && a.name !== a.path && (
        <code className="pipeline-metadata break-all">{a.path}</code>
      )}
      <span className="pipeline-metadata">
        {a.job_id} · {t(($) => $.pipeline.attempt)} {a.attempt} · {a.status}
      </span>
      {(a.sha || a.attachment_id || a.document_id) && (
        <span className="pipeline-metadata">
          {a.sha ||
            a.attachment_id ||
            `${a.document_id} · v${a.document_version}`}
        </span>
      )}
      {a.status === "accessible" ? (
        <div className="pipeline-toolbar">
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger render={<Button size="sm" variant="outline" />}>
              {t(($) => $.pipeline.open)}
            </DialogTrigger>
            <DialogContent className="max-w-5xl">
              <DialogHeader>
                <DialogTitle>{a.path}</DialogTitle>
              </DialogHeader>
              {open && <MaterialContent runId={run.id} artifact={a} />}
            </DialogContent>
          </Dialog>
          {collect && (
            <AssociateDocument
              issueId={run.issue_id}
              projectId={run.project_id}
              source={{
                kind: "pipeline_artifact",
                run_id: run.id,
                job_id: a.job_id,
                attempt: a.attempt,
                path: a.path,
              }}
              label={a.name || a.path}
              description={a.description}
            />
          )}
        </div>
      ) : (
        <p className="pipeline-error">
          {a.reason ||
            (a.status === "declared"
              ? t(($) => $.pipeline.declared)
              : t(($) => $.pipeline.unavailable))}
        </p>
      )}
    </div>
  );
}

function MaterialContent({
  runId,
  artifact,
}: {
  runId: string;
  artifact: PipelineArtifact;
}) {
  const { t } = useT("squads");
  const wsId = useWorkspaceId();
  const [url, setUrl] = useState("");
  const [text, setText] = useState<string | null>(null);
  const content = useQuery({
    queryKey: [
      "pipeline-material",
      wsId,
      runId,
      artifact.id,
      artifact.document_version,
      artifact.sha,
    ],
    queryFn: () => api.getPipelineArtifactContent(runId, artifact.id),
    staleTime: 0,
  });
  useEffect(() => {
    if (!content.data) return;
    const objectUrl = URL.createObjectURL(
      content.data.slice(
        0,
        content.data.size,
        publishedMaterialContentType(content.data.type, artifact.path),
      ),
    );
    setUrl(objectUrl);
    if (/\.(md|txt|yaml|yml|json|log)$/i.test(artifact.path))
      void content.data.text().then(setText);
    return () => URL.revokeObjectURL(objectUrl);
  }, [content.data, artifact.path]);
  if (content.isError)
    return (
      <p role="alert" className="pipeline-error">
        {content.error.message}
      </p>
    );
  if (content.isLoading)
    return <p aria-busy="true">{t(($) => $.pipeline.loading)}</p>;
  return (
    <div className="space-y-3 min-w-0">
      <p className="pipeline-metadata">
        {t(($) => $.pipeline.pinned)} ·{" "}
        {artifact.sha ||
          artifact.attachment_id ||
          `v${artifact.document_version}`}
      </p>
      {text !== null ? (
        <div className="max-h-[65dvh] overflow-auto">
          <ReadonlyContent content={text} />
        </div>
      ) : /\.(md|txt|yaml|yml|json|log)$/i.test(artifact.path) ? (
        <p aria-busy="true">{t(($) => $.pipeline.loading)}</p>
      ) : (
        url && (
          <iframe
            sandbox="allow-scripts"
            src={url}
            title={artifact.path}
            className="w-full h-[60dvh] border rounded-lg"
          />
        )
      )}
      {url && (
        <a
          className="underline text-caption"
          href={url}
          download={artifact.path.split("/").pop()}
        >
          {t(($) => $.pipeline.open)}
        </a>
      )}
    </div>
  );
}
