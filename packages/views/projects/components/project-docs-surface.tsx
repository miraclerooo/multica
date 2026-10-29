"use client";

import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  FileText,
  LayoutGrid,
  Rows3,
  Search,
  Pin,
  Plus,
} from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@multica/ui/components/ui/dialog";
import {
  ListGrid,
  ListGridHeader,
  ListGridHeaderCell,
  ListGridRow,
  ListGridCell,
} from "@multica/ui/components/ui/list-grid";
import { cn } from "@multica/ui/lib/utils";
import {
  projectDocumentsOptions,
  useCreateProjectDocument,
  documentProblem,
} from "@multica/core/projects";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspaceSlug } from "@multica/core/paths";
import { useActorName } from "@multica/core/workspace/hooks";
import type { Project, ProjectDocumentSummary } from "@multica/core/types";
import { AppLink, useNavigation } from "../../navigation";
import { ActorAvatar } from "../../common/actor-avatar";
import { useT } from "../../i18n";
import { matchesPinyin } from "../../editor/extensions/pinyin-match";
import { useFormatRelativeDate } from "./labels";
import { ProjectDocWorkspace } from "./project-doc-workspace";

import {
  projectDocumentPath,
  type ProjectDocsHandle,
} from "./project-document-path";
export type { ProjectDocsHandle } from "./project-document-path";

export const ProjectDocsSurface = forwardRef<
  ProjectDocsHandle,
  { project: Project }
