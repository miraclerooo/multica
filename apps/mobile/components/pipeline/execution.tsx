import { useState } from "react";
import { Alert, Linking, View } from "react-native";
import { router } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useQuery } from "@tanstack/react-query";
import { canStartIssueExecution, safeUpgradeGuide, selectionFromPreview } from "@multica/core/pipelines/execution";
import type { ExecutionSelection, IssueExecution } from "@multica/core/pipelines/execution";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { executionPreviewOptions, issueExecutionOptions, pipelineCapabilitiesOptions, pipelineCatalogOptions, useStartIssueExecution, usePipelineRealtime, useCatalogRealtime } from "@/data/queries/pipelines";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useAuthStore } from "@/data/auth-store";
import { useNewIssueDraftStore } from "@/data/stores/new-issue-draft-store";
import { useT } from "@/lib/i18n";

export function useNewIssueExecution() {
  const wsId = useWorkspaceStore(s => s.currentWorkspaceId);
  const assignee = useNewIssueDraftStore(s => s.assignee);
  const selections = useNewIssueDraftStore(s => s.executionSelections);
  const squadId = assignee?.type === "squad" ? assignee.id : "";
  useCatalogRealtime(squadId);
  const selection: ExecutionSelection = selections[squadId] ?? {mode: "default"};
  const caps = useQuery({...pipelineCapabilitiesOptions(wsId), enabled: !!wsId && !!squadId});
  const supported = caps.data?.features.task_execution_selection === true;
  const catalog = useQuery({...pipelineCatalogOptions(wsId, squadId), enabled: !!wsId && !!squadId && supported});
  const selected = selection.mode !== "pipeline" || catalog.data?.some(p => p.id === selection.pipeline_id && !!p.executable_definition_id);
  const preview = useQuery({...executionPreviewOptions(wsId, squadId, selection), enabled: !!wsId && !!squadId && supported && !!selected});
  const frozen = selected && !preview.isFetching ? selectionFromPreview(selection, preview.data) : null;
  return {squadId, selection, supported, checking: caps.isLoading, catalog, preview, frozen, canSubmit: !squadId || (!!frozen && preview.data?.squad_id === squadId)};
}

export function ExecutionPreview({execution}: {execution: IssueExecution}) {
  const {t} = useT("issues");
  const [details, setDetails] = useState(false);
  return <View className="gap-2">
    <Text className="font-semibold">{execution.mode === "markdown" ? t("execution.markdown") : execution.mode !== "pipeline" ? `${t("execution.unknown")} (${execution.mode})` : `${execution.pipeline_name ?? t("execution.pipeline")} · v${execution.definition_revision ?? "?"}`}</Text>
    {execution.mode === "pipeline" && <Text>{execution.state === "started" ? t("execution.started") : !["ready","waiting_runtime"].includes(execution.state) ? `${t("execution.unknown")} (${execution.state})` : canStartIssueExecution(execution) ? t("execution.ready") : t("execution.waiting")}</Text>}
    {!!execution.readiness.runtimes.length && <Button variant="ghost" onPress={() => setDetails(v => !v)}><Text>{t("execution.details")}</Text></Button>}
    {details && execution.readiness.runtimes.map((r, i) => {
      const guide = safeUpgradeGuide(r.upgrade_guide_url);
      return <View key={`${r.runtime_id}:${i}`} className="rounded-lg border border-border p-3 gap-2">
        <Text>{r.name} · {r.status}</Text><Text>{r.reason}</Text>
        <Text>{t("execution.daemon")}: {r.daemon.version || t("execution.unknown")}</Text>
        <Text>{t("execution.disk")}: {r.disk?.version || t("execution.unknown")}</Text>
        <Text>{t("execution.required")}: {r.required_capabilities.join(", ")}</Text>
        <Text>{r.load_state} · {r.reload_pending_reason || r.disk_reason}</Text>
        <Text className="text-xs text-muted-foreground">{r.daemon.build_commit || r.daemon.commit} / {r.disk?.build_commit || r.disk?.commit || t("execution.unknown")}</Text>
        {r.upgrade_action === "official_update" ? <Button variant="outline" onPress={() => void Clipboard.setStringAsync("multica update").then(ok => {if(!ok) Alert.alert(t("execution.copy_failed"));}).catch(() => Alert.alert(t("execution.copy_failed")))}><Text>{t("execution.official")}</Text></Button>
          : r.upgrade_action === "deployment_guide" && guide ? <Button variant="outline" onPress={() => void Linking.openURL(guide)}><Text>{t("execution.guide")}</Text></Button>
          : <Text>{r.upgrade_action === "wait_idle_and_recheck" ? t("execution.wait_idle") : r.upgrade_action === "wait_online_and_recheck" ? t("execution.wait_online") : t("execution.no_channel")}</Text>}
      </View>;
    })}
  </View>;
}

export function NewIssueExecution({value}: {value: ReturnType<typeof useNewIssueExecution>}) {
  const {t} = useT("issues");
  const slug = useWorkspaceStore(s => s.currentWorkspaceSlug);
  if (!value.squadId) return null;
  return <View className="gap-2 border border-border rounded-lg p-3">
    <Button variant="outline" onPress={() => router.push({pathname: "/[workspace]/new-issue-picker/execution", params: {workspace: slug!}})}><Text>{t("execution.selection")}</Text></Button>
    {value.checking ? <Text>{t("execution.loading")}</Text> : !value.supported ? <Text>{t("execution.unsupported")}</Text> : value.preview.isFetching ? <Text>{t("execution.loading")}</Text>
      : value.preview.error ? <Text className="text-destructive">{value.preview.error.message}</Text> : value.preview.data ? <ExecutionPreview execution={value.preview.data} /> : <Text>{t("execution.failed")}</Text>}
    <Button variant="ghost" disabled={value.preview.isFetching} onPress={() => {void value.preview.refetch();void value.catalog.refetch();}}><Text>{t("execution.recheck")}</Text></Button>
  </View>;
}

export function MobileIssueExecution({issueId}: {issueId: string}) {
  usePipelineRealtime(issueId);
  const {t} = useT("issues");
  const wsId = useWorkspaceStore(s => s.currentWorkspaceId);
  const user = useAuthStore(s => s.user);
  const query = useQuery(issueExecutionOptions(wsId, issueId));
  const start = useStartIssueExecution(wsId, issueId);
  const caps = useQuery(pipelineCapabilitiesOptions(wsId));
  const supported = caps.data?.features.waiting_runtime_resume === true && caps.data?.features.runtime_compatibility === true;
  const execution = query.data?.execution;
  return <View className="gap-2">
    {execution ? <ExecutionPreview execution={execution} /> : <Text>{query.isFetching ? t("execution.loading") : t("execution.failed")}</Text>}
    {(query.error || start.error) && <Text className="text-destructive">{(query.error ?? start.error)?.message}</Text>}
    <Button variant="outline" disabled={query.isFetching || start.isPending} onPress={() => void query.refetch()}><Text>{t("execution.recheck")}</Text></Button>
    {execution?.mode === "pipeline" && !supported && !caps.isLoading && <Text>{t("execution.unsupported")}</Text>}
    {execution?.mode === "pipeline" && execution.state !== "started" && <Button disabled={!supported || !user || query.isFetching || start.isPending || !canStartIssueExecution(execution)} onPress={() => {
      if (supported && user && !query.isFetching && !start.isPending && canStartIssueExecution(execution)) start.mutate();
    }}><Text>{t("execution.start")}</Text></Button>}
  </View>;
}
