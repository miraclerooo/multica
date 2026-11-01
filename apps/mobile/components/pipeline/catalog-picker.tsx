import { useState } from "react";
import { ScrollView } from "react-native";
import { router } from "expo-router";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { api } from "@/data/api";
import { usePipelineEditorStore } from "@/data/stores/pipeline-editor-store";
import { pipelineKeys, pipelineCapabilitiesOptions, pipelineCatalogOptions, pipelineDefinitionOptions } from "@/data/queries/pipelines";
import { squadListOptions } from "@/data/queries/squads";
import { memberListOptions } from "@/data/queries/members";
import { useAuthStore } from "@/data/auth-store";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useT } from "@/lib/i18n";

export function CatalogPicker({kind}: {kind: "squad" | "pipeline" | "version" | "default"}) {
  const {t} = useT("issues");
  const wsId = useWorkspaceStore(s => s.currentWorkspaceId) ?? "";
  const user = useAuthStore(s => s.user);
  const state = usePipelineEditorStore();
  const qc = useQueryClient();
  const squads = useQuery(squadListOptions(wsId));
  const caps = useQuery(pipelineCapabilitiesOptions(wsId));
  const supported = caps.data?.features.pipeline_catalog === true;
  const squadId = state.squads[wsId] ?? squads.data?.[0]?.id ?? "";
  const squad = squads.data?.find(s => s.id === squadId);
  const members = useQuery(memberListOptions(wsId));
  const role = members.data?.find(m => m.user_id === user?.id)?.role;
  const canManage = !!user && (role === "owner" || role === "admin" || squad?.creator_id === user.id);
  const key = `${wsId}:${squadId}`;
  const catalog = useQuery(pipelineCatalogOptions(wsId, squadId));
  const id = state.pipelines[key] ?? catalog.data?.[0]?.id ?? "";
  const definitions = useQueries({queries: (catalog.data ?? []).map(p => pipelineDefinitionOptions(wsId, p.executable_definition_id ?? ""))});
  const [offset, setOffset] = useState(0);
  const versions = useQuery({queryKey: [...pipelineKeys.all(wsId), "versions", id, offset], queryFn: ({signal}) => api.listPipelineDefinitions(squadId, id, {signal}, offset), enabled: kind === "version" && !!id});
  const defaults = useMutation({mutationFn: (pipelineId: string | null) => {
    if (!canManage || !squad) throw new Error(t("execution.readonly"));
    if (!supported) throw new Error(t("execution.unsupported"));
    if (!squad.revision) throw new Error(t("execution.failed"));
    return api.updateSquadPipeline(squadId, {...(pipelineId ? {pipeline_id: pipelineId} : {instructions_mode: "markdown" as const}), expected_revision: squad.revision});
  }, onError: () => {void qc.invalidateQueries({queryKey: squadListOptions(wsId).queryKey});}, onSuccess: async () => {await qc.invalidateQueries({queryKey: squadListOptions(wsId).queryKey});router.back();}});
  const title = kind === "squad" ? t("execution.select_squad") : kind === "version" ? t("pipeline.history") : kind === "default" ? t("execution.default_mode") : t("execution.catalog");
  return <ScrollView className="flex-1 bg-background" contentContainerClassName="p-4 gap-3">
    <Text className="text-lg font-semibold">{title}</Text>
    {kind === "default" && !supported && !caps.isLoading && <Text>{t("execution.unsupported")}</Text>}
    {(catalog.error || versions.error || defaults.error) && <Text className="text-destructive">{(catalog.error ?? versions.error ?? defaults.error)?.message}</Text>}
    {kind === "squad" ? squads.data?.filter(s => !s.archived_at).map(s => <Button key={s.id} variant="outline" className="h-auto min-h-10 py-3" onPress={() => {state.selectSquad(wsId, s.id);router.back();}}><Text>{s.name}</Text></Button>)
      : kind === "version" ? <>
        {versions.data?.items.map(v => <Button key={v.id} variant="outline" className="h-auto min-h-10 py-3" onPress={() => {
          const draftKey = `${key}:${id}`;
          const current = state.drafts[draftKey];
          if (current) state.edit(`${draftKey}:retained`, current);
          state.clear(draftKey);state.selectVersion(draftKey, v.id);router.back();
        }}><Text>v{v.revision} · {v.kind}</Text></Button>)}
        {offset > 0 && <Button variant="ghost" onPress={() => setOffset(v => Math.max(0,v-100))}><Text>{t("pipeline.back")}</Text></Button>}
        {versions.data?.items.length === versions.data?.limit && <Button variant="ghost" onPress={() => setOffset(v => v+100)}><Text>{t("pipeline.more")}</Text></Button>}
      </> : <>
        {kind === "default" && <Button variant="outline" className="h-auto min-h-10 py-3" disabled={!supported || !canManage || !squad?.revision || defaults.isPending} onPress={() => defaults.mutate(null)}><Text>{t("execution.markdown")}</Text></Button>}
        {canManage && <Button variant="outline" className="h-auto min-h-10 py-3" disabled={defaults.isPending} onPress={() => {state.selectPipeline(key, "");router.back();}}><Text>{t("execution.new_pipeline")}</Text></Button>}
        {catalog.data?.map((p,i) => <Button key={p.id} variant="outline" className="h-auto min-h-10 py-3" disabled={kind === "default" && (!supported || !canManage || !squad?.revision || defaults.isPending || !p.executable_definition_id || !definitions[i]?.data)} onPress={() => {
          if(kind === "default") defaults.mutate(p.id);else {state.selectPipeline(key,p.id);router.back();}
        }}><Text>{p.name} · {definitions[i]?.data ? `v${definitions[i]!.data!.revision} · ${definitions[i]!.data!.kind}` : t("execution.no_executable")}</Text></Button>)}
      </>}
  </ScrollView>;
}
