"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useIsMutating, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeft,
  FileText,
  GripVertical,
  Search,
  Plus,
  Pin,
  PinOff,
  Link2,
  MoreHorizontal,
  Trash2,
  Download,
  AlertTriangle,
  Copy,
  Check,
  Loader2,
  List,
} from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@multica/ui/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@multica/ui/components/ui/alert-dialog";
import { cn } from "@multica/ui/lib/utils";
import { copyText } from "@multica/ui/lib/clipboard";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspaceSlug } from "@multica/core/paths";
import { useAuthStore } from "@multica/core/auth";
import { memberListOptions } from "@multica/core/workspace/queries";
import { useActorName } from "@multica/core/workspace/hooks";
import {
  projectDocumentOptions,
  projectDocumentKeys,
  documentDraftKey,
  editDocumentDraft,
  readDocumentDraft,
  writeDocumentDraft,
  useProjectDocumentDraftStore,
  equalDocumentFields,
  useSaveProjectDocument,
  useRetryProjectDocument,
  useDeleteProjectDocument,
  canDeleteProjectDocument,
  documentProblem,
} from "@multica/core/projects";
import type {
  Project,
  ProjectDocument,
  ProjectDocumentSummary,
} from "@multica/core/types";
import { toast } from "sonner";
import { useT } from "../../i18n";
import { AppLink, useNavigation } from "../../navigation";
import { ActorAvatar } from "../../common/actor-avatar";
import {
  ContentEditor,
  ReadonlyContent,
  type ContentEditorRef,
} from "../../editor";
import { useFormatRelativeDate } from "./labels";
import {
  projectDocumentPath,
  type ProjectDocsHandle,
} from "./project-document-path";

type Props = {
  project: Project;
  documentId: string;
  documents: ProjectDocumentSummary[];
  onCreate: () => void;
};
type Mode = "preview" | "edit" | "raw";

