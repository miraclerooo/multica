import { useEffect, useRef, useState } from "react";
import {
  Alert,
  ScrollView,
  View,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import {
  Stack,
  router,
  useLocalSearchParams,
  useNavigation,
} from "expo-router";
import { useQuery } from "@tanstack/react-query";
import type {
  PipelineArtifact,
  PipelineJob,
  PipelineRun,
} from "@multica/core/pipelines/schema";
import {
  pipelineDependencies,
  pipelineUsage,
} from "@multica/core/pipelines/utils";
import {
  pipelineRunOptions,
  pipelineArtifactsOptions,
  usePipelineDecision,
  usePipelineRealtime,
} from "@/data/queries/pipelines";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useAuthStore } from "@/data/auth-store";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import { useActorLookup } from "@/data/use-actor-name";
import { createRequestId } from "@/lib/request-id";
import { Markdown } from "@/lib/markdown";

export default function PipelineRunRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const { t } = useT("issues");
  const run = useQuery(pipelineRunOptions(wsId, id));
  usePipelineRealtime(undefined, id);
  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ title: t("pipeline.title") }} />
      {run.error || (!run.isLoading && !run.data) ? (
        <View className="p-4 gap-3">
          <Text className="text-destructive">
            {run.error?.message ?? t("pipeline.failed")}
          </Text>
          <Button onPress={() => void run.refetch()}>
            <Text>{t("pipeline.refresh")}</Text>
          </Button>
        </View>
      ) : run.data ? (
        <RunDetails run={run.data} />
      ) : (
        <Text>{t("pipeline.loading")}</Text>
      )}
    </View>
  );
}

