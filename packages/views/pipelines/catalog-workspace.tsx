"use client";
import { useWSEvent, useWSReconnect } from "@multica/core/realtime";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  canvasMetadataCapabilityRestriction,
  pipelineCandidatesOptions,
  pipelineCatalogAllOptions,
  pipelineCapabilitiesOptions,
  pipelineDefinitionOptions,
  usePipelineInvalidation,
  useRenamePipelineCatalog,
  reviewPipelineDraft,
  usePipelineDraftStore,
} from "@multica/core/pipelines";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { useT } from "../i18n";
import { SquadPipeline } from "./squad-pipeline";
import { PipelineEditorDialog } from "./editor-dialog";
import { FlowGraph } from "./flow-graph";

export function SquadPipelineCatalog(
  props: React.ComponentProps<typeof SquadPipeline>,
) {
  const { squad, canManage } = props,
    { t } = useT("squads"),
    wsId = useWorkspaceId();
  const caps = useQuery(pipelineCapabilitiesOptions(wsId));
  const list = useQuery({
    ...pipelineCatalogAllOptions(wsId, squad.id),
    enabled: caps.data?.features.pipeline_catalog === true,
  });
  const bound = useQuery(
    pipelineDefinitionOptions(wsId, squad.pipeline_definition_id ?? ""),
  );
  const [selected, setSelected] = useState<string>(),
    [editing, setEditing] = useState<"new" | "current" | null>(null);
  const id = selected ?? bound.data?.pipeline_id ?? list.data?.[0]?.id ?? "",
    catalog = list.data?.find((p) => p.id === id);
  const definition = useQuery(
    pipelineDefinitionOptions(wsId, catalog?.executable_definition_id ?? ""),
  );
  const [renaming, setRenaming] = useState<{
    id: string;
    name: string;
    revision: number;
  } | null>(null);
  const rename = useRenamePipelineCatalog(wsId, id),
    invalidate = usePipelineInvalidation(wsId);
  const supported =
    caps.data?.schema_version === 1 &&
    caps.data.features.pipeline_catalog === true &&
    !canvasMetadataCapabilityRestriction(caps.data);
  const candidates = useQuery({
    ...pipelineCandidatesOptions(wsId, squad.id),
    enabled: supported,
  });
  useWSEvent("pipeline:definition_created", (event) => {
    if (
      event &&
      typeof event === "object" &&
      "squad_id" in event &&
      event.squad_id === squad.id
    )
      void invalidate();
  });
  useWSReconnect(() => {
    void invalidate();
  });
  return (
    <div className="p-4 space-y-4 min-w-0" data-testid="pipeline-catalog">
      <div className="pipeline-box space-y-3">
        <div className="pipeline-toolbar justify-between">
          <h2 className="text-title font-semibold">
            {t(($) => $.execution.catalog)}
          </h2>
          <div className="pipeline-toolbar">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!catalog || !definition.data}
              onClick={() => {
                if (catalog && definition.data) setEditing("current");
              }}
            >
              {t(($) => $.v17.edit_pipeline)}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canManage || !supported}
              onClick={() => {
                if (canManage && supported) setEditing("new");
              }}
            >
              {t(($) => $.v17.new_pipeline)}
            </Button>
          </div>
        </div>
        {!canManage && (
          <p role="status" className="pipeline-metadata">
            {t(($) => $.execution.readonly)}
          </p>
        )}
        {!supported && !caps.isLoading && (
          <p role="status">{t(($) => $.canvas.capability)}</p>
        )}
        {list.isLoading ? (
          <p role="status">{t(($) => $.pipeline.loading)}</p>
        ) : list.data?.length ? (
          <label className="grid gap-1 text-caption">
            {t(($) => $.v17.choose_pipeline)}
            <select
              className="pipeline-select w-full"
              value={id}
              onChange={(e) => {
                setSelected(e.target.value);
                setRenaming(null);
              }}
            >
              {list.data.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.id === id && definition.data
                    ? ` · v${definition.data.revision}`
                    : ""}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p role="status">{t(($) => $.v17.no_pipelines)}</p>
        )}
        {(list.error || rename.error) && (
          <p role="alert" className="pipeline-error">
            {(list.error || rename.error)?.message}
          </p>
        )}
        {catalog && canManage && (
          <div className="pipeline-toolbar">
            <label className="grid gap-1 text-caption grow">
              {t(($) => $.execution.name)}
              <Input
                value={renaming?.id === id ? renaming.name : catalog.name}
                disabled={!supported || rename.isPending}
                onChange={(e) => {
                  if (supported && !rename.isPending)
                    setRenaming({
                      id,
                      name: e.target.value,
                      revision:
                        renaming?.id === id
                          ? renaming.revision
                          : catalog.revision,
                    });
                }}
              />
            </label>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                !supported ||
                rename.isPending ||
                renaming?.id !== id ||
                !renaming.name.trim()
              }
              onClick={() => {
                if (
                  !canManage ||
                  !supported ||
                  rename.isPending ||
                  !renaming?.name.trim()
                )
                  return;
                rename.mutate(
                  {
                    name: renaming.name.trim(),
                    expected_revision: renaming.revision,
                  },
                  {
                    onSuccess: (updated) => {
                      const key = `${wsId}:${squad.id}:${id}`;
                      const d =
                        usePipelineDraftStore.getState().draft.drafts[key];
                      if (d?.catalogRevision === catalog.revision)
                        reviewPipelineDraft(
                          key,
                          squad.revision ?? 0,
                          updated.revision,
                        );
                      setRenaming(null);
                    },
                  },
                );
              }}
            >
              {t(($) => $.execution.rename)}
            </Button>
            {rename.error && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (renaming)
                    setRenaming({ ...renaming, revision: catalog.revision });
                }}
              >
                {t(($) => $.pipeline.review_latest)}
              </Button>
            )}
          </div>
        )}
      </div>
      {definition.data && (
        <>
          <FlowGraph
            plan={definition.data.plan}
            onSelect={() => setEditing("current")}
            describeNode={(n) =>
              n.type === "manual"
                ? candidates.data?.humans.find(
                    (h) => h.user_id === n.owner_user_id,
                  )?.name ||
                  n.owner ||
                  t(($) => $.v17.no_owner)
                : n.agent_id
                  ? candidates.data?.agents.find(
                      (a) => a.agent_id === n.agent_id,
                    )?.name || t(($) => $.v17.binding_unavailable)
                  : n.role || t(($) => $.pipeline.leader)
            }
          />
          <section className="pipeline-box space-y-3">
            <h3>{t(($) => $.v17.files)}</h3>
            <p className="pipeline-metadata">{t(($) => $.pipeline.declared)}</p>
            {definition.data.plan.nodes.flatMap((n) =>
              n.deliverables.map((file) => (
                <div key={`${n.id}:${file.path}`} className="space-y-1">
                  <strong>{file.name}</strong>
                  <p className="whitespace-pre-wrap break-words">
                    {file.description}
                  </p>
                  <p className="pipeline-metadata">
                    {n.title} · {file.path}
                  </p>
                </div>
              )),
            )}
          </section>
        </>
      )}
      {definition.isError && <p role="alert">{t(($) => $.pipeline.failed)}</p>}
      <PipelineEditorDialog
        {...props}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        catalog={editing === "current" ? catalog : undefined}
        onCreated={(result) => {
          setSelected(result.pipeline.id);
          void invalidate();
        }}
        externalBusy={rename.isPending}
      />
    </div>
  );
}
