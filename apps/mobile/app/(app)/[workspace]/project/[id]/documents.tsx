import { useEffect, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import {
  projectDocumentsOptions,
  useDocumentsRealtime,
} from "@/data/queries/pipelines";
import { useWorkspaceStore } from "@/data/workspace-store";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

export default function ProjectDocumentsRoute() {
  const { id, document: documentId } = useLocalSearchParams<{
    id: string;
    document?: string;
  }>();
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const slug = useWorkspaceStore((s) => s.currentWorkspaceSlug);
  const { t } = useT("issues");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const documents = useQuery(projectDocumentsOptions(wsId, id, query));
  useDocumentsRealtime(id);
  useEffect(() => {
    if (documentId)
      router.replace({
        pathname: `/${slug}/project/${id}/document`,
        params: { document: documentId },
      });
  }, [documentId, id, slug]);
  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ title: t("pipeline.documents") }} />
      <TextInput
        accessibilityLabel={t("pipeline.search")}
        placeholder={t("pipeline.search")}
        value={search}
        onChangeText={setSearch}
        className="m-4 rounded-lg border border-border p-3 text-base text-foreground"
      />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="p-4 gap-5"
      >
        {documents.error && (
          <View className="gap-3">
            <Text className="text-destructive">{documents.error.message}</Text>
            <Button variant="outline" onPress={() => void documents.refetch()}>
              <Text>{t("pipeline.refresh")}</Text>
            </Button>
          </View>
        )}
        {!documents.isLoading && !documents.data?.documents.length && (
          <Text>{t("pipeline.no_documents")}</Text>
        )}
        {documents.data?.groups.map((group) => (
          <View key={group.issue_id ?? "project"} className="gap-3">
            {group.issue_id ? (
              <Button
                className="h-auto justify-start"
                variant="ghost"
                onPress={() => router.push(`/${slug}/issue/${group.issue_id}`)}
              >
                <Text>
                  {group.identifier} · {group.title} ({group.count})
                </Text>
              </Button>
            ) : (
              <Text className="font-semibold">
                {t("pipeline.project_materials")} ({group.count})
              </Text>
            )}
            {group.documents.map((doc) => (
              <Button
                className="h-auto justify-start py-3"
                key={doc.id}
                variant="outline"
                onPress={() =>
                  router.push({
                    pathname: `/${slug}/project/${id}/document`,
                    params: { document: doc.id },
                  })
                }
              >
                <Text>
                  {doc.title} · v{doc.version}
                </Text>
              </Button>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
