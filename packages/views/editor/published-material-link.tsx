"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { useT } from "../i18n";

export function PublishedMaterialLink({
  href,
  path,
  children,
  renderMarkdown,
}: {
  href: string;
  path: string;
  children: ReactNode;
  renderMarkdown: (text: string) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </a>
      {open && (
        <PublishedMaterialDialog
          path={path}
          onClose={() => setOpen(false)}
          renderMarkdown={renderMarkdown}
        />
      )}
    </>
  );
}

export function PublishedMaterialDialog({
  path,
  onClose,
  renderMarkdown,
}: {
  path: string;
  onClose: () => void;
  renderMarkdown: (text: string) => ReactNode;
}) {
  const { t } = useT("squads");
  const wsId = useWorkspaceId();
  const [text, setText] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const content = useQuery({
    queryKey: ["published-material", wsId, path],
    queryFn: () => api.getPublishedMaterialContent(path),
    staleTime: 0,
  });
  useEffect(() => {
    if (!content.data) return;
    const objectUrl = URL.createObjectURL(content.data);
    setUrl(objectUrl);
    if (
      content.data.type.startsWith("text/") &&
      !content.data.type.includes("html")
    )
      void content.data.text().then(setText);
    return () => URL.revokeObjectURL(objectUrl);
  }, [content.data]);
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t(($) => $.pipeline.pinned)}</DialogTitle>
        </DialogHeader>
        {content.error ? (
          <p role="alert" className="text-caption text-destructive">
            {content.error.message}
          </p>
        ) : content.isLoading ? (
          <p aria-busy="true">{t(($) => $.pipeline.loading)}</p>
        ) : text !== null ? (
          <div className="max-h-[65dvh] overflow-y-auto">
            {renderMarkdown(text)}
          </div>
        ) : content.data?.type.startsWith("text/") &&
          !content.data.type.includes("html") ? (
          <p aria-busy="true">{t(($) => $.pipeline.loading)}</p>
        ) : url ? (
          <iframe
            title={t(($) => $.pipeline.artifacts)}
            sandbox="allow-scripts"
            src={url}
            className="w-full h-[65dvh]"
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
