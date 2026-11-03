"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  canvasMetadataCapabilityRestriction,
  pipelineCapabilitiesOptions,
  pipelineCatalogAllOptions,
  pipelineDefinitionOptions,
  usePipelineInvalidation,
} from "@multica/core/pipelines";
import { Button } from "@multica/ui/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@multica/ui/components/ui/popover";
import { PipelineEditorDialog } from "./editor-dialog";
import { SquadPipeline } from "./squad-pipeline";
import { useT } from "../i18n";

type Props = Pick<
  React.ComponentProps<typeof SquadPipeline>,
  "squad" | "members" | "canManage" | "getName" | "onDirtyChange"
>;
export function SquadExecutionMode(props: Props) {
  const { squad, canManage } = props,
    { t } = useT("squads"),
    wsId = useWorkspaceId();
  const caps = useQuery(pipelineCapabilitiesOptions(wsId));
  const supported =
    caps.data?.schema_version === 1 &&
    caps.data.features.pipeline_catalog === true &&
    !canvasMetadataCapabilityRestriction(caps.data);
  const list = useQuery({
    ...pipelineCatalogAllOptions(wsId, squad.id),
    enabled: supported,
  });
  const current = useQuery(
    pipelineDefinitionOptions(wsId, squad.pipeline_definition_id ?? ""),
  );
  const [open, setOpen] = useState(false),
    [choosing, setChoosing] = useState(false),
    [selected, setSelected] = useState<string>(),
    [editor, setEditor] = useState<"new" | "existing" | null>(null);
  const selectedId =
    selected ?? current.data?.pipeline_id ?? list.data?.[0]?.id ?? "";
  const selectedPipeline = list.data?.find((p) => p.id === selectedId);
  const invalidate = usePipelineInvalidation(wsId);
  const update = useMutation({
    mutationFn: (pipelineId: string) =>
      api.updateSquad(
        squad.id,
        pipelineId === "markdown"
          ? { instructions_mode: "markdown", expected_revision: squad.revision }
          : { pipeline_id: pipelineId, expected_revision: squad.revision },
      ),
    onSuccess: () => {
      setOpen(false);
      setChoosing(false);
      void invalidate();
    },
    onError: () => {
      void invalidate();
    },
  });
  const writable =
    canManage &&
    supported &&
    !!squad.revision &&
    !update.isPending &&
    !list.isFetching &&
    !list.isError;
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-auto min-h-6 px-1 justify-start"
              disabled={!canManage || !supported}
              aria-label={t(($) => $.pipeline.mode)}
            />
          }
        >
          {squad.instructions_mode === "pipeline"
            ? t(($) => $.pipeline.title)
            : squad.instructions_mode === "markdown" || !squad.instructions_mode
              ? t(($) => $.pipeline.markdown)
              : squad.instructions_mode}
        </PopoverTrigger>
        <PopoverContent
          className="w-80 max-w-[calc(100vw-2rem)] space-y-3"
          align="start"
        >
          <label className="grid gap-1 text-caption">
            {t(($) => $.pipeline.mode)}
            <select
              className="pipeline-select w-full"
              value={
                choosing ? "pipeline" : (squad.instructions_mode ?? "markdown")
              }
              disabled={!writable}
              onChange={(e) => {
                if (!writable) return;
                if (e.target.value === "markdown") update.mutate("markdown");
                else setChoosing(true);
              }}
            >
              <option value="markdown">{t(($) => $.pipeline.markdown)}</option>
              <option value="pipeline">{t(($) => $.pipeline.title)}</option>
            </select>
          </label>
          {(choosing || squad.instructions_mode === "pipeline") && (
            <>
              {list.isFetching ? (
                <p role="status">{t(($) => $.pipeline.loading)}</p>
              ) : list.data?.length ? (
                <label className="grid gap-1 text-caption">
                  {t(($) => $.v17.choose_pipeline)}
                  <select
                    className="pipeline-select w-full"
                    value={selectedId}
                    disabled={!writable}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    {list.data.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p>{t(($) => $.v17.no_pipelines)}</p>
              )}
              <div className="pipeline-toolbar">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!writable || list.isFetching}
                  onClick={() => {
                    if (writable) {
                      setOpen(false);
                      setEditor(selectedPipeline ? "existing" : "new");
                    }
                  }}
                >
                  {selectedPipeline
                    ? t(($) => $.v17.edit_pipeline)
                    : t(($) => $.v17.preview_default)}
                </Button>
                {selectedPipeline && (
                  <Button
                    type="button"
                    size="sm"
                    disabled={
                      !writable || !selectedPipeline.executable_definition_id
                    }
                    onClick={() => {
                      if (writable && selectedPipeline.executable_definition_id)
                        update.mutate(selectedPipeline.id);
                    }}
                  >
                    {t(($) => $.v17.save_default)}
                  </Button>
                )}
              </div>
            </>
          )}
          {(list.error || update.error) && (
            <p role="alert" className="pipeline-error">
              {(list.error || update.error)?.message}
            </p>
          )}
        </PopoverContent>
      </Popover>
      {!canManage && (
        <span className="pipeline-metadata">
          {t(($) => $.execution.readonly)}
        </span>
      )}
      {canManage && !supported && !caps.isLoading && (
        <span role="status" className="pipeline-metadata">
          {t(($) => $.canvas.capability)}
        </span>
      )}
      <PipelineEditorDialog
        {...props}
        open={editor !== null}
        onOpenChange={(value) => {
          if (!value) setEditor(null);
        }}
        catalog={editor === "existing" ? selectedPipeline : undefined}
        onCreated={(result) => {
          setSelected(result.pipeline.id);
          void invalidate();
        }}
        externalBusy={update.isPending}
      />
    </>
  );
}
