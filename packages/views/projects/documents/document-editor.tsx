"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIsMutating, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  documentDetailOptions,
  documentDraftKey,
  documentHistoryOptions,
  documentKeys,
  documentStructure,
  editDocumentDraft,
  insertDocumentBlock,
  putDocumentDraft,
  useCreateDocument,
  useDocumentDraftStore,
  useSaveDocument,
  type DocumentDraft,
  type ProjectDocument,
} from "@multica/core/documents";
import type { Project } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Sheet, SheetContent } from "@multica/ui/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@multica/ui/components/ui/alert-dialog";
import {
  BookOpen,
  Check,
  Code2,
  Columns2,
  Copy,
  FileText,
  History,
  ListChecks,
  PanelRight,
  Plus,
  Save,
  TriangleAlert,
  Users,
} from "@multica/ui/icons";
import { copyText } from "@multica/ui/lib/clipboard";
import { cn } from "@multica/ui/lib/utils";
import { toast } from "sonner";
import {
  ContentEditor,
  ReadonlyContent,
  type ContentEditorRef,
} from "../../editor";
import { useLocale, useT } from "../../i18n";
import { useNavigation } from "../../navigation";
import { RevisionDiff, type DocumentComparison } from "./revision-diff";

export function DocumentEditor({
  wsId,
  project,
  documentId,
  onOpenDocument,
}: {
  wsId: string;
  project: Project;
  documentId: string;
  onOpenDocument: (id: string) => void;
}) {
  const { t } = useT("projects");
  const locale = useLocale();
  const router = useNavigation();
  const paths = useWorkspacePaths();
  const qc = useQueryClient();
  const query = useQuery(documentDetailOptions(wsId, project.id, documentId));
  const history = useQuery(
    documentHistoryOptions(wsId, project.id, documentId),
  );
  const doc = query.data;
  const key = documentDraftKey(wsId, project.id, documentId);
  const draft = useDocumentDraftStore((s) => s.draft.drafts[key]);
  const save = useSaveDocument(wsId, project.id, documentId);
  const create = useCreateDocument(wsId, project.id);
  const pendingSaves = useIsMutating({
    mutationKey: ["save-project-document", wsId, project.id, documentId],
  });
  const [mode, setMode] = useState<"read" | "split" | "source">("read");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [comparison, setComparison] = useState<DocumentComparison | null>(null);
  const [confirmation, setConfirmation] = useState<{
    action: "discard" | "save-local";
    open: boolean;
  }>({ action: "discard", open: false });
  const richRef = useRef<ContentEditorRef>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const busy = pendingSaves > 0 || create.isPending || checking;
  const body = draft?.body ?? doc?.body ?? "";
  const title = draft?.title ?? doc?.title ?? "";
  const structure = useMemo(() => documentStructure(body), [body]);
  const revisions = history.data ?? [];
  const conflicted =
    !!draft &&
    (draft.status === "conflict" || (doc?.version ?? 0) > draft.base.version);

  const edit = useCallback(
    (patch: Partial<Pick<DocumentDraft, "title" | "body">>) => {
      if (!doc) return;
      editDocumentDraft(
        key,
        { title: doc.title, body: doc.body, version: doc.version },
        patch,
      );
    },
    [doc, key],
  );
  const flush = useCallback(() => {
    const pending = richRef.current?.flushPendingUpdate();
    if (pending != null) edit({ body: pending });
  }, [edit]);
  const saveDraft = useCallback(
    async (baseVersion?: number, snapshot?: DocumentDraft) => {
      flush();
      const local =
        snapshot ?? useDocumentDraftStore.getState().draft.drafts[key];
      if (!local || busy) return;
      try {
        await save.mutateAsync({ key, draft: local, baseVersion });
        setComparison(null);
        setConfirmation((state) => ({ ...state, open: false }));
      } catch {
        setConfirmation((state) => ({ ...state, open: false }));
        const latest = qc.getQueryData<ProjectDocument>(
          documentKeys.detail(wsId, project.id, documentId),
        );
        if (latest && latest.version > (baseVersion ?? local.base.version)) {
          const current =
            useDocumentDraftStore.getState().draft.drafts[key] ?? local;
          setComparison({
            kind: "conflict",
            left: {
              title: current.title,
              body: current.body,
              version: current.base.version,
            },
            right: latest,
            draft: current,
            base: current.base,
          });
        }
      }
    },
    [flush, key, busy, save, qc, wsId, project.id, documentId],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (
          event.target instanceof HTMLElement &&
          event.target.closest('[role="dialog"], [role="alertdialog"]')
        )
          return;
        if (!conflicted && !comparison && !confirmation.open) void saveDraft();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveDraft, conflicted, comparison, confirmation]);
  useEffect(() => {
    if (!draft) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft]);

  const scrollToRequirement = useCallback(
    (id: string) => {
      const item = structure.requirements.find(
        (req) => req.id.toLowerCase() === id.toLowerCase(),
      );
      if (!item) return;
      if (mode === "source" && sourceRef.current) {
        const position =
          body.split("\n").slice(0, item.line).join("\n").length +
          (item.line ? 1 : 0);
        sourceRef.current.focus();
        sourceRef.current.setSelectionRange(position, position);
        sourceRef.current.scrollTop = item.line * 24;
      } else {
        const heading = Array.from(
          canvasRef.current?.querySelectorAll("h1,h2,h3,h4,h5,h6") ?? [],
        ).find((node) => node.textContent?.includes(item.id));
        heading?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    },
    [structure, mode, body],
  );
  useEffect(() => {
    const id = decodeURIComponent(router.hash.slice(1));
    if (id) scrollToRequirement(id);
  }, [router.hash, scrollToRequirement]);

  if (query.isLoading)
    return (
      <div
        className="flex flex-1 items-center justify-center text-muted-foreground"
        aria-busy="true"
      >
        …
      </div>
    );
  if (!doc || query.isError)
    return (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-3"
        role="alert"
      >
        <p className="text-body text-muted-foreground">
          {t(($) => $.documents.load_failed)}
        </p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          {t(($) => $.documents.retry)}
        </Button>
      </div>
    );

  const openComparison = async (revision?: ProjectDocument) => {
    flush();
    setChecking(true);
    try {
      const latest = await qc.fetchQuery({
        ...documentDetailOptions(wsId, project.id, documentId),
        staleTime: 0,
      });
      const local = useDocumentDraftStore.getState().draft.drafts[key];
      if (local && !revision)
        setComparison({
          kind: "conflict",
          left: {
            title: local.title,
            body: local.body,
            version: local.base.version,
          },
          right: latest,
          draft: local,
          base: local.base,
        });
      else
        setComparison({
          kind: "history",
          left: revision ?? revisions[1] ?? latest,
          right: latest,
        });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t(($) => $.documents.load_failed),
      );
    } finally {
      setChecking(false);
    }
  };
  const discard = async () => {
    setChecking(true);
    try {
      const latest = await qc.fetchQuery({
        ...documentDetailOptions(wsId, project.id, documentId),
        staleTime: 0,
      });
      putDocumentDraft(key, undefined);
      richRef.current?.adoptContent(latest.body);
      setComparison(null);
      setConfirmation((state) => ({ ...state, open: false }));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t(($) => $.documents.load_failed),
      );
    } finally {
      setChecking(false);
    }
  };
  const copyLocal = async () => {
    const local = comparison?.draft;
    if (!local || busy) return;
    try {
      const copyTitle = `${local.title}${t(($) => $.documents.local_copy_suffix)}`;
      const copy = await create.mutateAsync({
        title: Array.from(copyTitle).length <= 300 ? copyTitle : local.title,
        body: local.body,
        kind: doc.kind,
      });
      const current = useDocumentDraftStore.getState().draft.drafts[key];
      if (current?.title === local.title && current.body === local.body)
        putDocumentDraft(key, undefined);
      setComparison(null);
      onOpenDocument(copy.id);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t(($) => $.documents.failed),
      );
    }
  };
  const insert = (kind: "requirement" | "scenario" | "task") => {
    flush();
    const currentBody =
      useDocumentDraftStore.getState().draft.drafts[key]?.body ?? doc.body;
    const next = insertDocumentBlock(currentBody, kind);
    richRef.current?.adoptContent(next);
    edit({ body: next });
  };
  const status = busy
    ? t(($) => $.documents.saving)
    : conflicted
      ? t(($) => $.documents.conflict)
      : draft?.status === "failed"
        ? t(($) => $.documents.failed)
        : draft
          ? t(($) => $.documents.dirty)
          : t(($) => $.documents.saved, { version: doc.version });
  const recent = revisions
    .filter(
      (r, index, all) =>
        all.findIndex(
          (other) =>
            other.author_type === r.author_type &&
            other.author_id === r.author_id,
        ) === index,
    )
    .slice(0, 6);
  const sidebar = (
    <div className="p-4 space-y-5 text-caption">
      <section className="document-info-card">
        <h2>{t(($) => $.documents.details)}</h2>
        <dl className="space-y-3">
          <div className="flex justify-between gap-3">
            <dt>{t(($) => $.documents.kind)}</dt>
            <dd>
              {doc.kind === "spec"
                ? t(($) => $.documents.spec)
                : t(($) => $.documents.document)}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>{t(($) => $.documents.version)}</dt>
            <dd className="font-mono">{`v${doc.version}`}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>{t(($) => $.documents.author)}</dt>
            <dd className="text-right break-words">{doc.author_name}</dd>
          </div>
        </dl>
      </section>
      <section className="document-info-card">
        <h2>
          <Users className="size-4 text-brand" />
          {t(($) => $.documents.editors)}
        </h2>
        <div className="space-y-2">
          {recent.map((r) => (
            <div
              key={`${r.author_type}:${r.author_id}`}
              className="flex items-center gap-2 rounded-md bg-muted/50 p-2"
            >
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full text-caption font-semibold",
                  r.author_type === "agent"
                    ? "bg-brand/10 text-brand"
                    : "bg-muted text-foreground",
                )}
              >
                {r.author_name.slice(0, 1).toUpperCase()}
              </span>
              <span className="truncate flex-1">{r.author_name}</span>
              <span className="text-micro text-muted-foreground">
                {r.author_type === "agent"
                  ? t(($) => $.documents.agent)
                  : t(($) => $.documents.member)}
              </span>
            </div>
          ))}
        </div>
      </section>
      <section className="document-info-card">
        <h2>{t(($) => $.documents.resource)}</h2>
        <p className="mb-3 text-muted-foreground leading-relaxed">
          {t(($) => $.documents.resource_hint)}
        </p>
        <code className="block break-all rounded-md border bg-muted/50 p-2 text-micro text-brand">
          {doc.resource_uri}
        </code>
        <Button
          size="xs"
          variant="ghost"
          className="mt-2"
          onClick={() => {
            void copyText(doc.resource_uri).then((ok) => {
              if (ok) toast.success(t(($) => $.documents.copied));
            });
          }}
        >
          <Copy />
          {t(($) => $.documents.copy_reference)}
        </Button>
      </section>
      <section className="document-info-card">
        <h2>
          <History className="size-4" />
          {t(($) => $.documents.history)}
        </h2>
        {history.isError ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void history.refetch()}
          >
            {t(($) => $.documents.retry)}
          </Button>
        ) : (
          <div className="space-y-2">
            {revisions.map((r) => (
              <button
                key={r.version}
                type="button"
                disabled={busy}
                onClick={() => void openComparison(r)}
                className="block w-full rounded-md border bg-muted/20 p-3 text-left hover:bg-accent"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono font-semibold text-brand">{`v${r.version}`}</span>
                  <span className="truncate">{r.author_name}</span>
                </div>
                <p className="mt-1 truncate text-muted-foreground">{r.title}</p>
                <div className="mt-2 flex items-center justify-between gap-2 text-micro text-muted-foreground">
                  <span>
                    {t(($) => $.documents.based_on, {
                      version: r.base_version,
                    })}
                  </span>
                  <time dateTime={r.updated_at}>
                    {new Date(r.updated_at).toLocaleString(locale, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="document-editor-main flex min-w-0 flex-1 flex-col">
        <div className="document-toolbar">
          <div
            className="flex items-center gap-0.5 rounded-lg border bg-muted/40 p-0.5"
            aria-label={t(($) => $.documents.tab)}
          >
            {(["read", "split", "source"] as const).map((item) => (
              <Button
                key={item}
                size="xs"
                variant={mode === item ? "secondary" : "ghost"}
                aria-pressed={mode === item}
                onClick={() => {
                  flush();
                  setMode(item);
                }}
              >
                {item === "read" ? (
                  <BookOpen />
                ) : item === "split" ? (
                  <Columns2 />
                ) : (
                  <Code2 />
                )}
                {item === "read"
                  ? t(($) => $.documents.read)
                  : item === "split"
                    ? t(($) => $.documents.split)
                    : t(($) => $.documents.source)}
              </Button>
            ))}
          </div>
          <div className="document-inserts flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => insert("requirement")}
            >
              <Plus />
              {t(($) => $.documents.requirement)}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => insert("scenario")}
            >
              <Plus />
              {t(($) => $.documents.scenario)}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => insert("task")}>
              <Plus />
              {t(($) => $.documents.criterion)}
            </Button>
          </div>
          <div className="document-save-actions ml-auto flex items-center gap-2">
            <span
              role="status"
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap text-caption text-muted-foreground",
              )}
              data-testid="document-save-status"
            >
              {!draft && !busy && <Check className="size-3.5" />}
              {draft && (
                <span
                  aria-hidden="true"
                  className="size-1.5 rounded-full bg-warning"
                />
              )}
              {status}
            </span>
            {draft && (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  flush();
                  setConfirmation({ action: "discard", open: true });
                }}
              >
                {t(($) => $.documents.discard)}
              </Button>
            )}
            <Button
              size="sm"
              disabled={!draft || busy || !title.trim()}
              aria-busy={busy}
              onClick={() => {
                if (conflicted) void openComparison();
                else void saveDraft();
              }}
            >
              <Save />
              {draft?.status === "failed"
                ? t(($) => $.documents.retry)
                : t(($) => $.documents.save)}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t(($) => $.documents.details)}
              className="xl:hidden"
              onClick={() => setDetailsOpen(true)}
            >
              <PanelRight />
            </Button>
          </div>
        </div>
        {(conflicted || draft?.status === "failed") && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 border-b border-warning/30 bg-warning/10 px-5 py-2 text-caption"
          >
            <span className="flex items-center gap-2">
              <TriangleAlert className="size-4 shrink-0" />
              {conflicted ? (
                t(($) => $.documents.newer_hint)
              ) : (
                <span>
                  {t(($) => $.documents.save_error)} {draft?.error}
                </span>
              )}
            </span>
            {conflicted && (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void openComparison()}
              >
                {t(($) => $.documents.compare_first)}
              </Button>
            )}
          </div>
        )}
        <div className="document-canvas-scroll" ref={canvasRef}>
          <div className="document-heading">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-caption">
                <span className="rounded-md border bg-muted px-2 py-1 font-mono font-semibold">
                  {doc.kind === "spec" ? "SPEC" : "DOC"}
                </span>
                <span className="rounded-md border border-brand/20 bg-brand/5 px-2 py-1 font-mono text-brand">
                  {t(($) => $.documents.version)} {`v${doc.version}`}
                </span>
              </div>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                onClick={() => void openComparison()}
              >
                <History />
                {t(($) => $.documents.compare)}
              </Button>
            </div>
            <input
              className="document-title"
              aria-label={t(($) => $.documents.title)}
              value={title}
              maxLength={300}
              onChange={(e) => edit({ title: e.target.value })}
            />
            <p className="flex items-center gap-2 text-caption text-muted-foreground">
              <span>{t(($) => $.documents.author)}</span>
              <span className="font-medium">{doc.author_name}</span>
              <span>
                ·{" "}
                {doc.author_type === "agent"
                  ? t(($) => $.documents.agent)
                  : t(($) => $.documents.member)}
              </span>
            </p>
            {doc.kind === "spec" && (
              <div className="document-stats">
                <div>
                  <span>{t(($) => $.documents.requirements)}</span>
                  <strong>
                    <BookOpen className="size-4 text-brand" />
                    {structure.requirements.length}
                  </strong>
                </div>
                <div>
                  <span>{t(($) => $.documents.scenarios)}</span>
                  <strong>
                    <FileText className="size-4 text-warning" />
                    {structure.scenarios}
                  </strong>
                </div>
                <div>
                  <span>{t(($) => $.documents.acceptance)}</span>
                  <strong className="text-success">
                    <ListChecks className="size-4" />
                    {
                      structure.tasks.filter((task) => task.checked).length
                    } / {structure.tasks.length}
                  </strong>
                </div>
              </div>
            )}
            {structure.requirements.length > 0 && (
              <nav
                className="flex flex-wrap gap-2 mt-5"
                aria-label={t(($) => $.documents.outline)}
              >
                {structure.requirements.map((req, index) => (
                  <button
                    key={`${req.id}:${index}`}
                    type="button"
                    onClick={() => {
                      scrollToRequirement(req.id);
                      router.replace(
                        `${paths.projectDetail(project.id)}?view=docs&document=${documentId}#${encodeURIComponent(req.id)}`,
                      );
                    }}
                    className="rounded-sm border border-brand/15 bg-brand/5 px-2 py-1 font-mono text-micro text-brand hover:bg-brand/10"
                  >
                    {req.id}
                  </button>
                ))}
              </nav>
            )}
          </div>
          <div
            className={cn(
              "document-body",
              mode === "split" && "document-split",
            )}
          >
            {mode === "read" ? (
              <ContentEditor
                key={`${documentId}:${draft?.base.version ?? doc.version}`}
                ref={richRef}
                value={body}
                onUpdate={(markdown) => edit({ body: markdown })}
                debounceMs={0}
                flushPendingOnUnmount
                disableMentions
                className="document-rich-editor"
                onReady={() => {
                  if (router.hash)
                    scrollToRequirement(
                      decodeURIComponent(router.hash.slice(1)),
                    );
                }}
              />
            ) : (
              <textarea
                ref={sourceRef}
                aria-label={t(($) => $.documents.body)}
                value={body}
                onChange={(e) => edit({ body: e.target.value })}
                spellCheck={false}
                className="document-source"
              />
            )}
            {mode === "split" && (
              <div className="document-preview">
                <ReadonlyContent content={body} />
              </div>
            )}
          </div>
        </div>
      </div>
      <aside className="document-inspector hidden xl:block border-l bg-muted/15 overflow-y-auto">
        {sidebar}
      </aside>
      <Sheet open={detailsOpen} onOpenChange={setDetailsOpen}>
        <SheetContent
          side="right"
          className="p-0 w-80 overflow-y-auto"
          aria-label={t(($) => $.documents.details)}
        >
          {sidebar}
        </SheetContent>
      </Sheet>
      {comparison && (
        <RevisionDiff
          comparison={comparison}
          revisions={revisions}
          pending={busy}
          onClose={() => setComparison(null)}
          onCopy={() => void copyLocal()}
          onDiscard={() => setConfirmation({ action: "discard", open: true })}
          onSaveLocal={() =>
            setConfirmation({ action: "save-local", open: true })
          }
        />
      )}
      <AlertDialog
        open={confirmation.open}
        onOpenChange={(open) => {
          if (!open && !busy)
            setConfirmation((state) => ({ ...state, open: false }));
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation.action === "save-local"
                ? t(($) => $.documents.confirm_local)
                : t(($) => $.documents.discard_title)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation.action === "save-local"
                ? t(($) => $.documents.confirm_local_description, {
                    version: comparison?.right.version ?? doc.version,
                  })
                : t(($) => $.documents.discard_description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {t(($) => $.documents.keep)}
            </AlertDialogCancel>
            <Button
              disabled={busy}
              aria-busy={busy}
              variant={
                confirmation.action === "discard" ? "destructive" : "default"
              }
              onClick={() => {
                if (confirmation.action === "discard") void discard();
                else
                  void saveDraft(comparison?.right.version, comparison?.draft);
              }}
            >
              {confirmation.action === "discard"
                ? t(($) => $.documents.discard)
                : t(($) => $.documents.save_local)}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
