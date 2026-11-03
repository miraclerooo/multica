"use client";

import { useQuery } from "@tanstack/react-query";
import { documentGroupsOptions } from "@multica/core/documents";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

export function DocumentRelatedIssues({
  wsId,
  projectId,
  documentId,
}: {
  wsId: string;
  projectId: string;
  documentId: string;
}) {
  const { t } = useT("projects");
  const paths = useWorkspacePaths();
  const collection = useQuery(documentGroupsOptions(wsId, projectId));
  const issues =
    collection.data?.groups.filter(
      (group) =>
        group.issue_id && group.documents.some((doc) => doc.id === documentId),
    ) ?? [];

  return (
    <section className="document-info-card" aria-busy={collection.isLoading}>
      <h2>{t(($) => $.documents.related_issues)}</h2>
      {collection.isLoading && <span>…</span>}
      {collection.isError && (
        <div role="alert" className="space-y-2">
          <p className="text-destructive">{t(($) => $.documents.load_failed)}</p>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void collection.refetch()}
          >
            {t(($) => $.documents.retry)}
          </Button>
        </div>
      )}
      <div className="space-y-2">
        {issues.map(
          (issue) =>
            issue.issue_id && (
              <AppLink
                key={issue.issue_id}
                href={paths.issueDetail(issue.issue_id)}
                className="block rounded-md p-2 hover:bg-accent break-words"
              >
                <span className="block font-mono text-micro text-muted-foreground">
                  {issue.identifier}
                </span>
                <span className="block mt-1">{issue.title}</span>
              </AppLink>
            ),
        )}
      </div>
      {collection.isSuccess && issues.length === 0 && (
        <p className="text-muted-foreground">
          {t(($) => $.documents.no_related_issues)}
        </p>
      )}
    </section>
  );
}
