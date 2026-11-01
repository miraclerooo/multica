import { newExecutionRequestKey } from "@multica/core/pipelines/execution";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/data/api";
import { useWorkspaceStore } from "@/data/workspace-store";
import { useNewIssueExecution, NewIssueExecution, MobileIssueExecution } from "@/components/pipeline/execution";
/**
 * New issue creation modal — manual only.
 *
 * Layout follows Apple Reminders / Linear iOS / Things 3: one vertical
 * scrolling form (title → description → property chips), no sticky bottom
 * toolbar. Property chips are part of the form, not pinned above keyboard.
 * MentionSuggestionBar floats above keyboard only when the user is mid-@.
 *
 * No markdown toolbar / upload buttons in v1: mobile users creating an
 * issue rarely format markdown, and attachment upload is deferred to a
 * later release (see plan-issue-majestic-rabin.md "skip uploads").
 *
 * Mention pipeline shares `useMentionInput` with `issue/[id]/new-comment.tsx`
 * — both surfaces produce canonical `[@name](mention://type/id)` markdown
 * recognised by util.ParseMentions on the server.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TextInput,
} from "react-native";
import { Stack, router } from "expo-router";
import { SubmitIssueButton } from "@/components/issue/submit-issue-button";
import { CreateFormAttributeRow } from "@/components/issue/create-form-attribute-row";
import { MentionSuggestionBar } from "@/components/issue/mention-suggestion-bar";
import { DescriptionField } from "@/components/issue/description-field";
import { MOBILE_PLACEHOLDER_COLOR } from "@/components/ui/input-tokens";
import { useCreateIssue } from "@/data/mutations/issues";
import { useNewIssueDraftStore } from "@/data/stores/new-issue-draft-store";
import { useMentionInput } from "@/lib/use-mention-input";
import { useT } from "@/lib/i18n";

export default function NewIssueModal() {
  const { t } = useT("issues");
  const [title, setTitle] = useState("");
  const description = useMentionInput();
  // Attribute chips (status / priority / assignee / due date / project)
  // live in `useNewIssueDraftStore` so the new-issue-picker/* formSheet
  // routes can read and write the same values without a parent-child
  // React relationship. The store is reset on mount + on unmount so
  // re-opening the new-issue modal starts clean.
  const status = useNewIssueDraftStore((s) => s.status);
  const priority = useNewIssueDraftStore((s) => s.priority);
  const assignee = useNewIssueDraftStore((s) => s.assignee);
  const dueDate = useNewIssueDraftStore((s) => s.dueDate);
  const project = useNewIssueDraftStore((s) => s.project);
  const resetDraft = useNewIssueDraftStore((s) => s.reset);

  useEffect(() => {
    resetDraft();
    return () => {
      resetDraft();
    };
  }, [resetDraft]);

  const createIssue = useCreateIssue();
  const execution = useNewIssueExecution();
  const slug = useWorkspaceStore(s => s.currentWorkspaceSlug);
  const [created, setCreated] = useState<{id: string; unconfirmed?: boolean; label?: string} | null>(null);
  const inFlight = useRef(false);
  const receipt = useRef({body: "", key: ""});
  const isSubmitting = createIssue.isPending;

  const canSubmit = !isSubmitting && execution.canSubmit && !created && title.trim().length > 0;

  const onSubmit = useCallback(async () => {
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0 || !execution.canSubmit || created || inFlight.current) return;
    inFlight.current = true;
    const finalDescription = description.serialize().trim();
    try {
      const body = {
        title: trimmedTitle,
        description: finalDescription || undefined,
        status,
        priority,
        ...(assignee
          ? { assignee_type: assignee.type, assignee_id: assignee.id }
          : {}),
        ...(dueDate ? { due_date: dueDate } : {}),
        ...(project ? { project_id: project.id } : {}),
        ...(execution.squadId && execution.frozen ? {execution: execution.frozen} : {}),
      };
      const fingerprint = JSON.stringify(body);
      if (receipt.current.body !== fingerprint) receipt.current = {body: fingerprint, key: newExecutionRequestKey()};
      const issue = await createIssue.mutateAsync({...body, ...(execution.squadId ? {idempotency_key: receipt.current.key} : {})});
      if (execution.squadId) setCreated({id: issue.id, label: `${issue.identifier} · ${issue.title}`}); else router.back();
    } catch (err) {
      if (err instanceof ApiError && err.body && typeof err.body === "object" && "issue_id" in err.body && typeof err.body.issue_id === "string") {
        setCreated({id: err.body.issue_id, unconfirmed: true});
        return;
      }
      Alert.alert(
        t("errors.create_failed"),
        err instanceof Error ? err.message : t("common:states.error"),
      );
    } finally { inFlight.current = false; }
  }, [
    execution, created, title,
    description,
    status,
    priority,
    assignee,
    dueDate,
    project,
    createIssue,
    t,
  ]);

  const headerRight = useCallback(
    () => (
      <SubmitIssueButton
        disabled={!canSubmit}
        loading={isSubmitting}
        onPress={onSubmit}
      />
    ),
    [canSubmit, isSubmitting, onSubmit],
  );

  if (created) return <ScrollView className="flex-1 bg-background" contentContainerClassName="p-4 gap-4">
    <Stack.Screen options={{title: t("execution.created"), headerRight: () => null}} />
    <Text className="text-lg font-semibold">{t("execution.created")}</Text>
    {created.label && <Text>{created.label}</Text>}
    {created.unconfirmed && <Text>{t("execution.unconfirmed")}</Text>}
    <MobileIssueExecution issueId={created.id} />
    <Button variant="outline" onPress={() => {router.back();router.push(`/${slug}/issue/${created.id}`);}}><Text>{t("execution.view_issue")}</Text></Button>
    <Button variant="ghost" onPress={() => router.back()}><Text>{t("execution.close")}</Text></Button>
  </ScrollView>;

  return (
    <>
      <Stack.Screen options={{ headerRight }} />
      <KeyboardAvoidingView
        className="flex-1 bg-background"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          className="flex-1"
          contentContainerClassName="px-4 pt-4 pb-6 gap-4"
          keyboardShouldPersistTaps="handled"
        >
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder={t("new.title_placeholder")}
            placeholderTextColor={MOBILE_PLACEHOLDER_COLOR}
            className="text-2xl font-semibold text-foreground py-2"
            autoFocus
            returnKeyType="next"
            editable={!isSubmitting}
          />
          <DescriptionField
            description={description}
            disabled={isSubmitting}
          />
          <CreateFormAttributeRow />
          <NewIssueExecution value={execution} />
        </ScrollView>

        {/* Mention suggestions float above the keyboard only when the user
            types `@`. Self-hides via `if (!visible) return null` so it
            doesn't take space at rest. */}
        <MentionSuggestionBar {...description.suggestionBar} />
      </KeyboardAvoidingView>
    </>
  );
}
