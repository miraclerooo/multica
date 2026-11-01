"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWSEvent, useWSReconnect } from "@multica/core/realtime";
import { useWorkspaceId } from "@multica/core/hooks";
import { useCurrentMember } from "@multica/core/permissions";
import { useWorkspacePaths } from "@multica/core/paths";
import { canStartIssueExecution, pipelineCapabilitiesOptions, issueExecutionOptions, safeUpgradeGuide, useStartIssueExecution, type IssueExecution } from "@multica/core/pipelines";
import { DialogTitle } from "@multica/ui/components/ui/dialog";
import { Button } from "@multica/ui/components/ui/button";
import { copyText } from "@multica/ui/lib/clipboard";
import { useT } from "../i18n";
import { AppLink } from "../navigation";

export function ExecutionSummary({execution}: {execution: IssueExecution}) {
  const {t} = useT("squads");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  return <div className="space-y-2 text-caption break-words" data-testid="execution-summary">
    <p className="font-medium">{execution.mode === "markdown" ? t($ => $.execution.markdown) : execution.mode === "pipeline"
      ? `${execution.pipeline_name ?? t($ => $.execution.pipeline)} · v${execution.definition_revision ?? "?"}` : execution.mode}</p>
    {execution.mode === "pipeline" && <p role="status">{execution.state === "started" ? t($ => $.execution.started)
      : canStartIssueExecution(execution) ? t($ => $.execution.ready)
      : execution.state === "waiting_runtime" || execution.state === "ready" ? t($ => $.execution.waiting) : execution.state}</p>}
    {copyFailed && <p role="alert">{t($ => $.execution.copy_failed)}</p>}
    {execution.readiness.runtimes.map((runtime, i) => {
      const guide = safeUpgradeGuide(runtime.upgrade_guide_url);
      return <details key={`${runtime.runtime_id}:${i}`} className="rounded-md border p-2 min-w-0">
        <summary className="cursor-pointer">{runtime.name || t($ => $.execution.details)} · {runtime.status}</summary>
        <div className="grid gap-2 mt-2">
          <p>{runtime.reason}</p>
          <p>{t($ => $.execution.daemon)}: {runtime.daemon.version || t($ => $.execution.unknown)}</p>
          <p>{t($ => $.execution.disk)}: {runtime.disk?.version || t($ => $.execution.unknown)}</p>
          <p>{t($ => $.execution.required)}: {runtime.required_capabilities.join(", ")}</p>
          <p>{runtime.load_state} · {runtime.reload_pending_reason || runtime.disk_reason}</p>
          <p className="text-micro break-all">{runtime.daemon.build_commit || runtime.daemon.commit} / {runtime.disk?.build_commit || runtime.disk?.commit || t($ => $.execution.unknown)}</p>
          {runtime.upgrade_action === "official_update" ? <Button size="sm" variant="outline" onClick={() => void copyText("multica update").then(ok => {setCopied(ok);setCopyFailed(!ok);})}>
            {copied ? t($ => $.execution.copied) : t($ => $.execution.official)}</Button>
            : runtime.upgrade_action === "deployment_guide" && guide ? <a className="text-primary underline" href={guide} target="_blank" rel="noopener noreferrer">{t($ => $.execution.guide)}</a>
            : runtime.upgrade_action === "wait_idle_and_recheck" ? <p>{t($ => $.execution.wait_idle)}</p>
            : runtime.upgrade_action === "wait_online_and_recheck" ? <p>{t($ => $.execution.wait_online)}</p>
            : <p>{t($ => $.execution.no_channel)}</p>}
        </div>
      </details>;
    })}
  </div>;
}

export function IssueExecutionPanel({issueId, unconfirmed = false}: {issueId: string; unconfirmed?: boolean}) {
  const wsId = useWorkspaceId();
  const {t} = useT("squads");
  const member = useCurrentMember(wsId);
  const query = useQuery({...issueExecutionOptions(wsId, issueId), staleTime: 0});
  const start = useStartIssueExecution(wsId, issueId);
  const caps = useQuery(pipelineCapabilitiesOptions(wsId));
  const supported = caps.data?.features.waiting_runtime_resume === true && caps.data?.features.runtime_compatibility === true;
  useWSEvent("pipeline:updated", event => {if(event && typeof event === "object" && "issue_id" in event && event.issue_id === issueId) void query.refetch();});
  useWSReconnect(() => {void query.refetch();});
  const execution = query.data?.execution;
  return <section className="pipeline-box space-y-3 min-w-0" data-testid="issue-execution">
    {unconfirmed && <p role="alert">{t($ => $.execution.unconfirmed)}</p>}
    {query.isFetching ? <p role="status">{t($ => $.execution.loading)}</p> : execution ? <ExecutionSummary execution={execution} />
      : <p role="status">{t($ => $.execution.failed)}</p>}
    {(query.error || start.error) && <p role="alert" className="text-caption text-destructive">{(query.error ?? start.error)?.message}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={query.isFetching || start.isPending} onClick={() => void query.refetch()}>{t($ => $.execution.recheck)}</Button>
      {execution?.mode === "pipeline" && !supported && !caps.isLoading && <p role="status">{t($ => $.execution.unsupported)}</p>}
      {execution?.mode === "pipeline" && execution.state !== "started" && <Button type="button" size="sm"
        disabled={!supported || !member.member || query.isFetching || start.isPending || !canStartIssueExecution(execution)}
        onClick={() => { if (supported && member.member && !query.isFetching && !start.isPending && canStartIssueExecution(execution)) start.mutate(); }}>
        {t($ => $.execution.start)}</Button>}
    </div>
  </section>;
}

export function CreatedIssueResult({issueId, onClose, unconfirmed, label}: {issueId: string; onClose: () => void; unconfirmed?: boolean; label?: string}) {
  const {t} = useT("squads");
  const paths = useWorkspacePaths();
  return <div className="p-4 space-y-4 overflow-y-auto">
    <DialogTitle>{t($ => $.execution.created)}</DialogTitle>
    {label && <p className="text-caption break-words">{label}</p>}
    <AppLink className="text-primary underline" href={paths.issueDetail(issueId)}>{t($ => $.execution.view_issue)}</AppLink>
    <IssueExecutionPanel issueId={issueId} unconfirmed={unconfirmed} />
    <Button type="button" variant="outline" onClick={onClose}>{t($ => $.execution.close)}</Button>
  </div>;
}
