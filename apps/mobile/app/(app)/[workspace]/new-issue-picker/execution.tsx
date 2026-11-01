import { ScrollView } from "react-native";
import { router } from "expo-router";
import { useQueries } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useNewIssueExecution } from "@/components/pipeline/execution";
import { useNewIssueDraftStore } from "@/data/stores/new-issue-draft-store";
import { pipelineDefinitionOptions } from "@/data/queries/pipelines";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useT } from "@/lib/i18n";
import type { ExecutionSelection } from "@multica/core/pipelines/execution";

export default function ExecutionPicker() {
  const {t} = useT("issues");
  const value = useNewIssueExecution();
  const wsId = useWorkspaceStore(s => s.currentWorkspaceId);
  const definitions = useQueries({queries: (value.catalog.data ?? []).map(p => pipelineDefinitionOptions(wsId, p.executable_definition_id ?? ""))});
  const pick = (selection: ExecutionSelection) => {useNewIssueDraftStore.getState().setExecutionSelection(value.squadId, selection);router.back();};
  return <ScrollView className="flex-1 bg-background" contentContainerClassName="p-4 gap-3">
    <Text className="text-lg font-semibold">{t("execution.selection")}</Text>
    <Button variant="outline" className="h-auto min-h-10 py-3" onPress={() => pick({mode: "default"})}><Text>{t("execution.use_default")}</Text></Button>
    <Button variant="outline" className="h-auto min-h-10 py-3" onPress={() => pick({mode: "markdown"})}><Text>{t("execution.markdown")}</Text></Button>
    {value.catalog.data?.map((p, i) => <Button key={p.id} variant="outline" className="h-auto min-h-10 py-3" disabled={!p.executable_definition_id || !definitions[i]?.data} onPress={() => pick({mode: "pipeline", pipeline_id: p.id, definition_id: p.executable_definition_id!})}>
      <Text>{p.name} · {definitions[i]?.data ? `v${definitions[i]!.data!.revision} · ${definitions[i]!.data!.kind}` : t("execution.no_executable")}</Text>
    </Button>)}
    {value.catalog.error && <Text className="text-destructive">{value.catalog.error.message}</Text>}
  </ScrollView>;
}