export const ProjectDocWorkspace = forwardRef<ProjectDocsHandle, Props>(
  function ProjectDocWorkspace(
    { project, documentId, documents, onCreate },
    ref,
  ) {
    const { t } = useT("projects");
    const wsId = useWorkspaceId();
    const slug = useWorkspaceSlug() ?? undefined;
    const router = useNavigation();
    const qc = useQueryClient();
    const userId = useAuthStore((s) => s.user?.id);
    const { data: members = [] } = useQuery(memberListOptions(wsId));
    const query = useQuery(
      projectDocumentOptions(wsId, project.id, documentId, slug),
    );
    const doc = query.data;
    const key = documentDraftKey(wsId, project.id, documentId);
    const draft = useProjectDocumentDraftStore((s) => s.draft.entries[key]);
    const { mutateAsync: saveDocument } = useSaveProjectDocument(
      wsId,
      project.id,
      slug,
    );
    const retry = useRetryProjectDocument(wsId, project.id, slug);
    const deleting = useDeleteProjectDocument(wsId, project.id, slug);
    const saving =
      useIsMutating({
        mutationKey: projectDocumentKeys.save(wsId, project.id),
      }) > 0;
    const [mode, setMode] = useState<Mode>(
      router.searchParams.get("mode") === "edit" ? "edit" : "preview",
    );
    const [navSearch, setNavSearch] = useState("");
    const [reloadOpen, setReloadOpen] = useState(false);
    const [reloading, setReloading] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<ProjectDocument | null>(
      null,
    );
    const [deleteError, setDeleteError] = useState(false);
    const [editorEpoch, setEditorEpoch] = useState(0);
    const [reordering, setReordering] = useState(false);
    const editorRef = useRef<ContentEditorRef>(null);
    const previewRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const mounted = useRef(true);
    const { getActorName } = useActorName();
    const relative = useFormatRelativeDate();
    const sensors = useSensors(
      useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
      useSensor(KeyboardSensor, {
        coordinateGetter: sortableKeyboardCoordinates,
      }),
    );
    const fields = draft ?? doc;
    const problem = draft?.problem;
    const accessProblem =
      query.isError &&
      ["missing", "forbidden"].includes(documentProblem(query.error).kind);
    const canEdit =
      members.some((m) => m.user_id === userId) &&
      !reloading &&
      !accessProblem &&
      problem?.kind !== "forbidden" &&
      problem?.kind !== "missing";
    const canDelete =
      !!doc &&
      canEdit &&
      canDeleteProjectDocument(doc, project, userId, members);

    const flush = useCallback(async () => {
      const pending = editorRef.current?.flushPendingUpdate();
      if (pending != null && doc)
        editDocumentDraft(wsId, doc, { content: pending });
      return saveDocument(documentId);
    }, [doc, documentId, wsId, saveDocument]);
    const flushRef = useRef(flush);
    flushRef.current = flush;
    useImperativeHandle(ref, () => ({ flush }), [flush]);

    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
        void flushRef.current();
      };
    }, []);
    useEffect(() => {
      if (!draft || draft.problem) return;
      const timer = setTimeout(() => void saveDocument(documentId), 1000);
      return () => clearTimeout(timer);
    }, [draft, documentId, saveDocument]);
    useEffect(() => {
      if (
        !doc ||
        !draft ||
        saving ||
        draft.problem ||
        doc.revision <= draft.revision
      )
        return;
      if (equalDocumentFields(doc, draft)) writeDocumentDraft(wsId, key);
      else
        writeDocumentDraft(wsId, key, {
          ...draft,
          problem: { kind: "conflict", revision: doc.revision },
        });
    }, [doc, draft, saving, key, wsId]);
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void flushRef.current();
        }
      };
      const onHide = () => {
        if (document.visibilityState === "hidden") void flushRef.current();
      };
      const onUnload = (e: BeforeUnloadEvent) => {
        void flushRef.current();
        if (readDocumentDraft(key)) {
          e.preventDefault();
          e.returnValue = "";
        }
      };
      window.addEventListener("keydown", onKey);
      window.addEventListener("beforeunload", onUnload);
      document.addEventListener("visibilitychange", onHide);
      return () => {
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("beforeunload", onUnload);
        document.removeEventListener("visibilitychange", onHide);
      };
    }, [key]);

    const navigate = async (id?: string) => {
      if (await flush())
        router.push(
          projectDocumentPath(router.pathname, router.searchParams, id),
        );
    };
    const copyDraft = async () => {
      const pending = editorRef.current?.flushPendingUpdate();
      if (pending != null && doc)
        editDocumentDraft(wsId, doc, { content: pending });
      const local = readDocumentDraft(key) ?? fields;
      if (local && (await copyText(`# ${local.title}\n\n${local.content}`)))
        toast.success(t(($) => $.docs.copied));
    };
    const changeMode = (next: Mode) => {
      void flush();
      setMode(next);
    };
    const errorText =
      problem?.kind === "conflict"
        ? t(($) => $.docs.conflict, {
            revision: problem.revision ?? doc?.revision ?? 0,
          })
        : problem?.kind === "forbidden"
          ? t(($) => $.docs.forbidden)
          : problem?.kind === "missing"
            ? t(($) => $.docs.missing)
            : problem?.kind === "invalid"
              ? t(($) => $.docs.invalid)
              : t(($) => $.docs.save_error);
    const reorder = async ({ active, over }: DragEndEvent) => {
      if (!over || active.id === over.id || navSearch || reordering) return;
      const source = documents.find((d) => d.id === active.id),
        target = documents.find((d) => d.id === over.id);
      if (
        !source ||
        !target ||
        source.is_pinned !== target.is_pinned ||
        !(await flush())
      )
        return;
      const group = documents.filter((d) => d.is_pinned === source.is_pinned);
      const ordered = arrayMove(
        group,
        group.findIndex((d) => d.id === active.id),
        group.findIndex((d) => d.id === over.id),
      );
      setReordering(true);
      try {
        for (const [position, entry] of ordered.entries()) {
          if (entry.position === position) continue;
          const full = await qc.fetchQuery({
            ...projectDocumentOptions(wsId, project.id, entry.id, slug),
            staleTime: 0,
          });
          editDocumentDraft(wsId, full, { position });
          if (!(await saveDocument(entry.id))) {
            router.push(
              projectDocumentPath(
                router.pathname,
                router.searchParams,
                entry.id,
              ),
            );
            toast.error(t(($) => $.docs.reorder_error));
            break;
          }
        }
      } catch {
        toast.error(t(($) => $.docs.reorder_error));
      } finally {
        setReordering(false);
        void qc.invalidateQueries({
          queryKey: projectDocumentKeys.list(wsId, project.id),
        });
      }
    };

    const filtered = documents.filter((d) =>
      d.title.toLowerCase().includes(navSearch.toLowerCase()),
    );
    const docLink = (id: string) =>
      projectDocumentPath(router.pathname, router.searchParams, id);
    return (
      <div className="flex min-h-0 min-w-0 flex-1">
        <aside
          className="hidden w-[220px] shrink-0 flex-col border-r border-border bg-background lg:flex"
          aria-label={t(($) => $.docs.directory)}
        >
          <div className="flex items-center gap-1 px-3 py-3">
            <Button size="sm" variant="ghost" onClick={() => void navigate()}>
              <ArrowLeft />
              {t(($) => $.docs.back)}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={onCreate}
              aria-label={t(($) => $.docs.create)}
            >
              <Plus />
            </Button>
          </div>
          <div className="relative mx-3 mb-3">
            <Search className="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground" />
            <Input
              className="pl-7"
              value={navSearch}
              onChange={(e) => setNavSearch(e.target.value)}
              placeholder={t(($) => $.docs.quick_search)}
              aria-label={t(($) => $.docs.quick_search)}
            />
          </div>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={(event) => void reorder(event)}
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-5">
              {[true, false].map((pinned) => {
                const entries = filtered.filter((d) => d.is_pinned === pinned);
                return (
                  entries.length > 0 && (
                    <section key={String(pinned)} className="mb-5">
                      <h2 className="flex justify-between px-2 py-2 text-caption font-medium text-muted-foreground">
                        {pinned
                          ? t(($) => $.docs.pinned)
                          : t(($) => $.docs.all_section)}
                        <span>{entries.length}</span>
                      </h2>
                      <SortableContext
                        items={entries.map((d) => d.id)}
                        strategy={verticalListSortingStrategy}
                      >
                        {entries.map((entry) => (
                          <DocumentNavItem
                            key={entry.id}
                            entry={entry}
                            active={entry.id === documentId}
                            href={docLink(entry.id)}
                            onNavigate={() => void navigate(entry.id)}
                            disabled={
                              !canEdit || !!problem || !!navSearch || reordering
                            }
                          />
                        ))}
                      </SortableContext>
                    </section>
                  )
                );
              })}
            </div>
          </DndContext>
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
          <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-border px-4 py-1.5">
            <Button
              size="icon-sm"
              variant="ghost"
              className="lg:hidden"
              onClick={() => void navigate()}
              aria-label={t(($) => $.docs.back)}
            >
              <ArrowLeft />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="lg:hidden"
                    aria-label={t(($) => $.docs.directory)}
                  >
                    <List />
                  </Button>
                }
              />
              <DropdownMenuContent>
                {documents.map((d) => (
                  <DropdownMenuItem
                    key={d.id}
                    onClick={() => void navigate(d.id)}
                  >
                    {d.title}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem onClick={onCreate}>
                  <Plus />
                  {t(($) => $.docs.create)}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="hidden max-w-52 truncate text-label font-medium xl:block">
              {fields?.title}
            </span>
            {doc && (
              <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-caption text-muted-foreground">
                {draft
                  ? t(($) => $.docs.draft_revision, {
                      revision: draft.revision,
                    })
                  : t(($) => $.docs.version, { revision: doc.revision })}
              </span>
            )}
            <span
              role="status"
              className={cn(
                "flex items-center gap-1.5 text-caption text-muted-foreground",
                problem && "text-warning",
              )}
            >
              {saving ? (
                <Loader2 className="size-3 animate-spin" />
              ) : problem ? (
                <AlertTriangle className="size-3" />
              ) : (
                <Check className="size-3 text-success" />
              )}
              {problem
                ? t(($) => $.docs.draft_retained)
                : saving
                  ? t(($) => $.docs.saving)
                  : draft
                    ? t(($) => $.docs.unsaved)
                    : t(($) => $.docs.synced)}
            </span>
            <div className="flex-1" />
            <div className="flex rounded-lg bg-muted p-0.5">
              {(["preview", "edit", "raw"] as const).map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant="ghost"
                  className={
                    mode === value
                      ? "bg-surface shadow-sm hover:bg-surface"
                      : ""
                  }
                  aria-pressed={mode === value}
                  disabled={value === "edit" && !canEdit}
                  onClick={() => changeMode(value)}
                >
                  {value === "preview"
                    ? t(($) => $.docs.preview)
                    : value === "edit"
                      ? t(($) => $.docs.edit)
                      : t(($) => $.docs.raw)}
                </Button>
              ))}
            </div>
            <Button
              size="icon-sm"
              variant={fields?.is_pinned ? "secondary" : "ghost"}
              disabled={!doc || !canEdit || !!problem}
              aria-label={
                fields?.is_pinned
                  ? t(($) => $.docs.unpin)
                  : t(($) => $.docs.pin)
              }
              onClick={() => {
                if (doc) {
                  const pending = editorRef.current?.flushPendingUpdate();
                  editDocumentDraft(wsId, doc, {
                    is_pinned: !fields?.is_pinned,
                    ...(pending != null ? { content: pending } : {}),
                  });
                  void saveDocument(documentId);
                }
              }}
            >
              {fields?.is_pinned ? <PinOff /> : <Pin />}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t(($) => $.docs.copy_link)}
              onClick={() =>
                void copyText(router.getShareableUrl(docLink(documentId))).then(
                  (ok) => {
                    if (ok) toast.success(t(($) => $.docs.copied));
                  },
                )
              }
            >
              <Link2 />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t(($) => $.docs.more)}
                  >
                    <MoreHorizontal />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void copyDraft()}>
                  <Copy />
                  {t(($) => $.docs.copy_draft)}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!fields}
                  onClick={() => {
                    if (!fields) return;
                    const url = URL.createObjectURL(
                      new Blob([`# ${fields.title}\n\n${fields.content}`], {
                        type: "text/markdown;charset=utf-8",
                      }),
                    );
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = `${fields.title.replace(/[\\/:*?"<>|]/g, "-")}.md`;
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  <Download />
                  {t(($) => $.docs.export)}
                </DropdownMenuItem>
                {canDelete && (
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={saving || !!problem}
                    onClick={async () => {
                      if (await flush()) {
                        setDeleteError(false);
                        setDeleteTarget(
                          qc.getQueryData<ProjectDocument>(
                            projectDocumentKeys.detail(
                              wsId,
                              project.id,
                              documentId,
                            ),
                          ) ??
                            doc ??
                            null,
                        );
                      }
                    }}
                  >
                    <Trash2 />
                    {t(($) => $.docs.delete)}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {problem && (
            <div
              role="alert"
              aria-label={t(($) => $.docs.draft_retained)}
              className="flex flex-wrap items-center gap-3 border-b border-warning/30 bg-warning/10 px-5 py-3 text-label"
            >
              <AlertTriangle className="size-4 shrink-0 text-warning" />
              <span className="mx-auto min-w-0 max-w-[680px] flex-1">
                {errorText}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void copyDraft()}
              >
                {t(($) => $.docs.copy_draft)}
              </Button>
              {problem.kind === "conflict" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving}
                  onClick={() => setReloadOpen(true)}
                >
                  {t(($) => $.docs.load_remote)}
                </Button>
              ) : (
                problem.kind !== "invalid" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={saving}
                    onClick={() => void retry.mutateAsync(documentId)}
                  >
                    {t(($) => $.docs.retry)}
                  </Button>
                )
              )}
            </div>
          )}
          {query.isPending ? (
            <div
              role="status"
              className="p-12 text-center text-muted-foreground"
            >
              {t(($) => $.docs.loading)}
            </div>
          ) : !doc ? (
            <div className="flex flex-col items-center gap-4 p-12">
              <p role="alert">{t(($) => $.docs.load_error)}</p>
              <Button variant="outline" onClick={() => void query.refetch()}>
                {t(($) => $.docs.retry)}
              </Button>
              {draft && (
                <>
                  <p>{t(($) => $.docs.draft_retained)}</p>
                  <Button variant="outline" onClick={() => void copyDraft()}>
                    {t(($) => $.docs.copy_draft)}
                  </Button>
                </>
              )}
            </div>
          ) : (
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto flex max-w-[960px] items-start gap-8 px-5 py-8 lg:px-7">
                <div className="mx-auto min-w-0 max-w-[680px] flex-1">
                  {fields?.is_pinned && (
                    <div className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-brand/25 bg-brand/10 px-2.5 py-1 text-caption text-brand">
                      <Pin className="size-3.5" />
                      {t(($) => $.docs.pinned_scope)}
                    </div>
                  )}
                  {mode !== "preview" && canEdit ? (
                    <Input
                      aria-label={t(($) => $.docs.title)}
                      value={fields?.title ?? ""}
                      onChange={(e) =>
                        editDocumentDraft(wsId, doc, { title: e.target.value })
                      }
                      onBlur={() => void flush()}
                      className="h-auto rounded-none border-0 bg-transparent px-0 text-display-sm md:text-display-sm font-bold shadow-none focus-visible:ring-0"
                    />
                  ) : (
                    <h1 className="break-words text-display-sm font-bold">
                      {fields?.title}
                    </h1>
                  )}
                  <div className="mt-4 flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
                    <ActorAvatar
                      actorType="member"
                      actorId={doc.updated_by}
                      size="xs"
                      profileLink={false}
                    />
                    <span className="font-medium text-foreground">
                      {getActorName("member", doc.updated_by)}
                    </span>
                    <span>{relative(doc.updated_at)}</span>
                    <span>·</span>
                    <span>
                      {t(($) => $.docs.revision_value, {
                        revision: doc.revision,
                      })}
                    </span>
                  </div>
                  <p className="mb-6 mt-3 border-b border-border pb-5 text-caption text-muted-foreground">
                    {t(($) => $.docs.permissions)}
                  </p>
                  {accessProblem && (
                    <p
                      role="alert"
                      className="mb-4 text-label text-destructive"
                    >
                      {t(($) => $.docs.missing)}
                    </p>
                  )}
                  {mode === "preview" ? (
                    <div
                      ref={previewRef}
                      onDoubleClick={() => {
                        if (canEdit) setMode("edit");
                      }}
                    >
                      <ReadonlyContent content={fields?.content ?? ""} />
                      {!fields?.content && (
                        <p className="text-body text-muted-foreground">
                          {t(($) => $.docs.no_content)}
                        </p>
                      )}
                    </div>
                  ) : mode === "raw" || !canEdit ? (
                    <Textarea
                      aria-label={t(($) => $.docs.source_label)}
                      value={fields?.content ?? ""}
                      readOnly={!canEdit}
                      onChange={(e) =>
                        editDocumentDraft(wsId, doc, {
                          content: e.target.value,
                        })
                      }
                      onBlur={() => void flush()}
                      className="min-h-[480px] resize-y bg-muted/40 font-mono text-label leading-6"
                    />
                  ) : (
                    <ContentEditor
                      key={editorEpoch}
                      ref={editorRef}
                      value={fields?.content ?? ""}
                      debounceMs={0}
                      flushPendingOnUnmount
                      showFormattingToolbar
                      enableSlashCommands
                      slashCommandMode="document"
                      placeholder={t(($) => $.docs.body_placeholder)}
                      className="min-h-[360px] text-body"
                      onUpdate={(content) => {
                        editDocumentDraft(wsId, doc, { content });
                        if (!mounted.current) void saveDocument(documentId);
                      }}
                      onBlur={() => void flush()}
                    />
                  )}
                </div>
                {mode === "preview" && (
                  <DocumentOutline
                    content={fields?.content ?? ""}
                    previewRef={previewRef}
                    scrollRef={scrollRef}
                  />
                )}
              </div>
            </div>
          )}
        </div>
        <AlertDialog open={reloadOpen} onOpenChange={setReloadOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t(($) => $.docs.load_remote)}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t(($) => $.docs.reload_warning)}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={reloading}>
                {t(($) => $.docs.cancel)}
              </AlertDialogCancel>
              <Button
                disabled={reloading}
                onClick={async () => {
                  setReloading(true);
                  try {
                    await qc.fetchQuery({
                      ...projectDocumentOptions(
                        wsId,
                        project.id,
                        documentId,
                        slug,
                      ),
                      staleTime: 0,
                    });
                    writeDocumentDraft(wsId, key);
                    setEditorEpoch((n) => n + 1);
                    setMode("preview");
                    setReloadOpen(false);
                  } catch {
                    toast.error(t(($) => $.docs.load_error));
                  } finally {
                    setReloading(false);
                  }
                }}
              >
                {t(($) => $.docs.load_remote)}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog
          open={!!deleteTarget}
          onOpenChange={(open) => {
            if (!open && !deleting.isPending) setDeleteTarget(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t(($) => $.docs.delete)}</AlertDialogTitle>
              <AlertDialogDescription>
                {t(($) => $.docs.delete_warning)}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {deleteError && (
              <p role="alert" className="text-label text-destructive">
                {t(($) => $.docs.delete_error)}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting.isPending}>
                {t(($) => $.docs.cancel)}
              </AlertDialogCancel>
              <Button
                variant="destructive"
                disabled={deleting.isPending || deleteError}
                onClick={async () => {
                  if (!deleteTarget) return;
                  try {
                    await deleting.mutateAsync({
                      id: deleteTarget.id,
                      revision: deleteTarget.revision,
                    });
                    setDeleteTarget(null);
                    router.push(
                      projectDocumentPath(router.pathname, router.searchParams),
                    );
                  } catch {
                    setDeleteError(true);
                    void query.refetch();
                  }
                }}
              >
                {t(($) => $.docs.delete)}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    );
  },
);

