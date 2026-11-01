import { Linking, ScrollView, View } from "react-native";
import { Image } from "expo-image";
import { Stack, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/data/api";
import { useWorkspaceStore } from "@/data/workspace-store";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/lib/markdown";
import { publishedMaterialPath } from "@/lib/published-material";
import MaterialPreview from "@/components/pipeline/material-preview";
import { useT } from "@/lib/i18n";

export default function PipelineMaterialRoute() {
  const { path, title, pin } = useLocalSearchParams<{
    path: string;
    title?: string;
    pin?: string;
  }>();
  const slug = useWorkspaceStore((s) => s.currentWorkspaceSlug);
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const { t } = useT("issues");
  const safePath = publishedMaterialPath(
    path ?? "",
    process.env.EXPO_PUBLIC_API_URL ?? "",
  );
  const query = useQuery({
    queryKey: ["published-material", wsId, safePath],
    queryFn: ({ signal }) =>
      api.getPublishedMaterial(safePath!, { signal }, title ?? ""),
    enabled: !!wsId && !!safePath,
    staleTime: 0,
  });
  const data = query.data;
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="p-4 gap-4"
    >
      <Stack.Screen options={{ title: title || t("pipeline.artifacts") }} />
      <Text className="text-xs text-muted-foreground">
        {t("pipeline.pinned")} · {pin}
      </Text>
      {!safePath || query.error ? (
        <View className="gap-3">
          <Text className="text-destructive">
            {query.error?.message ?? t("pipeline.unavailable")}
          </Text>
          <Button variant="outline" onPress={() => void query.refetch()}>
            <Text>{t("pipeline.refresh")}</Text>
          </Button>
        </View>
      ) : query.isLoading ? (
        <Text>{t("pipeline.loading")}</Text>
      ) : (
        data && (
          <>
            {data.contentType.startsWith("image/") ? (
              <Image
                source={{ uri: data.dataUri }}
                style={{ width: "100%", height: 360 }}
                contentFit="contain"
                accessibilityLabel={title}
              />
            ) : data.contentType.includes("html") ||
              data.contentType.includes("pdf") ? (
              <MaterialPreview
                title={title ?? ""}
                html={data.contentType.includes("html") ? data.text : ""}
                dataUri={data.dataUri}
                dom={{ scrollEnabled: false, style: { height: 480 } }}
              />
            ) : data.text ||
              data.contentType.startsWith("text/") ||
              data.contentType.includes("json") ? (
              <Markdown content={data.text} />
            ) : (
              <View className="gap-3">
                <Text>{t("pipeline.preview_unavailable")}</Text>
                {process.env.EXPO_PUBLIC_WEB_URL && (
                  <Button
                    variant="outline"
                    onPress={() => {
                      const runId = safePath?.match(
                        /^\/api\/pipeline-runs\/([^/]+)\//,
                      )?.[1];
                      const attachmentId = safePath?.match(
                        /^\/api\/attachments\/([^/]+)\//,
                      )?.[1];
                      const destination = runId
                        ? `/${slug}/pipelines/${runId}`
                        : attachmentId
                          ? `/${slug}/attachments/${attachmentId}/preview`
                          : `/${slug}/projects`;
                      void Linking.openURL(
                        `${process.env.EXPO_PUBLIC_WEB_URL}${destination}`,
                      );
                    }}
                  >
                    <Text>{t("pipeline.open_web")}</Text>
                  </Button>
                )}
              </View>
            )}
          </>
        )
      )}
    </ScrollView>
  );
}
