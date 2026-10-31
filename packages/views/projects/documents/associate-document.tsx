"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useCurrentMember } from "@multica/core/permissions";
import {
  documentGroupsOptions,
  documentDetailOptions,
  type ProjectDocument,
  issueDocumentsOptions,
  DocumentConflictSchema,
  useAssociateDocument,
  useUnlinkDocument,
  type DocumentSourceInput,
  type AssociateDocumentInput,
} from "@multica/core/documents";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogDescription,
} from "@multica/ui/components/ui/dialog";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";

export function AssociateDocument({
  issueId,
  projectId,
  source,
  label = "",
}: {
  issueId: string;
  projectId: string | null | undefined;
  source?: DocumentSourceInput;
  label?: string;
}) {
  const { t } = useT("squads");
  const [open, setOpen] = useState(false);
  if (!projectId)
    return (
      <p className="pipeline-metadata">
        {t(($) => $.pipeline.project_required)}
      </p>
    );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        {t(($) => $.pipeline.associate)}
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t(($) => $.pipeline.associate)}</DialogTitle>
        </DialogHeader>
        {open && (
          <AssociationForm
            issueId={issueId}
            projectId={projectId}
            source={source}
            initialLabel={label}
            onSaved={() => setOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AssociationForm({
  issueId,
  projectId,
  source,
  initialLabel,
  onSaved,
}: {
  issueId: string;
  projectId: string;
  source?: DocumentSourceInput;
  initialLabel: string;
  onSaved: () => void;
}) {
  const { t } = useT("squads");
  const wsId = useWorkspaceId();
  const [target, setTarget] = useState("");
  const [title, setTitle] = useState("");
  const [label, setLabel] = useState(initialLabel);
  const [description, setDescription] = useState("");
  const [reviewVersion, setReviewVersion] = useState<number | null>(null);
  const operation = useRef({ body: "", key: "" });
  const list = useQuery(documentGroupsOptions(wsId, projectId));
  const document = useQuery(documentDetailOptions(wsId, projectId, target));
  const [base, setBase] = useState<ProjectDocument | null>(null);
  useEffect(() => {
    if (document.data && document.data.id !== base?.id) setBase(document.data);
  }, [document.data, base?.id]);
  const associate = useAssociateDocument(wsId, projectId, issueId);
  const conflict =
    associate.error instanceof ApiError && associate.error.status === 409
      ? DocumentConflictSchema.safeParse(associate.error.body)
      : null;
  const latest = conflict?.success ? conflict.data.latest : null;
  const submit = async () => {
    if (
      associate.isPending ||
      (target && !document.data) ||
      (!target && !title.trim())
    )
      return;
    const input: Omit<AssociateDocumentInput, "idempotency_key"> & {
      document_id?: string;
      create_document?: { title: string; kind: "document" };
    } = {
      base_version: target ? (reviewVersion ?? base!.version) : 0,
      ...(target
        ? { document_id: target }
        : { create_document: { title, kind: "document" as const } }),
      ...(source ? { source, label: label || initialLabel, description } : {}),
    };
    const body = JSON.stringify(input);
    if (operation.current.body !== body)
      operation.current = { body, key: crypto.randomUUID() };
    try {
      const result = await associate.mutateAsync({
        ...input,
        idempotency_key: operation.current.key,
      } as AssociateDocumentInput);
      if (result.linked) onSaved();
    } catch {
      /* Keep all fields, the original base version and the retry key. */
    }
  };
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="block text-label">
        {t(($) => $.pipeline.target)}
        <select
          className="pipeline-select block w-full mt-2"
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
            setBase(null);
            setReviewVersion(null);
            associate.reset();
          }}
          disabled={associate.isPending}
        >
          <option value="">{t(($) => $.pipeline.new_document)}</option>
          {list.data?.documents.map((d) => (
            <option
              key={d.id}
              value={d.id}
            >{`${d.title} · v${d.version}`}</option>
          ))}
        </select>
      </label>
      {!target && (
        <label className="block text-label">
          {t(($) => $.pipeline.document_title)}
          <Input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
      )}
      {source && (
        <>
          <label className="block text-label">
            {t(($) => $.pipeline.label)}
            <Input value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="block text-label">
            {t(($) => $.pipeline.description)}
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
        </>
      )}
      {(list.isError || document.isError) && (
        <p role="alert" className="pipeline-error">
          {t(($) => $.pipeline.failed)}
        </p>
      )}
      {associate.error && (
        <p role="alert" className="pipeline-error">
          {latest
            ? t(($) => $.pipeline.link_conflict)
            : associate.error.message}
        </p>
      )}
      {latest && (
        <div className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-3 max-h-64 overflow-auto text-caption">
            <pre className="whitespace-pre-wrap break-words">{base?.body}</pre>
            <pre className="whitespace-pre-wrap break-words">{latest.body}</pre>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => setReviewVersion(latest.version)}
          >
            {t(($) => $.pipeline.review_latest)}
            {` · v${latest.version}`}
          </Button>
        </div>
      )}
      {associate.data && !associate.data.linked && (
        <p role="alert" className="pipeline-error">
          {t(($) => $.pipeline.unlink_help)}
        </p>
      )}
      <DialogFooter>
        <Button
          variant="outline"
          type="button"
          disabled={associate.isPending}
          onClick={onSaved}
        >
          {t(($) => $.pipeline.cancel)}
        </Button>
        <Button
          type="submit"
          disabled={
            associate.isPending ||
            (!!target && !base) ||
            (!target && !title.trim()) ||
            (!!latest && reviewVersion !== latest.version)
          }
          aria-busy={associate.isPending}
        >
          {t(($) => $.pipeline.submit_link)}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function IssueDocuments({
  issueId,
  projectId,
}: {
  issueId: string;
  projectId: string | null | undefined;
}) {
  const { t } = useT("squads");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const member = useCurrentMember(wsId);
  const docs = useQuery({
    ...issueDocumentsOptions(wsId, projectId ?? "", issueId),
    enabled: !!projectId,
  });
  const unlink = useUnlinkDocument(wsId, projectId ?? "", issueId);
  const [confirm, setConfirm] = useState("");
  if (!projectId) return null;
  return (
    <section className="pipeline-box space-y-3" data-testid="issue-documents">
      <h3>{t(($) => $.pipeline.documents)}</h3>
      {docs.isError && (
        <p role="alert" className="pipeline-error">
          {t(($) => $.pipeline.failed)}
        </p>
      )}
      {!docs.isLoading && !docs.data?.documents.length && (
        <p className="pipeline-metadata">{t(($) => $.pipeline.no_documents)}</p>
      )}
      {docs.data?.documents.map((d) => (
        <div key={d.id} className="pipeline-material">
          <AppLink
            className="text-caption underline"
            href={`${paths.projectDetail(projectId)}?view=docs&document=${encodeURIComponent(d.id)}`}
          >{`${d.title} · v${d.version}`}</AppLink>
          {member.member && (
            <Button variant="ghost" size="sm" onClick={() => setConfirm(d.id)}>
              {t(($) => $.pipeline.unlink)}
            </Button>
          )}
        </div>
      ))}
      {member.member && (
        <AssociateDocument issueId={issueId} projectId={projectId} />
      )}
      {unlink.error && (
        <p role="alert" className="pipeline-error">
          {unlink.error.message}
        </p>
      )}
      <Dialog
        open={!!confirm}
        onOpenChange={(v) => {
          if (!v && !unlink.isPending) setConfirm("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(($) => $.pipeline.unlink)}</DialogTitle>
            <DialogDescription>
              {t(($) => $.pipeline.unlink_help)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={unlink.isPending}
              onClick={() => setConfirm("")}
            >
              {t(($) => $.pipeline.cancel)}
            </Button>
            <Button
              disabled={unlink.isPending}
              onClick={async () => {
                try {
                  await unlink.mutateAsync(confirm);
                  setConfirm("");
                } catch {
                  /* Keep confirmation open on failure. */
                }
              }}
            >
              {t(($) => $.pipeline.unlink)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