function DocumentNavItem({
  entry,
  active,
  href,
  onNavigate,
  disabled,
}: {
  entry: ProjectDocumentSummary;
  active: boolean;
  href: string;
  onNavigate: () => void;
  disabled: boolean;
}) {
  const { t } = useT("projects");
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.id, disabled });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center rounded-md px-1",
        active
          ? "bg-surface-selected text-surface-selected-foreground"
          : "text-muted-foreground hover:bg-muted",
        isDragging && "opacity-50",
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        disabled={disabled}
        aria-label={t(($) => $.docs.reorder, { title: entry.title })}
        className="touch-none py-2 text-faint-foreground disabled:opacity-40"
      >
        <GripVertical className="size-3" />
      </button>
      <AppLink
        href={href}
        aria-current={active ? "page" : undefined}
        onClick={(e) => {
          if (
            e.button === 0 &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.shiftKey &&
            !e.altKey
          ) {
            e.preventDefault();
            onNavigate();
          }
        }}
        className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-2 text-label"
      >
        <FileText className="size-3.5 shrink-0" />
        <span className="truncate">{entry.title}</span>
      </AppLink>
    </div>
  );
}

function DocumentOutline({
  content,
  previewRef,
  scrollRef,
}: {
  content: string;
  previewRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useT("projects");
  const [headings, setHeadings] = useState<HTMLElement[]>([]);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const elements = Array.from(
      previewRef.current?.querySelectorAll<HTMLElement>("h2,h3") ?? [],
    );
    setHeadings(elements);
    setActive(0);
    if (!elements.length || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting)
            setActive(elements.indexOf(entry.target as HTMLElement));
      },
      { root: scrollRef.current, rootMargin: "0px 0px -70% 0px" },
    );
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [content, previewRef, scrollRef]);
  if (!headings.length) return null;
  return (
    <nav
      aria-label={t(($) => $.docs.outline)}
      className="sticky top-8 hidden w-[168px] shrink-0 border-l border-border pl-4 2xl:block"
    >
      <h2 className="mb-3 text-caption font-semibold text-muted-foreground">
        {t(($) => $.docs.outline)}
      </h2>
      {headings.map((heading, i) => (
        <button
          key={i}
          onClick={() => {
            heading.scrollIntoView({ behavior: "smooth", block: "start" });
            setActive(i);
          }}
          className={cn(
            "mb-2 block w-full text-left text-caption leading-5",
            heading.tagName === "H3" && "pl-2",
            active === i
              ? "font-medium text-brand"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {heading.textContent}
        </button>
      ))}
    </nav>
  );
}
