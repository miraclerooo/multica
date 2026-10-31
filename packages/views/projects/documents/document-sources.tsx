"use client";
import { useQuery } from "@tanstack/react-query";
import { documentSourcesOptions } from "@multica/core/documents";
import { useWorkspacePaths } from "@multica/core/paths";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

export function DocumentSources({
  wsId,
  projectId,
  documentId,
}: {
  wsId: string;
  projectId: string;
  documentId: string;
}) {
  const { t } = useT("squads");
  const paths = useWorkspacePaths();
  const sources = useQuery(documentSourcesOptions(wsId, projectId, documentId));
  return (
    <section className="document-info-card">
      <h2>{t(($) => $.pipeline.sources)}</h2>
      {sources.isError && (
        <p role="alert" className="text-destructive">
          {t(($) => $.pipeline.failed)}
        </p>
      )}
      {sources.data?.sources.map((record) => (
        <div className="space-y-2 mt-3 break-words" key={record.source_key}>
          <AppLink
            className="underline"
            href={paths.issueDetail(record.source.issue_id)}
          >
            {t(($) => $.pipeline.relationship)} ·{" "}
            {record.source.issue_id.slice(0, 8)}
          </AppLink>
          <p>
            {record.source.label} ·{" "}
            {record.source.mutable
              ? t(($) => $.pipeline.mutable)
              : t(($) => $.pipeline.pinned)}
          </p>
          <p>
            {t(($) => $.pipeline.source_version)}{" "}
            {record.source.document_version ?? record.document_version} ·{" "}
            {record.source.artifact?.sha ??
              record.source.sha ??
              record.source.attachment_id}
          </p>
          {record.source.run_id && (
            <AppLink
              className="underline"
              href={paths.pipelineRun(record.source.run_id)}
            >
              {record.source.job_id} · {t(($) => $.pipeline.attempt)}{" "}
              {record.source.attempt}
            </AppLink>
          )}
        </div>
      ))}
    </section>
  );
}
