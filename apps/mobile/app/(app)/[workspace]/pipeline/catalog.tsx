import { newExecutionRequestKey } from "@multica/core/pipelines/execution";
import { useRef, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { Stack, router } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { pipelineSourceKind } from "@multica/core/pipelines/utils";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { api } from "@/data/api";
import { pipelineKeys, pipelineCapabilitiesOptions, pipelineCatalogOptions, pipelineDefinitionOptions, useCatalogRealtime } from "@/data/queries/pipelines";
import { squadListOptions } from "@/data/queries/squads";
import { memberListOptions } from "@/data/queries/members";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useAuthStore } from "@/data/auth-store";
import { usePipelineEditorStore } from "@/data/stores/pipeline-editor-store";
import { useT } from "@/lib/i18n";

export default function PipelineCatalogPage() {
  const {t} = useT("issues");
  const wsId = useWorkspaceStore(s => s.currentWorkspaceId) ?? "";
  const slug = useWorkspaceStore(s => s.currentWorkspaceSlug);
  const user = useAuthStore(s => s.user);
  const state = usePipelineEditorStore();
  const squads = useQuery(squadListOptions(wsId));
  const members = useQuery(memberListOptions(wsId));
  const caps = useQuery(pipelineCapabilitiesOptions(wsId));
  const supported = caps.data?.features.pipeline_catalog === true;
  const squadId = state.squads[wsId] ?? squads.data?.[0]?.id ?? "";
  const squad = squads.data?.find(s => s.id === squadId);
  useCatalogRealtime(squadId);
  const list = useQuery({...pipelineCatalogOptions(wsId, squadId), enabled: !!squad && supported});
  const selectionKey = `${wsId}:${squadId}`;
  const id = state.pipelines[selectionKey] ?? list.data?.[0]?.id ?? "";
  const catalog = list.data?.find(p => p.id === id);
  const key = `${selectionKey}:${id || "new"}`;
  const draft = state.drafts[key];
  const versions = useQuery({queryKey: [...pipelineKeys.all(wsId), "definitions", id], queryFn: ({signal}) => api.listPipelineDefinitions(squadId, id, {signal}), enabled: !!catalog});
  const definitionId = state.versions[key] ?? catalog?.executable_definition_id ?? versions.data?.items[0]?.id ?? "";
  const definition = useQuery(pipelineDefinitionOptions(wsId, definitionId));
  const source = draft?.source ?? definition.data?.source ?? "";
  const sourceReady = !catalog || draft?.source !== undefined || !!definition.data;
  const name = draft?.name ?? catalog?.name ?? "";
  const role = members.data?.find(m => m.user_id === user?.id)?.role;
  const canManage = !!list.data && (!id || !!catalog) && !!user && (role === "owner" || role === "admin" || squad?.creator_id === user.id);
  const qc = useQueryClient();
  const [conflict, setConflict] = useState(false);
  const receipt = useRef({body: "", key: ""});
  const refresh = async () => {await Promise.all([qc.invalidateQueries({queryKey: pipelineKeys.all(wsId)}), qc.invalidateQueries({queryKey: squadListOptions(wsId).queryKey})]);};
  const save = useMutation({mutationFn: async () => {
    if (!canManage || !supported || !squad || !source.trim() || !name.trim()) throw new Error(t("pipeline.readonly"));
    const input = {squad_id: squadId, source, ...(catalog ? {pipeline_id: catalog.id, expected_pipeline_revision: draft?.catalogRevision ?? catalog.revision} : {name: name.trim()})};
    const body = JSON.stringify(input);
    if (receipt.current.body !== body) receipt.current = {body, key: newExecutionRequestKey()};
    if (catalog) return {pipeline: catalog, definition: await api.createPipelineDefinition({...input, idempotency_key: receipt.current.key})};
    return api.createPipelineCatalog({...input, name: name.trim(), idempotency_key: receipt.current.key});
  }, onSuccess: async result => {
    if (usePipelineEditorStore.getState().drafts[key] === draft) {
      state.clear(key);
      if (catalog && draft?.name && draft.name !== catalog.name) state.edit(key, {name: draft.name, catalogRevision: draft.catalogRevision});
    }
    state.selectPipeline(selectionKey, result.pipeline.id);
    state.selectVersion(`${selectionKey}:${result.pipeline.id}`, result.definition.id);
    await refresh();setConflict(false);
  }, onError: () => {setConflict(true);void refresh();}});
  const rename = useMutation({mutationFn: () => {
    if (!canManage || !catalog) throw new Error(t("execution.readonly"));
    if (!supported) throw new Error(t("execution.unsupported"));
    return api.renamePipelineCatalog(catalog.id, name.trim(), draft?.catalogRevision ?? catalog.revision);
  }, onSuccess: async updated => {state.edit(key, {catalogRevision: updated.revision});await refresh();setConflict(false);}, onError: () => {setConflict(true);void refresh();}});
  const review = useMutation({mutationFn: async () => {
    await refresh();
    const latest = await qc.fetchQuery(pipelineCatalogOptions(wsId,squadId));
    const p = latest.find(p => p.id === id);
    if (!p) throw new Error(t("execution.failed"));
    return p;
  }, onSuccess: p => {state.edit(key,{catalogRevision:p.revision});setConflict(false);}});
  const busy = save.isPending || rename.isPending || review.isPending;
  const edit = (patch: {name?: string; source?: string}) => state.edit(key, {...patch, catalogRevision: draft?.catalogRevision ?? catalog?.revision});
  const open = (path: "select-squad" | "select-pipeline" | "select-version" | "select-default") => {
    state.selectSquad(wsId, squadId);state.selectPipeline(selectionKey, id);
    router.push({pathname: `/[workspace]/pipeline/${path}`, params: {workspace: slug!}});
  };
  return <ScrollView className="flex-1 bg-background" contentContainerClassName="p-4 gap-3" keyboardShouldPersistTaps="handled">
    <Stack.Screen options={{title: t("execution.catalog")}} />
    <Button variant="outline" className="h-auto min-h-10 py-3" onPress={() => open("select-squad")}><Text>{squad?.name ?? t("execution.select_squad")}</Text></Button>
    <Button variant="outline" className="h-auto min-h-10 py-3" disabled={!squad || busy} onPress={() => open("select-pipeline")}><Text>{catalog?.name ?? t("execution.new_pipeline")}</Text></Button>
    <Button variant="outline" disabled={!squad || !canManage || busy || !supported} onPress={() => open("select-default")}><Text>{t("execution.default_mode")}: {squad?.instructions_mode === "pipeline" ? t("execution.pipeline") : t("execution.markdown")}</Text></Button>
    {!canManage && <Text>{t("execution.readonly")}</Text>}
    {!supported && !caps.isLoading && <Text>{t("execution.unsupported")}</Text>}
    {(list.error || save.error || rename.error || review.error) && <Text className="text-destructive">{(list.error ?? save.error ?? rename.error ?? review.error)?.message}</Text>}
    <Text>{t("execution.name")}</Text>
    <TextInput accessibilityLabel={t("execution.name")} value={name} onChangeText={value => edit({name: value})} editable={canManage && !busy} className="border border-border rounded-lg p-3 text-foreground" />
    {catalog && <Button variant="outline" disabled={!canManage || !supported || busy || !name.trim()} onPress={() => {if(canManage && supported && !busy && catalog) rename.mutate();}}><Text>{t("execution.rename")}</Text></Button>}
    <Text>{t("pipeline.yaml")} · {pipelineSourceKind(source)} {definition.data ? `· v${definition.data.revision}` : ""}</Text>
    {!source && canManage && <View className="gap-2">
      <Button variant="outline" onPress={() => edit({source: "kind: gitlab_yaml\nstages: [work]\nwork:\n  stage: work\n  instructions: |\n    Describe the work here.\n"})}><Text>gitlab_yaml</Text></Button>
      <Button variant="outline" onPress={() => edit({source: "kind: hermes_yaml\nroles: {}\nstates:\n  work:\n    entry: |\n      Describe the work here.\nedges: []\n"})}><Text>hermes_yaml</Text></Button>
    </View>}
    {!sourceReady && <Text>{definition.isFetching || versions.isFetching ? t("pipeline.loading") : t("pipeline.failed")}</Text>}
    <TextInput accessibilityLabel={t("pipeline.yaml")} multiline textAlignVertical="top" value={source} onChangeText={value => edit({source: value})} editable={canManage && !busy && sourceReady} autoCapitalize="none" autoCorrect={false} className="min-h-72 border border-border rounded-lg p-3 text-foreground font-mono" />
    <Button disabled={!canManage || !supported || !sourceReady || busy || !source.trim() || !name.trim()} onPress={() => {if(!busy && canManage && supported && sourceReady) save.mutate();}}><Text>{t("pipeline.save")}</Text></Button>
    {save.isSuccess && <Text accessibilityRole="text">{t("execution.saved")}</Text>}
    {catalog && <Button variant="outline" disabled={busy} onPress={() => open("select-version")}><Text>{t("pipeline.history")}</Text></Button>}
    {state.drafts[`${key}:retained`] && <Button variant="outline" onPress={() => state.edit(key, state.drafts[`${key}:retained`]!)}><Text>{t("pipeline.kept")}</Text></Button>}
    {conflict && <View className="gap-2"><Text>{t("pipeline.conflict")}</Text><Text>{catalog?.name}</Text><Text selectable>{versions.data?.items[0]?.source}</Text>
      <Button variant="outline" disabled={busy} onPress={() => {if (!busy) review.mutate();}}><Text>{t("pipeline.review_latest")}</Text></Button>
    </View>}
  </ScrollView>;
}
