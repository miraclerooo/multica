import { ScrollView, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import {
  projectDocumentOptions,
  useDocumentsRealtime,
} from "@/data/queries/pipelines";
import { useWorkspaceStore } from "@/data/workspace-store";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/lib/markdown";
import { useT } from "@/lib/i18n";

export default function ProjectDocumentRoute() {
  const {
    id,
    document: documentId,
    version,
  } = useLocalSearchParams<{
    id: string;
    document: string;
    version?: string;
  }>();
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const { t } = useT("issues");
  const document = useQuery(
    projectDocumentOptions(
      wsId,
      id,
      documentId,
      version ? Number(version) : undefined,
    ),
  );
  useDocumentsRealtime(id);
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="p-4 gap-4"
    >
      <Stack.Screen
        options={{ title: document.data?.title ?? t("pipeline.documents") }}
      />
      {document.error || (!document.isLoading && !document.data) ? (
        <View className="gap-3">
          <Text className="text-destructive">
            {document.error?.message ?? t("pipeline.unavailable")}
          </Text>
          <Button onPress={() => void document.refetch()}>
            <Text>{t("pipeline.refresh")}</Text>
          </Button>
        </View>
      ) : document.data ? (
        <>
          <Text className="text-xl font-semibold">{document.data.title}</Text>
          <Text className="text-xs text-muted-foreground">
            {version ? t("pipeline.pinned") : t("pipeline.version")} v
            {document.data.version} · {document.data.author_name}
          </Text>
          <Markdown content={document.data.body} />
        </>
      ) : (
        <Text>{t("pipeline.loading")}</Text>
      )}
    </ScrollView>
  );
}
