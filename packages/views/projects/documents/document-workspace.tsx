"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  documentDraftKey,
  documentListOptions,
  useCreateDocument,
  useDocumentDraftStore,
} from "@multica/core/documents";
import type { Project } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { BookOpen, FileText, Plus, Search, PanelLeft } from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from "@multica/ui/components/ui/dialog";
import { Sheet, SheetContent } from "@multica/ui/components/ui/sheet";
import { cn } from "@multica/ui/lib/utils";
import { useNavigation, AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { BreadcrumbHeader } from "../../layout/breadcrumb-header";
import { ProjectViewTabs } from "../components/project-view-tabs";
import { DocumentEditor } from "./document-editor";
import "./document-workspace.css";

export function ProjectDocumentWorkspace({ project }: { project: Project }) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const router = useNavigation();
  const list = useQuery(documentListOptions(wsId, project.id));
  const documents = list.data ?? [];
  const firstDocumentId = list.data?.[0]?.id;
  const selected = router.searchParams.get("document") ?? documents[0]?.id;
  const drafts = useDocumentDraftStore((s) => s.draft.drafts);
  const create = useCreateDocument(wsId, project.id);
  const [search, setSearch] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [kind, setKind] = useState<"spec" | "document">("spec");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pathFor = (id: string) =>
    `${paths.projectDetail(project.id)}?view=docs&document=${encodeURIComponent(id)}`;
  useEffect(() => {
    if (!router.searchParams.get("document") && firstDocumentId) {
      router.replace(
        `${paths.projectDetail(project.id)}?view=docs&document=${encodeURIComponent(firstDocumentId)}`,
      );
    }
  }, [router, paths, project.id, firstDocumentId]);
  const matching = documents.filter((doc) => {
    const draft = drafts[documentDraftKey(wsId, project.id, doc.id)];
    return `${draft?.title ?? doc.title}\n${draft?.body ?? doc.body}`
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase());
  });
  const createDocument = async () => {
    if (create.isPending || !title.trim()) return;
    setError(null);
    try {
      const doc = await create.mutateAsync({ title, kind });
      setNewOpen(false);
      setTitle("");
      router.push(pathFor(doc.id));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t(($) => $.documents.failed),
      );
    }
  };
  const directory = (
    <div className="flex h-full flex-col min-h-0">
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <h2 className="text-label font-semibold">
          {t(($) => $.documents.directory)}
        </h2>
        <DialogTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t(($) => $.documents.new)}
              onClick={() => setDirectoryOpen(false)}
            />
          }
        >
          <Plus />
        </DialogTrigger>
      </div>
      <div className="relative mx-3 mb-4">
        <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={t(($) => $.documents.search)}
          placeholder={t(($) => $.documents.search)}
          className="pl-8 text-caption"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {(["spec", "document"] as const).map((group) => {
          const items = matching.filter((doc) => doc.kind === group);
          return (
            <section key={group} className="mb-5">
              <h3 className="px-2 mb-2 flex items-center justify-between text-micro font-semibold text-muted-foreground uppercase tracking-wide">
                <span className="flex items-center gap-1.5">
                  {group === "spec" ? (
                    <BookOpen className="size-3.5" />
                  ) : (
                    <FileText className="size-3.5" />
                  )}
                  {group === "spec"
                    ? t(($) => $.documents.specs)
                    : t(($) => $.documents.guides)}
                </span>
                <span>{items.length}</span>
              </h3>
              {items.map((doc) => {
                const draft =
                  drafts[documentDraftKey(wsId, project.id, doc.id)];
                return (
                  <AppLink
                    key={doc.id}
                    href={pathFor(doc.id)}
                    onClick={() => setDirectoryOpen(false)}
                    aria-current={selected === doc.id ? "page" : undefined}
                    className={cn(
                      "document-directory-item",
                      selected === doc.id && "is-selected",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2 text-micro font-mono text-muted-foreground">
                      <span
                        className={doc.kind === "spec" ? "text-brand" : ""}
                      >{`${doc.kind === "spec" ? "SPEC" : "DOC"} · v${doc.version}`}</span>
                      {draft && (
                        <span
                          className="size-1.5 rounded-full bg-warning"
                          aria-label={t(($) => $.documents.dirty)}
                        />
                      )}
                    </div>
                    <div className="mt-1 line-clamp-2 text-label font-medium break-words">
                      {draft?.title ?? doc.title}
                    </div>
                    <div className="mt-2 truncate text-caption text-muted-foreground">
                      {doc.author_name} ·{" "}
                      {doc.author_type === "agent"
                        ? t(($) => $.documents.agent)
                        : t(($) => $.documents.member)}
                    </div>
                  </AppLink>
                );
              })}
            </section>
          );
        })}
        {search && !matching.length && (
          <p className="px-2 text-caption text-muted-foreground">
            {t(($) => $.documents.no_results)}
          </p>
        )}
      </div>
      <p className="m-3 rounded-lg border bg-background p-3 text-caption leading-relaxed text-muted-foreground">
        {t(($) => $.documents.storage_hint)}
      </p>
    </div>
  );
  return (
    <Dialog
      open={newOpen}
      onOpenChange={(open) => {
        if (!create.isPending) {
          setNewOpen(open);
          setError(null);
        }
      }}
    >
      <div
        className="flex h-full min-h-0 flex-col"
        data-testid="project-document-workspace"
      >
        <BreadcrumbHeader
          segments={[
            {
              href: paths.projects(),
              label: t(($) => $.detail.breadcrumb_fallback),
            },
          ]}
          leaf={<span className="font-medium truncate">{project.title}</span>}
          actions={
            <ProjectViewTabs projectId={project.id} active="documents" />
          }
        />
        <div className="flex min-h-0 flex-1">
          <aside className="document-directory hidden md:block border-r bg-muted/20">
            {directory}
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="md:hidden px-3 pt-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDirectoryOpen(true)}
              >
                <PanelLeft />
                {t(($) => $.documents.directory)}
              </Button>
            </div>
            {selected ? (
              <DocumentEditor
                key={`${wsId}:${project.id}:${selected}`}
                wsId={wsId}
                project={project}
                documentId={selected}
                onOpenDocument={(id) => router.push(pathFor(id))}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-body text-muted-foreground">
                {list.isError ? (
                  <div role="alert" className="space-y-3 text-center">
                    <p>{t(($) => $.documents.load_failed)}</p>
                    <Button
                      variant="outline"
                      onClick={() => void list.refetch()}
                    >
                      {t(($) => $.documents.retry)}
                    </Button>
                  </div>
                ) : list.isLoading ? (
                  <span aria-busy="true">…</span>
                ) : (
                  <div className="text-center space-y-4">
                    <BookOpen className="mx-auto size-8 text-faint-foreground" />
                    <p>{t(($) => $.documents.empty)}</p>
                    <Button onClick={() => setNewOpen(true)}>
                      <Plus />
                      {t(($) => $.documents.new)}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <Sheet open={directoryOpen} onOpenChange={setDirectoryOpen}>
          <SheetContent
            side="left"
            className="p-0 w-72"
            aria-label={t(($) => $.documents.directory)}
          >
            {directory}
          </SheetContent>
        </Sheet>
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void createDocument();
            }}
            className="space-y-5"
          >
            <DialogHeader>
              <DialogTitle>{t(($) => $.documents.new)}</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3">
              {(["spec", "document"] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  aria-pressed={kind === type}
                  onClick={() => setKind(type)}
                  className={cn(
                    "rounded-lg border p-4 text-left hover:bg-accent",
                    kind === type &&
                      "border-brand bg-brand/5 ring-1 ring-brand",
                  )}
                >
                  {type === "spec" ? (
                    <BookOpen className="size-5 text-brand mb-3" />
                  ) : (
                    <FileText className="size-5 text-muted-foreground mb-3" />
                  )}
                  <span className="text-body font-medium">
                    {type === "spec"
                      ? t(($) => $.documents.spec)
                      : t(($) => $.documents.document)}
                  </span>
                </button>
              ))}
            </div>
            <label className="block space-y-2 text-label font-medium">
              {t(($) => $.documents.title)}
              <Input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={300}
                required
              />
            </label>
            {error && (
              <p role="alert" className="text-caption text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={create.isPending}
                onClick={() => setNewOpen(false)}
              >
                {t(($) => $.documents.cancel)}
              </Button>
              <Button
                type="submit"
                disabled={create.isPending || !title.trim()}
                aria-busy={create.isPending}
              >
                {t(($) => $.documents.create)}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </div>
    </Dialog>
  );
}
