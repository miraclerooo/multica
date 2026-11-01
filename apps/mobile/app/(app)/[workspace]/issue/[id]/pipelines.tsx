import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import {
  pipelineRunsOptions,
  usePipelineRealtime,
} from "@/data/queries/pipelines";
import { useWorkspaceStore } from "@/data/workspace-store";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

export default function PipelineRunsRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const slug = useWorkspaceStore((s) => s.currentWorkspaceSlug);
  const { t } = useT("issues");
  const [offset, setOffset] = useState(0);
  const runs = useQuery(pipelineRunsOptions(wsId, id, offset));
  usePipelineRealtime(id);
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="p-4 gap-3"
    >
      <Stack.Screen options={{ title: t("pipeline.runs") }} />
      {runs.error && (
        <Text className="text-destructive">{runs.error.message}</Text>
      )}
      {!runs.isLoading && !runs.data?.items.length && (
        <Text>{t("pipeline.no_runs")}</Text>
      )}
      {runs.data?.items.map((run) => (
        <Button
          variant="outline"
          key={run.id}
          className="h-auto py-3"
          onPress={() => router.push(`/${slug}/pipeline/${run.id}`)}
        >
          <View className="flex-1 gap-2">
            <Text>
              {run.issue_title} · {run.status}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {run.plan.kind} · {run.created_at}
            </Text>
          </View>
        </Button>
      ))}
      <View className="flex-row gap-3">
        <Button
          variant="outline"
          disabled={!offset}
          onPress={() => setOffset((o) => Math.max(0, o - 20))}
        >
          <Text>{t("pipeline.back")}</Text>
        </Button>
        <Button
          variant="outline"
          disabled={(runs.data?.items.length ?? 0) < 20}
          onPress={() => setOffset((o) => o + 20)}
        >
          <Text>{t("pipeline.more")}</Text>
        </Button>
      </View>
    </ScrollView>
  );
}
