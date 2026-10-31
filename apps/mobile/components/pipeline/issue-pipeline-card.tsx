import { View } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/data/workspace-store";
import {
  pipelineRunsOptions,
  usePipelineRealtime,
} from "@/data/queries/pipelines";
import { useT } from "@/lib/i18n";

export function IssuePipelineCard({ issueId }: { issueId: string }) {
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const slug = useWorkspaceStore((s) => s.currentWorkspaceSlug);
  const { t } = useT("issues");
  const runs = useQuery(pipelineRunsOptions(wsId, issueId));
  usePipelineRealtime(issueId);
  if (!runs.data?.items.length && !runs.error) return null;
  return (
    <View className="mx-4 my-2 gap-2 rounded-lg border border-border p-3">
      <Text className="font-semibold">{t("pipeline.title")}</Text>
      {runs.error && (
        <Text className="text-destructive">{t("pipeline.failed")}</Text>
      )}
      {runs.data?.items.slice(0, 2).map((run) => (
        <Button
          key={run.id}
          variant="outline"
          onPress={() => router.push(`/${slug}/pipeline/${run.id}`)}
        >
          <Text numberOfLines={2}>
            {run.plan.kind} · {run.status}
          </Text>
        </Button>
      ))}
      <Button
        variant="ghost"
        onPress={() => router.push(`/${slug}/issue/${issueId}/pipelines`)}
      >
        <Text>{t("pipeline.runs")}</Text>
      </Button>
    </View>
  );
}
