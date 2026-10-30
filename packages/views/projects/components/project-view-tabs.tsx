"use client";

import { useWorkspacePaths } from "@multica/core/paths";
import { BookOpen, ListTodo } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

export function ProjectViewTabs({
  projectId,
  active,
}: {
  projectId: string;
  active: "issues" | "documents";
}) {
  const paths = useWorkspacePaths();
  const { t } = useT("projects");
  return (
    <nav
      className="flex shrink-0 items-center gap-1 rounded-lg bg-muted p-1"
      aria-label={t(($) => $.detail.breadcrumb_fallback)}
    >
      <AppLink
        href={paths.projectDetail(projectId)}
        aria-current={active === "issues" ? "page" : undefined}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-caption text-muted-foreground hover:text-foreground",
          active === "issues" && "bg-background text-foreground shadow-sm",
        )}
      >
        <ListTodo className="size-3.5" />
        {t(($) => $.documents.issues)}
      </AppLink>
      <AppLink
        href={`${paths.projectDetail(projectId)}?view=docs`}
        aria-current={active === "documents" ? "page" : undefined}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-caption text-muted-foreground hover:text-foreground",
          active === "documents" && "bg-background text-foreground shadow-sm",
        )}
      >
        <BookOpen className="size-3.5" />
        {t(($) => $.documents.tab)}
      </AppLink>
    </nav>
  );
}
