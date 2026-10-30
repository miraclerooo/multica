"use client";

import type {
  DocumentDraft,
  DocumentSnapshot,
  ProjectDocument,
} from "@multica/core/documents";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { useState } from "react";

export interface DocumentComparison {
  kind: "history" | "conflict";
  left: DocumentSnapshot;
  right: ProjectDocument;
  draft?: DocumentDraft;
  base?: DocumentSnapshot;
}

export function RevisionDiff({
  comparison,
  revisions,
  pending,
  onClose,
  onCopy,
  onDiscard,
  onSaveLocal,
}: {
  comparison: DocumentComparison;
  revisions: ProjectDocument[];
  pending: boolean;
  onClose: () => void;
  onCopy: () => void;
  onDiscard: () => void;
  onSaveLocal: () => void;
}) {
  const { t } = useT("projects");
  const [leftVersion, setLeftVersion] = useState(comparison.left.version);
  const [rightVersion, setRightVersion] = useState(comparison.right.version);
  const history = comparison.kind === "history";
  const left = history
    ? (revisions.find((r) => r.version === leftVersion) ?? comparison.left)
    : comparison.left;
  const right = history
    ? (revisions.find((r) => r.version === rightVersion) ?? comparison.right)
    : comparison.right;
  const leftLines = left.body.split("\n");
  const rightLines = right.body.split("\n");
  const titleChanged = left.title !== right.title;
  const renderBody = (
    lines: string[],
    other: string[],
    side: "left" | "right",
  ) => (
    <pre className="document-diff-body">
      {lines.map((line, i) => (
        <span
          key={i}
          className={cn(
            "document-diff-line",
            line !== other[i] &&
              (side === "left"
                ? "document-diff-removed"
                : "document-diff-added"),
          )}
        >
          <span className="document-line-number" aria-hidden="true">
            {i + 1}
          </span>
          <code>{line || " "}</code>
          {"\n"}
        </span>
      ))}
    </pre>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        className="!max-w-5xl max-h-[90dvh] flex flex-col gap-0 p-0 overflow-hidden"
        showCloseButton={!pending}
      >
        <DialogHeader className="p-5 border-b shrink-0">
          <DialogTitle>{t(($) => $.documents.compare)}</DialogTitle>
          <DialogDescription>
            {t(($) => $.documents.compare_description)}
          </DialogDescription>
          {comparison.base && (
            <span className="text-caption text-muted-foreground">
              {t(($) => $.documents.based_on, {
                version: comparison.base.version,
              })}{" "}
              → {`v${comparison.right.version}`}
            </span>
          )}
        </DialogHeader>
        <div className="overflow-y-auto min-h-0 p-5 space-y-4">
          <div
            className="grid grid-cols-1 md:grid-cols-2 gap-4"
            data-testid="document-diff"
          >
            <section className="min-w-0 rounded-lg border overflow-hidden">
              <div className="flex items-center justify-between gap-2 bg-warning/10 px-4 py-2 text-label font-medium">
                {history
                  ? t(($) => $.documents.left_version)
                  : t(($) => $.documents.local)}
                {history ? (
                  <select
                    aria-label={t(($) => $.documents.left_version)}
                    value={leftVersion}
                    onChange={(e) => setLeftVersion(Number(e.target.value))}
                    className="rounded border bg-background px-1 py-0.5 text-caption"
                  >
                    {revisions.map((r) => (
                      <option key={r.version} value={r.version}>
                        {`v${r.version}`} · {r.author_name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-caption">
                    {t(($) => $.documents.based_on, {
                      version: comparison.base?.version ?? left.version,
                    })}
                  </span>
                )}
              </div>
              <div className="p-4 border-b">
                <p className="text-caption text-muted-foreground mb-2">
                  {t(($) => $.documents.title)} ·{" "}
                  {titleChanged
                    ? t(($) => $.documents.changed)
                    : t(($) => $.documents.unchanged)}
                </p>
                <p
                  className={cn(
                    "text-title-sm font-semibold break-words rounded p-2",
                    titleChanged && "document-diff-removed",
                  )}
                >
                  {left.title}
                </p>
              </div>
              {renderBody(leftLines, rightLines, "left")}
            </section>
            <section className="min-w-0 rounded-lg border overflow-hidden">
              <div className="flex items-center justify-between gap-2 bg-success/10 px-4 py-2 text-label font-medium">
                {history
                  ? t(($) => $.documents.right_version)
                  : t(($) => $.documents.remote)}
                {history ? (
                  <select
                    aria-label={t(($) => $.documents.right_version)}
                    value={rightVersion}
                    onChange={(e) => setRightVersion(Number(e.target.value))}
                    className="rounded border bg-background px-1 py-0.5 text-caption"
                  >
                    {revisions.map((r) => (
                      <option key={r.version} value={r.version}>
                        {`v${r.version}`} · {r.author_name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-caption">
                    {`v${right.version}`} · {right.author_name}
                  </span>
                )}
              </div>
              <div className="p-4 border-b">
                <p className="text-caption text-muted-foreground mb-2">
                  {t(($) => $.documents.title)} ·{" "}
                  {titleChanged
                    ? t(($) => $.documents.changed)
                    : t(($) => $.documents.unchanged)}
                </p>
                <p
                  className={cn(
                    "text-title-sm font-semibold break-words rounded p-2",
                    titleChanged && "document-diff-added",
                  )}
                >
                  {right.title}
                </p>
              </div>
              {renderBody(rightLines, leftLines, "right")}
            </section>
          </div>
          {comparison.base && (
            <details className="rounded-lg border p-3 text-caption">
              <summary className="cursor-pointer font-medium">
                {t(($) => $.documents.base)} {`v${comparison.base.version}`}
              </summary>
              <p className="mt-3 font-semibold">{comparison.base.title}</p>
              <pre className="whitespace-pre-wrap break-words mt-2 font-mono">
                {comparison.base.body}
              </pre>
            </details>
          )}
        </div>
        <DialogFooter className="border-t p-4 flex-wrap shrink-0">
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {history ? t(($) => $.documents.close) : t(($) => $.documents.keep)}
          </Button>
          {!history && (
            <>
              <Button variant="ghost" disabled={pending} onClick={onDiscard}>
                {t(($) => $.documents.discard)}
              </Button>
              <Button variant="outline" disabled={pending} onClick={onCopy}>
                {t(($) => $.documents.copy_local)}
              </Button>
              <Button
                disabled={pending}
                aria-busy={pending}
                onClick={onSaveLocal}
              >
                {t(($) => $.documents.save_local)}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
