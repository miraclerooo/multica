"use client";
import { useWSEvent, useWSReconnect } from "@multica/core/realtime";

import { useRef, useState } from "react";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { pipelineCatalogAllOptions, pipelineCapabilitiesOptions, pipelineDefinitionOptions, putPipelineDraft, usePipelineDraftStore, usePipelineInvalidation, useRenamePipelineCatalog, reviewPipelineDraft } from "@multica/core/pipelines";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { useT } from "../i18n";
import { SquadPipeline } from "./squad-pipeline";

export function SquadPipelineCatalog(props: React.ComponentProps<typeof SquadPipeline>) {
  const {squad, canManage} = props;
  const {t} = useT("squads");
  const wsId = useWorkspaceId();
  const caps = useQuery(pipelineCapabilitiesOptions(wsId));
  const list = useQuery({...pipelineCatalogAllOptions(wsId, squad.id), enabled: caps.data?.features.pipeline_catalog === true});
  const bound = useQuery(pipelineDefinitionOptions(wsId, squad.pipeline_definition_id ?? ""));
  const [selected, setSelected] = useState<string | null>(null);
  const id = selected ?? bound.data?.pipeline_id ?? list.data?.[0]?.id ?? "";
  const catalog = list.data?.find(p => p.id === id);
  const [renaming, setRenaming] = useState("");
  const [renamingId, setRenamingId] = useState("");
  const [renameRevision, setRenameRevision] = useState<number>();
  const draftKey = `${wsId}:${squad.id}:new`;
  const draft = usePipelineDraftStore(s => s.draft.drafts[draftKey]);
  const newName = draft?.name ?? "";
  const invalidate = usePipelineInvalidation(wsId);
  useWSEvent("pipeline:definition_created", event => {if(event && typeof event === "object" && "squad_id" in event && event.squad_id === squad.id) void invalidate();});
  useWSReconnect(() => {void invalidate();});
  const rename = useRenamePipelineCatalog(wsId, catalog?.id ?? "");
  const defaults = useMutation({mutationFn: (value: string) => api.updateSquad(squad.id, value === "markdown"
    ? {instructions_mode: "markdown", expected_revision: squad.revision}
    : {pipeline_id: value, expected_revision: squad.revision}), onSuccess: invalidate, onError: () => {void invalidate();}});
  const definitions = useQueries({queries: (list.data ?? []).map(p => pipelineDefinitionOptions(wsId, p.executable_definition_id ?? ""))});
  const nameInput = useRef<HTMLInputElement>(null);
  const newPipeline = () => {setSelected(""); requestAnimationFrame(() => nameInput.current?.focus());};
  const supported = caps.data?.features.pipeline_catalog === true;
  const error = list.error ?? defaults.error ?? rename.error;
  return <div className="p-4 space-y-4 min-w-0" data-testid="pipeline-catalog">
    <div className="pipeline-box space-y-3">
      <div className="pipeline-toolbar justify-between">
        <h2 className="text-title font-semibold">{t($ => $.execution.catalog)}</h2>
        <Button type="button" size="sm" disabled={!canManage || !supported} onClick={newPipeline}>{t($ => $.execution.new_pipeline)}</Button>
      </div>
      {!canManage && <p className="text-caption">{t($ => $.execution.readonly)}</p>}
      {!supported && !caps.isLoading && <p role="status">{t($ => $.execution.unsupported)}</p>}
      {error && <p role="alert" className="text-caption text-destructive">{error.message}</p>}
      {rename.error && catalog && <div className="space-y-2 text-caption">
        <p>{t($ => $.pipeline.latest)}: {catalog.name}</p>
        <Button variant="outline" size="sm" disabled={list.isFetching} onClick={() => setRenameRevision(catalog.revision)}>{t($ => $.pipeline.review_latest)}</Button>
      </div>}
      <label className="grid gap-1 text-caption">{t($ => $.execution.default_mode)}
        <select className="pipeline-select w-full" value={squad.instructions_mode === "markdown" || !squad.instructions_mode ? "markdown" : bound.data?.pipeline_id ?? "__choose__"}
          disabled={!canManage || !supported || !squad.revision || defaults.isPending} onChange={e => {
            if (!canManage || !supported || !squad.revision || defaults.isPending) return;
            if (e.target.value === "__choose__") {newPipeline(); return;}
            defaults.mutate(e.target.value);
          }}>
          <option value="markdown">{t($ => $.execution.markdown)}</option>
          <option value="__choose__">{t($ => $.execution.choose_default)}</option>
          {list.data?.map((p, i) => <option key={p.id} value={p.id} disabled={!p.executable_definition_id || !definitions[i]?.data}>{p.name} · {definitions[i]?.data ? `v${definitions[i]!.data!.revision}` : t($ => $.execution.no_executable)}</option>)}
        </select>
      </label>
      {supported && !squad.revision && <p role="status">{t($ => $.execution.failed)}</p>}
      {defaults.isSuccess && <p role="status" className="text-caption">{t($ => $.execution.default_saved)}</p>}
      <label className="grid gap-1 text-caption">{t($ => $.execution.catalog)}
        <select className="pipeline-select w-full" value={id} onChange={e => {setSelected(e.target.value); setRenamingId("");}}>
          <option value="">{t($ => $.execution.new_pipeline)}</option>
          {list.data?.map((p,i) => <option key={p.id} value={p.id}>{p.name} · {definitions[i]?.data ? `v${definitions[i]!.data!.revision} · ${definitions[i]!.data!.kind}` : t($ => $.execution.no_executable)}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-caption grow">{t($ => $.execution.name)}
          <Input ref={nameInput} maxLength={200} value={catalog ? renamingId === catalog.id ? renaming : catalog.name : newName}
            disabled={!canManage || !supported || rename.isPending} onChange={e => {
              if (catalog) {if (renamingId !== catalog.id) setRenameRevision(catalog.revision);setRenamingId(catalog.id);setRenaming(e.target.value);}
              else putPipelineDraft(draftKey, draft?.source ?? "", "", squad.revision, {name: e.target.value});
            }} />
        </label>
        {catalog && canManage && <Button type="button" size="sm" variant="outline" disabled={!supported || rename.isPending || renamingId !== catalog.id || !renaming.trim()}
          onClick={() => {if (!canManage || !supported || rename.isPending || !renaming.trim()) return;rename.mutate({name: renaming.trim(), expected_revision: renameRevision ?? catalog.revision}, {onError: () => {void invalidate();}, onSuccess: updated => {
            const key = `${wsId}:${squad.id}:${catalog.id}`;
            const draft = usePipelineDraftStore.getState().draft.drafts[key];
            if (draft && draft.catalogRevision === catalog.revision) reviewPipelineDraft(key, squad.revision ?? 0, updated.revision);
            setRenamingId("");
          }});}}>{t($ => $.execution.rename)}</Button>}
      </div>
    </div>
    {supported && list.isSuccess && (!id || catalog) && <SquadPipeline {...props} key={`${squad.id}:${id}`} catalog={catalog} newName={newName} externalBusy={rename.isPending || defaults.isPending}
      onCreated={result => {setSelected(result.pipeline.id); void invalidate();}} />}
  </div>;
}
