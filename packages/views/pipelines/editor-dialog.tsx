"use client";

import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  canvasMetadataCapabilityRestriction,
  defaultPipelineSource,
  pipelineCapabilitiesOptions,
  pipelineCandidatesOptions,
  putPipelineDraft,
  usePipelineDraftStore,
} from "@multica/core/pipelines";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@multica/ui/components/ui/dialog";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { SquadPipeline } from "./squad-pipeline";
import { useT } from "../i18n";

export function PipelineEditorDialog({
  open,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof SquadPipeline> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("squads"),
    wsId = useWorkspaceId();
  const { squad, catalog, onDirtyChange } = props;
  const key = `${wsId}:${squad.id}:${catalog?.id ?? "new"}`;
  const draft = usePipelineDraftStore((s) => s.draft.drafts[key]);
  const caps = useQuery(pipelineCapabilitiesOptions(wsId));
  const supported =
    caps.data?.schema_version === 1 &&
    caps.data.features.pipeline_catalog === true &&
    !canvasMetadataCapabilityRestriction(caps.data);
  const candidates = useQuery({
    ...pipelineCandidatesOptions(wsId, squad.id),
    enabled: open && !catalog && supported,
  });
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [confirmClose, setConfirmClose] = useState(false);
  const handleDirty = useCallback(
    (value: boolean) => {
      setDirty(value);
      onDirtyChange(value);
    },
    [onDirtyChange],
  );
  useEffect(() => {
    if (
      !open ||
      catalog ||
      draft ||
      !candidates.data ||
      !supported ||
      !props.canManage
    )
      return;
    const text = defaultPipelineSource(candidates.data.default_owner_user_id, [
      {
        title: t(($) => $.v17.plan),
        instructions: t(($) => $.v17.plan_instructions),
        fileName: "plan.md",
        description: t(($) => $.v17.plan_description),
      },
      {
        title: t(($) => $.v17.implement),
        instructions: t(($) => $.v17.implement_instructions),
        fileName: "implementation.md",
        description: t(($) => $.v17.implement_description),
      },
      {
        title: t(($) => $.v17.verify),
        instructions: t(($) => $.v17.verify_instructions),
        fileName: "verification.md",
        description: t(($) => $.v17.verify_description),
      },
      { title: t(($) => $.v17.approve), instructions: "" },
    ]);
    putPipelineDraft(key, text, "", squad.revision, {
      name: t(($) => $.v17.default_workflow),
    });
  }, [
    open,
    catalog,
    draft,
    candidates.data,
    supported,
    props.canManage,
    key,
    squad.revision,
    t,
  ]);
  const close = () => {
    if (busy) return;
    if (dirty) {
      setConfirmClose(true);
      return;
    }
    onOpenChange(false);
  };
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (value) onOpenChange(true);
          else close();
        }}
      >
        <DialogContent
          className="sm:max-w-6xl max-h-[94dvh] overflow-y-auto"
          data-testid="pipeline-editor-dialog"
        >
          <DialogHeader>
            <DialogTitle>
              {catalog
                ? t(($) => $.v17.edit_pipeline)
                : t(($) => $.v17.new_pipeline)}
              {catalog ? ` · ${catalog.name}` : ""}
            </DialogTitle>
          </DialogHeader>
          {!catalog && (
            <label className="grid gap-1 text-caption">
              {t(($) => $.execution.name)}
              <Input
                maxLength={200}
                value={draft?.name ?? ""}
                disabled={!props.canManage || !supported || busy || !draft}
                onChange={(e) => {
                  if (props.canManage && supported && !busy)
                    putPipelineDraft(
                      key,
                      draft?.source ?? "",
                      "",
                      squad.revision,
                      { name: e.target.value },
                    );
                }}
              />
            </label>
          )}
          {!catalog && !draft ? (
            <div role="status" className="space-y-2">
              <p>
                {candidates.isFetching
                  ? t(($) => $.pipeline.loading)
                  : !supported
                    ? t(($) => $.canvas.capability)
                    : t(($) => $.v17.candidates_unavailable)}
              </p>
              {supported && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={candidates.isFetching}
                  onClick={() => void candidates.refetch()}
                >
                  {t(($) => $.pipeline.refresh)}
                </Button>
              )}
            </div>
          ) : (
            <SquadPipeline
              key={`${squad.id}:${catalog?.id ?? "new"}`}
              {...props}
              newName={draft?.name ?? ""}
              onDirtyChange={handleDirty}
              onBusyChange={setBusy}
              onSaved={() => {
                props.onSaved?.();
                onOpenChange(false);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(($) => $.v17.close_draft_title)}</DialogTitle>
            <DialogDescription>
              {t(($) => $.v17.close_draft_help)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmClose(false)}
            >
              {t(($) => $.v17.continue_editing)}
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (!busy) {
                  setConfirmClose(false);
                  onOpenChange(false);
                }
              }}
            >
              {t(($) => $.v17.keep_close)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