>(function ProjectDocsSurface({ project }, ref) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const slug = useWorkspaceSlug() ?? undefined;
  const router = useNavigation();
  const query = useQuery(projectDocumentsOptions(wsId, project.id, slug));
  const create = useCreateProjectDocument(wsId, project.id, slug);
  const workspace = useRef<ProjectDocsHandle>(null);
  const [search, setSearch] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [view, setView] = useState<"cards" | "list">("cards");
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const selectedId = router.searchParams.get("doc");
  useImperativeHandle(ref, () => ({
    flush: () => workspace.current?.flush() ?? Promise.resolve(true),
  }));
  const documents = query.data?.documents ?? [];
  const pinnedCount = documents.filter((d) => d.is_pinned).length;
  const filtered = documents.filter(
    (d) =>
      (!pinnedOnly || d.is_pinned) &&
      (!search.trim() ||
        `${d.title} ${d.excerpt}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()) ||
        matchesPinyin(d.title, search.trim())),
  );
  const openCreate = async () => {
    if (await (workspace.current?.flush() ?? Promise.resolve(true))) {
      create.reset();
      setTitle("");
      setCreateOpen(true);
    }
  };
  const href = (id: string) =>
    projectDocumentPath(router.pathname, router.searchParams, id);
  const groups = [
    {
      title: t(($) => $.docs.pinned_section),
      items: filtered.filter((d) => d.is_pinned),
      pinned: true,
    },
    {
      title: t(($) => $.docs.all_section),
      items: filtered.filter((d) => !d.is_pinned),
      pinned: false,
    },
  ];

  return (
    <>
      {selectedId ? (
        <ProjectDocWorkspace
          key={`${wsId}:${project.id}:${selectedId}`}
          ref={workspace}
          project={project}
          documentId={selectedId}
          documents={documents}
          onCreate={() => void openCreate()}
        />
      ) : (
        <section
          className="@container/docs flex min-h-0 flex-1 flex-col"
          aria-label={t(($) => $.docs.tab)}
        >
          <div className="flex flex-wrap items-center gap-2 px-6 py-5">
            <div className="relative w-60 max-w-full">
              <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" />
              <Input
                className="pl-8"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t(($) => $.docs.search)}
                aria-label={t(($) => $.docs.search)}
              />
            </div>
            <div className="flex rounded-lg bg-muted p-0.5">
              <Button
                size="sm"
                variant={pinnedOnly ? "ghost" : "secondary"}
                className={!pinnedOnly ? "bg-surface shadow-sm" : ""}
                aria-pressed={!pinnedOnly}
                onClick={() => setPinnedOnly(false)}
              >
                {t(($) => $.docs.all_filter, { count: query.data?.total ?? 0 })}
              </Button>
              <Button
                size="sm"
                variant={pinnedOnly ? "secondary" : "ghost"}
                className={pinnedOnly ? "bg-surface shadow-sm" : ""}
                aria-pressed={pinnedOnly}
                onClick={() => setPinnedOnly(true)}
              >
                {t(($) => $.docs.pinned_filter, { count: pinnedCount })}
              </Button>
            </div>
            <div className="flex-1" />
            <div className="flex rounded-lg bg-muted p-0.5">
              <Button
                size="sm"
                variant="ghost"
                className={
                  view === "cards"
                    ? "bg-surface shadow-sm hover:bg-surface"
                    : ""
                }
                aria-pressed={view === "cards"}
                onClick={() => setView("cards")}
              >
                <LayoutGrid />
                {t(($) => $.docs.cards)}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className={
                  view === "list" ? "bg-surface shadow-sm hover:bg-surface" : ""
                }
                aria-pressed={view === "list"}
                onClick={() => setView("list")}
              >
                <Rows3 />
                {t(($) => $.docs.list)}
              </Button>
            </div>
            <Button onClick={() => void openCreate()} disabled={query.isError}>
              <Plus />
              {t(($) => $.docs.create)}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-6 pb-16">
            {query.isPending ? (
              <div
                role="status"
                className="py-12 text-center text-muted-foreground"
              >
                {t(($) => $.docs.loading)}
              </div>
            ) : query.isError ? (
              <div
                role="alert"
                className="flex flex-col items-center gap-3 py-12"
              >
                <p>{t(($) => $.docs.load_error)}</p>
                <Button variant="outline" onClick={() => void query.refetch()}>
                  {t(($) => $.docs.retry)}
                </Button>
              </div>
            ) : !documents.length ? (
              <div className="flex flex-col items-center gap-4 py-20 text-muted-foreground">
                <FileText className="size-9" />
                <h2 className="text-title font-medium text-foreground">
                  {t(($) => $.docs.empty)}
                </h2>
                <Button onClick={() => void openCreate()}>
                  <Plus />
                  {t(($) => $.docs.create)}
                </Button>
              </div>
            ) : !filtered.length ? (
              <p
                role="status"
                className="py-16 text-center text-muted-foreground"
              >
                {t(($) => $.docs.no_results)}
              </p>
            ) : view === "list" ? (
              <DocumentList documents={filtered} href={href} />
            ) : (
              groups.map(
                (group) =>
                  group.items.length > 0 && (
                    <section key={String(group.pinned)} className="mb-7">
                      <h2 className="mb-3 flex items-center gap-2 text-label font-medium text-muted-foreground">
                        {group.pinned ? (
                          <Pin className="size-4" />
                        ) : (
                          <FileText className="size-4" />
                        )}
                        {group.title}
                        <span className="text-caption tabular-nums">
                          {group.items.length}
                        </span>
                      </h2>
                      <div
                        className={cn(
                          "grid grid-cols-1 gap-3 @lg/docs:grid-cols-2",
                          !group.pinned && "@3xl/docs:grid-cols-3",
                        )}
                      >
                        {group.items.map((doc) => (
                          <DocumentCard
                            key={doc.id}
                            doc={doc}
                            href={href(doc.id)}
                          />
                        ))}
                      </div>
                    </section>
                  ),
              )
            )}
          </div>
        </section>
      )}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!create.isPending) setCreateOpen(open);
        }}
      >
        <DialogContent>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!title.trim() || [...title.trim()].length > 200) return;
              try {
                const doc = await create.mutateAsync({ title: title.trim() });
                setCreateOpen(false);
                router.push(
                  projectDocumentPath(
                    router.pathname,
                    router.searchParams,
                    doc.id,
                    true,
                  ),
                );
              } catch {
                /* The dialog keeps the title and presents the failure. */
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>{t(($) => $.docs.create)}</DialogTitle>
              <DialogDescription>
                {t(($) => $.docs.shared_scope)}
              </DialogDescription>
            </DialogHeader>
            <label className="my-5 flex flex-col gap-2 text-label">
              {t(($) => $.docs.title)}
              <Input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t(($) => $.docs.title_placeholder)}
              />
            </label>
            {create.isError && (
              <p role="alert" className="mb-4 text-label text-destructive">
                {documentProblem(create.error).kind === "forbidden"
                  ? t(($) => $.docs.forbidden)
                  : t(($) => $.docs.create_error)}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={create.isPending}
              >
                {t(($) => $.docs.cancel)}
              </Button>
              <Button
                type="submit"
                disabled={
                  create.isPending ||
                  !title.trim() ||
                  [...title.trim()].length > 200
                }
              >
                {create.isPending
                  ? t(($) => $.docs.creating)
                  : t(($) => $.docs.create)}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
});

function DocumentCard({
  doc,
  href,
}: {
  doc: ProjectDocumentSummary;
  href: string;
}) {
  const { t } = useT("projects");
  const { getActorName } = useActorName();
  const relative = useFormatRelativeDate();
  return (
    <AppLink
      href={href}
      className={cn(
        "flex min-w-0 flex-col rounded-xl border border-surface-border bg-surface p-4 shadow-sm transition-colors hover:border-brand/40 focus-visible:outline-2 focus-visible:outline-brand",
        doc.is_pinned &&
          "border-brand/25 bg-gradient-to-b from-brand/10 to-surface",
      )}
    >
      <div className="mb-3 flex items-center gap-2">
        <span
          className={cn(
            "rounded-lg border border-surface-border bg-muted p-1.5 text-muted-foreground",
            doc.is_pinned && "border-brand/25 bg-surface text-brand",
          )}
        >
          <FileText className="size-4" />
        </span>
        <span className="flex-1" />
        {doc.is_pinned && (
          <span className="flex items-center gap-1 rounded-full border border-brand/25 bg-surface px-2 py-0.5 text-caption text-brand">
            <Pin className="size-3" />
            {t(($) => $.docs.pinned)}
          </span>
        )}
        <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-caption text-muted-foreground">
          {t(($) => $.docs.version, { revision: doc.revision })}
        </span>
      </div>
      <h3 className="truncate text-body-lg font-semibold">{doc.title}</h3>
      <p className="mt-1.5 line-clamp-2 min-h-10 text-body text-muted-foreground">
        {doc.excerpt || t(($) => $.docs.no_content)}
      </p>
      <div className="mt-4 flex items-center gap-1.5 border-t border-border pt-3 text-caption text-muted-foreground">
        <ActorAvatar
          actorType="member"
          actorId={doc.updated_by}
          size="xs"
          profileLink={false}
        />
        <span className="truncate">
          {getActorName("member", doc.updated_by)}
        </span>
        <span>·</span>
        <span className="shrink-0">{relative(doc.updated_at)}</span>
      </div>
    </AppLink>
  );
}

function DocumentList({
  documents,
  href,
}: {
  documents: ProjectDocumentSummary[];
  href: (id: string) => string;
}) {
  const { t } = useT("projects");
  const { getActorName } = useActorName();
  const relative = useFormatRelativeDate();
  return (
    <div className="overflow-x-auto rounded-xl border border-surface-border">
      <ListGrid className="grid-cols-[0.5rem_minmax(150px,1fr)_80px_0.5rem] @2xl/docs:min-w-[900px] @2xl/docs:grid-cols-[0.5rem_minmax(180px,1.5fr)_minmax(180px,2fr)_80px_120px_100px_90px_0.5rem]">
        <ListGridHeader>
          {[
            t(($) => $.docs.title),
            t(($) => $.docs.excerpt),
            t(($) => $.docs.revision),
            t(($) => $.docs.updated_by),
            t(($) => $.docs.updated_at),
            t(($) => $.docs.status),
          ].map((label, index) => (
            <ListGridHeaderCell
              key={label}
              className={
                index > 0 && index < 5 ? "hidden @2xl/docs:flex" : undefined
              }
            >
              {label}
            </ListGridHeaderCell>
          ))}
        </ListGridHeader>
        {documents.map((doc) => (
          <ListGridRow key={doc.id}>
            <ListGridCell>
              <AppLink
                href={href(doc.id)}
                className="flex min-w-0 items-center gap-2 font-medium hover:text-brand"
              >
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{doc.title}</span>
              </AppLink>
            </ListGridCell>
            <ListGridCell className="hidden truncate text-muted-foreground @2xl/docs:flex">
              {doc.excerpt}
            </ListGridCell>
            <ListGridCell className="hidden @2xl/docs:flex">
              {t(($) => $.docs.version, { revision: doc.revision })}
            </ListGridCell>
            <ListGridCell className="hidden truncate @2xl/docs:flex">
              {getActorName("member", doc.updated_by)}
            </ListGridCell>
            <ListGridCell className="hidden @2xl/docs:flex">
              {relative(doc.updated_at)}
            </ListGridCell>
            <ListGridCell>
              {doc.is_pinned
                ? t(($) => $.docs.pinned)
                : t(($) => $.docs.shared)}
            </ListGridCell>
          </ListGridRow>
        ))}
      </ListGrid>
    </div>
  );
}
