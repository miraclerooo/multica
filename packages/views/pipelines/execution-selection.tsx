"use client";

import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { useWSEvent, useWSReconnect } from "@multica/core/realtime";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useIssueDraftStore } from "@multica/core/issues/stores/draft-store";
import {
  pipelineCapabilitiesOptions, pipelineCatalogAllOptions, pipelineDefinitionOptions,
  selectionFromPreview, type ExecutionSelection,
} from "@multica/core/pipelines";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../i18n";
import { ExecutionSummary } from "./execution-summary";

export function useExecutionSelection(squadId?: string) {
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const refresh = () => {void qc.invalidateQueries({queryKey: ["pipelines", wsId]});};
  useWSEvent("pipeline:definition_created", event => {if(event && typeof event === "object" && "squad_id" in event && event.squad_id === squadId) refresh();});
  useWSReconnect(refresh);
  const choices = useIssueDraftStore(s => s.draft.manual.executionSelections);
  const selection: ExecutionSelection = squadId ? choices?.[squadId] ?? {mode: "default"} : {mode: "default"};
  const caps = useQuery({...pipelineCapabilitiesOptions(wsId), enabled: !!squadId});
  const supported = caps.data?.features.task_execution_selection === true;
  const catalog = useQuery({...pipelineCatalogAllOptions(wsId, squadId ?? ""), enabled: !!squadId && supported});
  const definitions = useQueries({queries: (catalog.data ?? []).map(p => pipelineDefinitionOptions(wsId, p.executable_definition_id ?? ""))});
  const selected = selection.mode !== "pipeline" || catalog.data?.some(p => p.id === selection.pipeline_id && !!p.executable_definition_id);
  const preview = useQuery({
    queryKey: ["pipelines", wsId, "preflight", squadId, selection],
    queryFn: () => api.preflightPipelineExecution({squad_id: squadId!, execution: selection}),
    enabled: !!squadId && supported && !!selected,
    retry: false, staleTime: 0,
  });
  const submitSelection = selected && !preview.isFetching ? selectionFromPreview(selection, preview.data) : null;
  return {
    squadId, selection, catalog, definitions, caps, preview, supported,
    canSubmit: !squadId || (!!submitSelection && preview.data?.squad_id === squadId),
    submitSelection: squadId ? submitSelection : undefined,
    setSelection: (value: ExecutionSelection) => {
      if (!squadId) return;
      const state = useIssueDraftStore.getState();
      state.setManual({executionSelections: {...state.draft.manual.executionSelections, [squadId]: value}});
    },
  };
}

export function ExecutionSelectionField({value}: {value: ReturnType<typeof useExecutionSelection>}) {
  const {t} = useT("squads");
  if (!value.squadId) return null;
  const selected = value.selection.mode === "pipeline" ? value.selection.pipeline_id : value.selection.mode;
  return <section className="mx-4 my-2 space-y-2 min-w-0" data-testid="execution-selection">
    <label className="grid gap-1 text-label">
      {t($ => $.execution.selection)}
      <select className="pipeline-select w-full" value={selected} disabled={!value.supported}
        onChange={e => value.setSelection(e.target.value === "default" || e.target.value === "markdown"
          ? {mode: e.target.value} : {mode: "pipeline", pipeline_id: e.target.value})}>
        <option value="default">{t($ => $.execution.use_default)}</option>
        <option value="markdown">{t($ => $.execution.markdown)}</option>
        {value.catalog.data?.map((p, i) => <option key={p.id} value={p.id} disabled={!p.executable_definition_id || !value.definitions[i]?.data}>
          {p.name} · {value.definitions[i]?.data ? `v${value.definitions[i]!.data!.revision} · ${value.definitions[i]!.data!.kind}` : t($ => $.execution.no_executable)}
        </option>)}
        {value.selection.mode === "pipeline" && !value.catalog.data?.some(p => p.id === selected) && <option value={selected}>{t($ => $.execution.no_executable)}</option>}
      </select>
    </label>
    {value.caps.isLoading || value.preview.isFetching ? <p role="status" className="text-caption text-muted-foreground">{t($ => $.execution.loading)}</p>
      : !value.supported ? <p role="alert">{t($ => $.execution.unsupported)}</p>
      : value.preview.error || value.catalog.error ? <p role="alert" className="text-caption text-destructive">{(value.preview.error ?? value.catalog.error)?.message}</p>
      : value.preview.data ? <ExecutionSummary execution={value.preview.data} /> : <p role="status">{t($ => $.execution.failed)}</p>}
    <Button type="button" size="sm" variant="ghost" disabled={value.preview.isFetching} onClick={() => {
      void value.caps.refetch(); void value.catalog.refetch(); void value.preview.refetch();
    }}>{t($ => $.execution.recheck)}</Button>
  </section>;
}