function RunDetails({ run }: { run: PipelineRun }) {
  const { t } = useT("issues");
  const navigation = useNavigation();
  const wsId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const user = useAuthStore((s) => s.user);
  const { getName } = useActorLookup();
  const [selected, setSelected] = useState(
    run.jobs.find((j) => j.status === "waiting_approval")?.node.id ??
      run.jobs[0]?.node.id ??
      "",
  );
  const job = run.jobs.find((j) => j.node.id === selected);
  const [reason, setReason] = useState("");
  const [reviewed, setReviewed] = useState(job?.revision);
  const [attemptNumber, setAttemptNumber] = useState<number | null>(null);
  const attempt =
    job?.attempts.find((a) => a.number === attemptNumber) ??
    job?.attempts.at(-1);
  const decision = usePipelineDecision(wsId, run.id, selected);
  const operation = useRef({ body: "", key: "" });
  const [offset, setOffset] = useState(0);
  const artifacts = useQuery(pipelineArtifactsOptions(wsId, run.id, offset));
  const materials =
    job?.decision?.materials ??
    job?.node.artifact_sources.flatMap(
      (id) =>
        run.jobs.find((j) => j.node.id === id)?.attempts.at(-1)?.report
          ?.artifacts ?? [],
    ) ??
    [];
  const ready =
    !!user &&
    job?.status === "waiting_approval" &&
    job.revision === reviewed &&
    materials.every((a) => a.status === "accessible") &&
    !["cancelled", "cancelling", "rejected"].includes(run.status);
  useEffect(
    () =>
      navigation.addListener("beforeRemove", (event) => {
        if (!reason.trim() || decision.isSuccess) return;
        event.preventDefault();
        Alert.alert(t("pipeline.dirty"), t("pipeline.discard_review"), [
          { text: t("pipeline.cancel"), style: "cancel" },
          {
            text: t("pipeline.close"),
            style: "destructive",
            onPress: () => navigation.dispatch(event.data.action),
          },
        ]);
      }),
    [navigation, reason, decision.isSuccess, t],
  );
  const choose = (next: PipelineJob) => {
    const apply = () => {
      setSelected(next.node.id);
      setReviewed(next.revision);
      setReason("");
      setAttemptNumber(null);
      decision.reset();
    };
    if (reason.trim())
      Alert.alert(t("pipeline.dirty"), t("pipeline.discard_review"), [
        { text: t("pipeline.cancel"), style: "cancel" },
        { text: t("pipeline.close"), onPress: apply },
      ]);
    else apply();
  };
  const submit = async (value: "approve" | "reject") => {
    if (
      !ready ||
      decision.isPending ||
      !job ||
      (value === "reject" && !reason.trim())
    )
      return;
    const body = JSON.stringify({ value, reason, revision: reviewed });
    if (operation.current.body !== body)
      operation.current = { body, key: createRequestId() };
    try {
      await decision.mutateAsync({
        decision: value,
        reason,
        expected_revision: reviewed!,
        idempotency_key: operation.current.key,
      });
      setReason("");
    } catch {
      /* Retain the review comment and reviewed revision. */
    }
  };
  const usage = pipelineUsage(run);
  return (
    <KeyboardAvoidingView
      className="flex-1"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        className="flex-1"
        contentContainerClassName="p-4 gap-4 pb-12"
      >
        <Text className="text-lg font-semibold">{run.issue_title}</Text>
        <Text>
          {run.status} · {run.reason}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {run.plan.kind} · {t("pipeline.tokens")} {usage.tokens} ·{" "}
          {usage.unpriced
            ? t("pipeline.unpriced")
            : `$${(usage.ticks / 10_000_000_000).toFixed(4)}`}
        </Text>
        <Text selectable className="text-xs text-muted-foreground">
          {run.definition_id} · {run.plan.source_hash}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {t("pipeline.edit_desktop")}
        </Text>
        {run.jobs.map((j) => (
          <Button
            variant={selected === j.node.id ? "secondary" : "outline"}
            key={j.node.id}
            className="h-auto py-3 justify-start"
            onPress={() => choose(j)}
            accessibilityState={{ selected: selected === j.node.id }}
          >
            <View className="min-w-0 flex-1">
              <Text>
                {j.node.title || j.node.id} · {j.status}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {j.node.role || t("pipeline.leader")} · {j.reason}
              </Text>
            </View>
          </Button>
        ))}
        {job && (
          <View className="gap-3 rounded-lg border border-border p-3">
            <Text className="font-semibold">
              {job.node.title || job.node.id}
            </Text>
            <Text>
              {t("pipeline.executor")}:{" "}
              {job.node.type === "manual"
                ? job.decision
                  ? getName("member", job.decision.actor_id)
                  : t("pipeline.manual")
                : getName("agent", attempt?.executor_id ?? job.executor_id)}
            </Text>
            <Text className="text-xs text-muted-foreground">
              {t("pipeline.dependencies")}:{" "}
              {pipelineDependencies(job.node)
                .map(
                  (id) =>
                    `${id} (${run.jobs.find((j) => j.node.id === id)?.status})`,
                )
                .join(", ")}
            </Text>
            {job.node.instructions && (
              <Markdown content={job.node.instructions} />
            )}
            {job.attempts.map((a) => (
              <Button
                key={a.number}
                variant="ghost"
                onPress={() => setAttemptNumber(a.number)}
              >
                <Text>
                  {t("pipeline.attempt")} {a.number} · {a.status}
                </Text>
              </Button>
            ))}
            {attempt && (
              <>
                <Text className="text-xs text-muted-foreground">
                  {attempt.started_at} → {attempt.completed_at ?? "—"}
                </Text>
                <Button
                  variant="outline"
                  onPress={() =>
                    router.push(
                      `/${useWorkspaceStore.getState().currentWorkspaceSlug}/issue/${run.issue_id}/run/${attempt.task_id}`,
                    )
                  }
                >
                  <Text>{t("pipeline.logs")}</Text>
                </Button>
                {attempt.report && <Markdown content={attempt.report.report} />}
                {attempt.inputs.map((a) => (
                  <Material key={a.id} artifact={a} runId={run.id} />
                ))}
              </>
            )}
            {materials.map((a) => (
              <Material
                key={`${a.job_id}:${a.attempt}:${a.id}`}
                artifact={a}
                runId={run.id}
              />
            ))}
            {job.node.type === "manual" &&
              (job.decision ? (
                <View className="gap-2">
                  <Text>
                    {t("pipeline.decision")}: {job.decision.decision} ·{" "}
                    {getName("member", job.decision.actor_id)}
                  </Text>
                  <Text>{job.decision.created_at}</Text>
                  <Text>{job.decision.reason}</Text>
                  {reason && (
                    <>
                      <Text>{t("pipeline.kept")}</Text>
                      <Text selectable>{reason}</Text>
                    </>
                  )}
                </View>
              ) : (
                <>
                  {job.status !== "waiting_approval" && (
                    <Text className="text-muted-foreground">
                      {t("pipeline.waiting")}
                    </Text>
                  )}
                  {!user && (
                    <Text className="text-destructive">
                      {t("pipeline.permission")}
                    </Text>
                  )}
                  {reviewed !== job.revision && (
                    <>
                      <Text className="text-destructive">
                        {t("pipeline.decision_conflict")}
                      </Text>
                      <Button
                        variant="outline"
                        onPress={() => setReviewed(job.revision)}
                      >
                        <Text>{t("pipeline.review_latest")}</Text>
                      </Button>
                    </>
                  )}
                  <Text>{t("pipeline.reason")}</Text>
                  <TextInput
                    accessibilityLabel={t("pipeline.reason")}
                    multiline
                    value={reason}
                    onChangeText={setReason}
                    editable={!!user && !decision.isPending}
                    className="min-h-28 rounded-lg border border-border p-3 text-base text-foreground"
                    style={{ textAlignVertical: "top" }}
                  />
                  {!reason.trim() && (
                    <Text className="text-xs text-muted-foreground">
                      {t("pipeline.reason_required")}
                    </Text>
                  )}
                  <View className="flex-row gap-3">
                    <Button
                      className="flex-1"
                      disabled={!ready || decision.isPending}
                      onPress={() => void submit("approve")}
                    >
                      <Text>{t("pipeline.approve")}</Text>
                    </Button>
                    <Button
                      className="flex-1"
                      variant="outline"
                      disabled={!ready || !reason.trim() || decision.isPending}
                      onPress={() => void submit("reject")}
                    >
                      <Text>{t("pipeline.reject")}</Text>
                    </Button>
                  </View>
                  {decision.error && (
                    <Text
                      accessibilityRole="alert"
                      className="text-destructive"
                    >
                      {decision.error.message}
                    </Text>
                  )}
                </>
              ))}
          </View>
        )}
        <Text className="font-semibold">{t("pipeline.artifacts")}</Text>
        {artifacts.error && (
          <Text className="text-destructive">{artifacts.error.message}</Text>
        )}
        {artifacts.data?.items.map((a) => (
          <Material key={a.id} artifact={a} runId={run.id} />
        ))}
        <View className="flex-row gap-3">
          <Button
            variant="outline"
            disabled={!offset}
            onPress={() => setOffset((o) => Math.max(0, o - 50))}
          >
            <Text>{t("pipeline.back")}</Text>
          </Button>
          <Button
            variant="outline"
            disabled={(artifacts.data?.items.length ?? 0) < 50}
            onPress={() => setOffset((o) => o + 50)}
          >
            <Text>{t("pipeline.more")}</Text>
          </Button>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Material({
  artifact: a,
  runId,
}: {
  artifact: PipelineArtifact;
  runId: string;
}) {
  const slug = useWorkspaceStore((s) => s.currentWorkspaceSlug);
  const { t } = useT("issues");
  return (
    <View className="gap-2 rounded-lg bg-muted p-3">
      <Text>{a.path}</Text>
      <Text selectable className="text-xs text-muted-foreground">
        {a.job_id} · {t("pipeline.attempt")} {a.attempt} · {a.status} ·{" "}
        {a.sha || a.attachment_id || `v${a.document_version ?? "—"}`}
      </Text>
      {a.status === "accessible" ? (
        <Button
          variant="outline"
          onPress={() =>
            router.push({
              pathname: `/${slug}/pipeline/material`,
              params: {
                path: `/api/pipeline-runs/${encodeURIComponent(runId)}/artifact-content?artifact_id=${encodeURIComponent(a.id)}`,
                title: a.path,
                pin: a.sha || a.attachment_id || `v${a.document_version}`,
              },
            })
          }
        >
          <Text>{t("pipeline.open")}</Text>
        </Button>
      ) : (
        <Text className="text-destructive">
          {a.reason ||
            (a.status === "declared"
              ? t("pipeline.declared")
              : t("pipeline.unavailable"))}
        </Text>
      )}
    </View>
  );
}
