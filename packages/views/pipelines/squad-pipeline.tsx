"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  workspaceKeys,
  agentListOptions,
} from "@multica/core/workspace/queries";
import {
  bindPipelineRole,
  adoptLegacyPipelineDraft,
  movePipelineDraftScope,
  clearPipelineDraft,
  extractPipelineDraft,
  pipelineCapabilitiesOptions,
  pipelineDefinitionOptions,
  pipelineDefinitionsOptions,
  pipelineSourceKind,
  putPipelineDraft,
  reviewPipelineDraft,
  usePipelineWorkbenchStore,
  editPipelineWorkbench,
  useCreatePipelineDefinition,
  useCreatePipelineCatalog,
  type PipelineCatalog,
  type PipelineCatalogCreateResult,
  usePipelineDraftStore,
  type PipelineValidation,
} from "@multica/core/pipelines";
import type { Squad, SquadMember } from "@multica/core/types";
import { chatKeys, pendingChatTaskOptions } from "@multica/core/chat/queries";
import { useWSEvent } from "@multica/core/realtime";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { copyText } from "@multica/ui/lib/clipboard";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@multica/ui/components/ui/dialog";
import { useT } from "../i18n";
import { ReadonlyContent } from "../editor";
import { FlowGraph } from "./flow-graph";
import { PipelineHistory } from "./run-details";
import "./pipelines.css";

export function SquadPipeline({
  squad,
  members,
  canManage,
  getName,
  onDirtyChange,
  catalog, newName = "", onCreated, externalBusy = false,
}: {
  externalBusy?: boolean;
  catalog?: PipelineCatalog;
  newName?: string;
  onCreated?: (result: PipelineCatalogCreateResult) => void;
  squad: Squad;
  members: SquadMember[];
  canManage: boolean;
  getName: (type: string, id: string) => string;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useT("squads");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const caps = useQuery(pipelineCapabilitiesOptions(wsId));
  const [offset, setOffset] = useState(0);
  const versions = useQuery(
    {...pipelineDefinitionsOptions(wsId, { squad_id: squad.id, pipeline_id: catalog?.id, limit: 50, offset }), enabled: !!catalog},
  );
  const key = `${wsId}:${squad.id}:${catalog?.id ?? "new"}`;
  const [openedId, setOpenedId] = useState(usePipelineDraftStore.getState().draft.drafts[key]?.baseId || catalog?.executable_definition_id || "");
  const current = useQuery(pipelineDefinitionOptions(wsId, openedId));
  useEffect(() => {
    const from = `${wsId}:${squad.id}`;
    const drafts = usePipelineDraftStore.getState().draft.drafts;
    if(catalog?.legacy) {
      const base = !drafts[key] ? drafts[from]?.baseId : undefined;
      adoptLegacyPipelineDraft(from, key);
      if(base) setOpenedId(base);
    }
  }, [wsId, squad.id, key, catalog?.legacy]);
  useEffect(() => {if (catalog && !openedId && versions.data?.items[0]) setOpenedId(versions.data.items[0].id);}, [catalog, openedId, versions.data]);
  const draft = usePipelineDraftStore((s) => s.draft.drafts[key]);
  const source = draft?.source ?? current.data?.source ?? "";
  const kind = pipelineSourceKind(source);
  const [tab, setTab] = useState("definition");
  const [view, setView] = useState("yaml");
  const [selected, setSelected] = useState("");
  const [switchKind, setSwitchKind] = useState("");
  const [showMika, setShowMika] = useState(false);
  const [comparison, setComparison] = useState(false);
  const [comparisonSource, setComparisonSource] = useState<
    string | undefined
  >();
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const operation = useRef({ body: "", key: "" });
  const create = useCreatePipelineDefinition(wsId);
  const createCatalog = useCreatePipelineCatalog(wsId);
  const edit = (value: string) => {
    putPipelineDraft(key, value, openedId, squad.revision, {catalogRevision: catalog?.revision});
    setSaved("");
    setError("");
  };
  const [validatedSource, setValidatedSource] = useState(source);
  useEffect(() => {
    const timer = setTimeout(() => setValidatedSource(source), 300);
    return () => clearTimeout(timer);
  }, [source]);
  const validation = useQuery({
    queryKey: ["pipeline-validation", wsId, squad.id, validatedSource],
    queryFn: () =>
      api.validatePipeline({ source: validatedSource, squad_id: squad.id }),
    enabled:
      !!validatedSource &&
      !!caps.data?.kinds.includes(pipelineSourceKind(validatedSource)),
    retry: false,
  });
  const validationSource =
    validatedSource === source ? validation.data : undefined;
  const valid =
    validationSource?.syntax_valid === true && !validation.isFetching;
  useEffect(() => {
    onDirtyChange(!!draft);
    return () => onDirtyChange(false);
  }, [draft, onDirtyChange]);
  useEffect(() => {
    if (!draft) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft]);
  const binding = useMutation({
    mutationFn: (data: {
      instructions_mode: "markdown" | "pipeline";
      pipeline_definition_id?: string;
    }) =>
      api.updateSquad(squad.id, { ...data, expected_revision: squad.revision }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: workspaceKeys.squads(wsId) }),
    onError: (err) =>
      setError(
        err instanceof Error ? err.message : t(($) => $.pipeline.failed),
      ),
  });
  const sourceReady = !catalog || !!draft || !!current.data;
  const busy = !sourceReady || externalBusy || create.isPending || createCatalog.isPending || binding.isPending;
  const save = async (activate: boolean) => {
    if (!canManage || !valid || busy || (!catalog && !newName.trim())) return;
    setError("");
    const body = {
      source,
      squad_id: squad.id,
      activate,
      ...(catalog ? {pipeline_id: catalog.id, expected_pipeline_revision: draft?.catalogRevision ?? catalog.revision} : {name: newName.trim()}),
      ...(activate
        ? { expected_revision: draft?.baseRevision ?? squad.revision }
        : {}),
    };
    const fingerprint = JSON.stringify(body);
    if (operation.current.body !== fingerprint)
      operation.current = {
        body: fingerprint,
        key: draft
          ? `${draft.operationKey}:${activate ? "activate" : "save"}:${activate ? (draft.baseRevision ?? squad.revision) : ""}`
          : crypto.randomUUID(),
      };
    try {
      const input = {...body, idempotency_key: operation.current.key};
      const result = !catalog ? await createCatalog.mutateAsync({...input, name: newName.trim()}) : null;
      const doc = result?.definition ?? await create.mutateAsync(input);
      if (!doc) throw new Error(t(($) => $.pipeline.failed));
      operation.current = { body: "", key: "" };
      setOpenedId(doc.id);
      setSaved(`v${doc.revision}`);
      if (usePipelineDraftStore.getState().draft.drafts[key]?.source === source)
        clearPipelineDraft(key);
      void versions.refetch();
      if (result) {movePipelineDraftScope(key, `${wsId}:${squad.id}:${result.pipeline.id}`); onCreated?.(result);}
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t(($) => $.pipeline.failed),
      );
      setComparisonSource(undefined);
      setComparison(true);
    }
  };
  const plan = validationSource?.plan;
  const node = plan?.nodes.find((n) => n.id === selected);
  const preserveAndOpen = (id: string) => {
    if (draft) putPipelineDraft(`${key}:retained`, source, openedId);
    clearPipelineDraft(key);
    setOpenedId(id);
    setError("");
  };
  return (
    <section
      className="pipeline-panel space-y-4"
      data-testid="squad-pipeline"
    >
      <div className="pipeline-toolbar justify-between">
        <div className="pipeline-toolbar">
          <Button
            size="sm"
            variant={tab === "definition" ? "secondary" : "ghost"}
            onClick={() => setTab("definition")}
          >
            {t(($) => $.pipeline.definition)}
          </Button>
          <Button
            size="sm"
            variant={tab === "runs" ? "secondary" : "ghost"}
            onClick={() => setTab("runs")}
          >
            {t(($) => $.pipeline.runs)}
          </Button>
        </div>

      </div>
      {!canManage && (
        <p className="pipeline-metadata">{t(($) => $.pipeline.readonly)}</p>
      )}
      {!sourceReady && <p role="status" className="text-caption">{current.isFetching || versions.isFetching ? t(($) => $.pipeline.loading) : t(($) => $.pipeline.failed)}</p>}
      {tab === "runs" ? (
        <PipelineHistory squadId={squad.id} />
      ) : (
        <>
          <div className="pipeline-toolbar">
            <label className="pipeline-metadata">
              {t(($) => $.pipeline.dialect)}{" "}
              <select
                className="pipeline-select"
                aria-label={t(($) => $.pipeline.dialect)}
                value={source ? kind : ""}
                disabled={!canManage || busy}
                onChange={(e) => setSwitchKind(e.target.value)}
              >
                {!source && (
                  <option value="">{t(($) => $.pipeline.new_empty)}</option>
                )}
                {source && !caps.data?.kinds.includes(kind) && (
                  <option value={kind}>{kind}</option>
                )}
                {caps.data?.kinds.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="sm"
              variant={view === "yaml" ? "secondary" : "ghost"}
              onClick={() => setView("yaml")}
            >
              {t(($) => $.pipeline.yaml)}
            </Button>
            <Button
              size="sm"
              variant={view === "graph" ? "secondary" : "ghost"}
              onClick={() => setView("graph")}
            >
              {t(($) => $.pipeline.graph)}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void copyText(source)}
              disabled={!source}
            >
              {t(($) => $.pipeline.copy)}
            </Button>
            {canManage && (
              <label className="pipeline-metadata cursor-pointer">
                {t(($) => $.pipeline.import)}
                <input
                  className="sr-only"
                  type="file"
                  accept=".yaml,.yml,text/yaml"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      if (draft)
                        putPipelineDraft(`${key}:retained`, source, openedId);
                      edit(await file.text());
                    }
                    e.target.value = "";
                  }}
                />
              </label>
            )}
            <span className="ml-auto pipeline-metadata" role="status">
              {draft
                ? t(($) => $.pipeline.dirty)
                : saved || (current.data ? `v${current.data.revision}` : "")}
            </span>
          </div>
          {view === "yaml" ? (
            <textarea
              ref={input}
              className="pipeline-source"
              spellCheck={false}
              aria-label={t(($) => $.pipeline.yaml)}
              value={source}
              readOnly={!canManage || busy}
              onChange={(e) => edit(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                  e.preventDefault();
                  void save(false);
                }
              }}
            />
          ) : plan ? (
            <FlowGraph plan={plan} selected={selected} onSelect={setSelected} />
          ) : (
            <p className="pipeline-metadata">{t(($) => $.pipeline.empty)}</p>
          )}
          {!!source && caps.data && !caps.data.kinds.includes(kind) && (
            <p role="alert" className="pipeline-error">
              {t(($) => $.pipeline.unsupported)} ({kind})
            </p>
          )}
          {(validation.isError || caps.isError || current.isError) && (
            <p role="alert" className="pipeline-error">
              {t(($) => $.pipeline.failed)}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void validation.refetch();
                  void caps.refetch();
                  void current.refetch();
                }}
              >
                {t(($) => $.pipeline.refresh)}
              </Button>
            </p>
          )}
          <div aria-live="polite" className="space-y-2">
            {validationSource?.diagnostics.map((d, i) => (
              <button
                key={i}
                type="button"
                className="block text-left text-caption text-destructive"
                onClick={() => {
                  setView("yaml");
                  requestAnimationFrame(() => {
                    const textarea = input.current;
                    if (!textarea) return;
                    const pos =
                      source
                        .split("\n")
                        .slice(0, Math.max(0, d.line - 1))
                        .join("\n").length + Math.max(0, d.column - 1);
                    textarea.focus();
                    textarea.setSelectionRange(pos, pos);
                    textarea.scrollTop = Math.max(0, d.line - 3) * 24;
                  });
                }}
              >{`${d.line}:${d.column} · ${d.code} · ${d.message}${d.suggestion ? ` · ${d.suggestion}` : ""}`}</button>
            ))}
          </div>
          {plan && (
            <details className="pipeline-box" open={!!node}>
              <summary className="text-label font-medium cursor-pointer">
                {t(($) => $.pipeline.bindings)}
              </summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {plan.nodes.map((n) => (
                  <label
                    key={n.id}
                    className="pipeline-metadata flex flex-col gap-1"
                  >
                    {n.title || n.id}
                    {n.type === "manual" ? (
                      <span>
                        {t(($) => $.pipeline.manual)}
                        {n.owner ? ` · ${n.owner}` : ""}
                      </span>
                    ) : (
                      <select
                        className="pipeline-select"
                        value={n.role}
                        disabled={!canManage || busy}
                        onChange={(e) => {
                          try {
                            edit(bindPipelineRole(source, n, e.target.value));
                          } catch (err) {
                            setError(String(err));
                          }
                        }}
                      >
                        <option value="">
                          {t(($) => $.pipeline.leader)} ·{" "}
                          {getName("agent", squad.leader_id)}
                        </option>
                        {n.role &&
                          !members.some(
                            (m) =>
                              m.role === n.role && m.member_type === "agent",
                          ) && <option value={n.role}>{n.role}</option>}
                        {members
                          .filter((m) => m.member_type === "agent" && !!m.role)
                          .map((m) => (
                            <option key={m.id} value={m.role}>
                              {m.role} · {getName(m.member_type, m.member_id)}
                            </option>
                          ))}
                      </select>
                    )}
                  </label>
                ))}
              </div>
            </details>
          )}
          {node && (
            <div className="pipeline-box">
              <h3>{node.title || node.id}</h3>
              <pre className="whitespace-pre-wrap break-words text-caption">
                {node.instructions}
              </pre>
              <p className="pipeline-metadata mt-3">
                {t(($) => $.pipeline.dependencies)}:{" "}
                {[...new Set([...node.needs, ...node.artifact_sources])].join(
                  ", ",
                ) || "—"}
              </p>
            </div>
          )}
          {canManage && (
            <div className="pipeline-toolbar">
              <Button
                variant="outline"
                size="sm"
                disabled={!source || validation.isFetching}
                onClick={() => void validation.refetch()}
              >
                {t(($) => $.pipeline.validate)}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!valid || busy || (!catalog && !newName.trim())}
                onClick={() => void save(false)}
              >
                {t(($) => $.pipeline.save)}
              </Button>
              <Button
                size="sm"
                disabled={
                  !valid ||
                  (!catalog && !newName.trim()) ||
                  validationSource?.binding_valid !== true ||
                  busy ||
                  !squad.revision
                }
                aria-busy={busy}
                onClick={() => void save(true)}
              >
                {t(($) => $.pipeline.activate)}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowMika(true)}
              >
                {t(($) => $.pipeline.mika)}
              </Button>
            </div>
          )}
          <p className="pipeline-metadata">
            {t(($) => $.pipeline.definition_note)}
          </p>
          <details className="pipeline-box">
            <summary className="text-label font-medium cursor-pointer">
              {t(($) => $.pipeline.history)}
            </summary>
            <div className="mt-3 space-y-3">
              {versions.data?.items.map((version) => (
                <div
                  key={version.id}
                  className="pipeline-toolbar justify-between"
                >
                  <span className="pipeline-metadata">
                    {`v${version.revision} · ${version.kind} · ${getName("member", version.creator_id)} · ${version.created_at}`}{" "}
                    {version.id === squad.pipeline_definition_id && "✓"}
                  </span>
                  <div className="pipeline-toolbar">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setComparisonSource(version.source);
                        setComparison(true);
                      }}
                    >
                      {t(($) => $.pipeline.compare)}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => preserveAndOpen(version.id)}
                    >
                      {t(($) => $.pipeline.load_version)}
                    </Button>
                    {canManage && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          binding.mutate({
                            instructions_mode: "pipeline",
                            pipeline_definition_id: version.id,
                          })
                        }
                      >
                        {t(($) => $.pipeline.use_version)}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              <div className="pipeline-toolbar">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!offset}
                  onClick={() => setOffset((o) => Math.max(0, o - 50))}
                >
                  {t(($) => $.pipeline.back)}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={(versions.data?.items.length ?? 0) < 50}
                  onClick={() => setOffset((o) => o + 50)}
                >
                  {t(($) => $.pipeline.more)}
                </Button>
              </div>
            </div>
          </details>
          {usePipelineDraftStore.getState().draft.drafts[`${key}:retained`] && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const old =
                  usePipelineDraftStore.getState().draft.drafts[
                    `${key}:retained`
                  ];
                if (old) edit(old.source);
              }}
            >
              {t(($) => $.pipeline.kept)}
            </Button>
          )}
        </>
      )}
      {error && (
        <div role="alert" className="pipeline-error">
          {error}
          <Button size="sm" variant="ghost" onClick={() => setComparison(true)}>
            {t(($) => $.pipeline.latest)}
          </Button>
        </div>
      )}
      <Dialog
        open={!!switchKind}
        onOpenChange={(open) => {
          if (!open) setSwitchKind("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(($) => $.pipeline.switch_title)}</DialogTitle>
            <DialogDescription>
              {t(($) => $.pipeline.switch_help)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSwitchKind("")}>
              {t(($) => $.pipeline.cancel)}
            </Button>
            <Button
              onClick={() => {
                if (source)
                  putPipelineDraft(`${key}:${kind}`, source, openedId);
                const old =
                  usePipelineDraftStore.getState().draft.drafts[
                    `${key}:${switchKind}`
                  ];
                edit(old?.source ?? `kind: ${switchKind}\n`);
                setSwitchKind("");
              }}
            >
              {t(($) => $.pipeline.start_draft)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={comparison} onOpenChange={setComparison}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t(($) => $.pipeline.latest)}</DialogTitle>
            <DialogDescription>
              {t(($) => $.pipeline.conflict)}
            </DialogDescription>
          </DialogHeader>
          <LatestSource
            squadId={squad.id}
            pipelineId={catalog?.id}
            local={source}
            other={comparisonSource}
          />
          <DialogFooter>
            <Button
              onClick={async () => {
                const latestSquad = await qc.fetchQuery({
                  queryKey: [...workspaceKeys.squads(wsId), squad.id],
                  queryFn: () => api.getSquad(squad.id),
                  staleTime: 0,
                });
                if (comparisonSource === undefined && latestSquad.revision)
                  reviewPipelineDraft(key, latestSquad.revision, catalog ? (await api.getPipelineCatalog(catalog.id))?.revision : undefined);
                setComparison(false);
              }}
            >
              {comparisonSource === undefined
                ? t(($) => $.pipeline.review_latest)
                : t(($) => $.pipeline.close)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={showMika}
        onOpenChange={(open) => {
          if (!busy) setShowMika(open);
        }}
      >
        <DialogContent className="max-w-4xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t(($) => $.pipeline.mika)}</DialogTitle>
            <DialogDescription>
              {t(($) => $.pipeline.mika_help)}
            </DialogDescription>
          </DialogHeader>
          <MikaWorkbench
            scope={key}
            squad={squad}
            members={members}
            source={source}
            onApply={(value) => {
              edit(value);
              setShowMika(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </section>
  );
}

function LatestSource({
  squadId,
  pipelineId,
  local,
  other,
}: {
  squadId: string;
  pipelineId?: string;
  local: string;
  other?: string;
}) {
  const wsId = useWorkspaceId();
  const { t } = useT("squads");
  const latest = useQuery(
    {...pipelineDefinitionsOptions(wsId, { squad_id: squadId, pipeline_id: pipelineId, limit: 1 }), enabled: !!pipelineId},
  );
  return (
    <div className="grid sm:grid-cols-2 gap-3 overflow-auto max-h-[60vh] text-caption">
      <pre className="whitespace-pre-wrap break-words">{local}</pre>
      <pre className="whitespace-pre-wrap break-words">
        {other ??
          latest.data?.items[0]?.source ??
          (latest.isLoading
            ? t(($) => $.pipeline.loading)
            : t(($) => $.pipeline.empty))}
      </pre>
    </div>
  );
}

function MikaWorkbench({
  scope,
  squad,
  members,
  source,
  onApply,
}: {
  scope: string;
  squad: Squad;
  members: SquadMember[];
  source: string;
  onApply: (source: string) => void;
}) {
  const { t } = useT("squads");
  const wsId = useWorkspaceId();
  const agents = useQuery(agentListOptions(wsId));
  const mika = agents.data?.find(
    (a) => a.system_key === "mika" && !a.archived_at,
  );
  const qc = useQueryClient();
  const workbenchKey = scope;
  const local = usePipelineWorkbenchStore((s) => s.draft.entries[workbenchKey]);
  const request = local?.request ?? "";
  const session = local?.sessionId ?? "";
  const setRequest = (value: string) =>
    editPipelineWorkbench(workbenchKey, { request: value });
  const setSession = (value: string) =>
    editPipelineWorkbench(workbenchKey, { sessionId: value });
  const pending = useQuery({
    ...pendingChatTaskOptions(session),
    staleTime: 0,
    refetchInterval: (query) => (query.state.data?.task_id ? 2500 : false),
  });
  const waiting = !!pending.data?.task_id;
  const [selectedNode, setSelectedNode] = useState("");
  const kind = pipelineSourceKind(source);
  const messages = useQuery({
    queryKey: chatKeys.messages(session),
    queryFn: () => api.listChatMessages(session),
    enabled: !!session,
    refetchInterval: waiting ? 2500 : false,
  });
  useWSEvent("chat:done", (payload) => {
    if (
      session &&
      payload &&
      typeof payload === "object" &&
      "chat_session_id" in payload &&
      payload.chat_session_id === session
    ) {
      void messages.refetch();
      void qc.invalidateQueries({ queryKey: chatKeys.pendingTask(session) });
    }
  });
  const refetchMessages = messages.refetch;
  useEffect(() => {
    if (session && !pending.isLoading && !pending.data?.task_id)
      void refetchMessages();
  }, [session, pending.isLoading, pending.data?.task_id, refetchMessages]);
  const generate = useMutation({
    mutationFn: async () => {
      if (!mika) throw new Error(t(($) => $.pipeline.mika_missing));
      const id =
        session || (await api.createChatSession({ agent_id: mika.id })).id;
      setSession(id);
      await api.sendChatMessage(
        id,
        `Propose a complete Multica pipeline YAML draft only. Do not publish, enable, execute or modify resources. Preserve kind ${kind}, all existing custom structure and instructions unless the user explicitly requests a change. Use only the actual squad roles below, allowing reuse and leader-only squads. Return one complete fenced yaml block, role mapping and diagnostics. Referenced files are NOT loaded; obtain them with authorized reads or state that their original content is unavailable.\nSquad instructions:\n${squad.instructions}\nFull roster:\n${JSON.stringify(members)}\nCurrent YAML:\n${source}\nUser request:\n${request}`,
      );
      await qc.invalidateQueries({ queryKey: chatKeys.pendingTask(id) });
      setRequest("");
    },
  });
  const response =
    messages.data?.filter((m) => m.role === "assistant").at(-1)?.content ?? "";
  const candidate = extractPipelineDraft(response, kind);
  const validation = useQuery<PipelineValidation>({
    queryKey: ["pipeline-mika-validation", wsId, squad.id, candidate],
    queryFn: () =>
      api.validatePipeline({ source: candidate!, squad_id: squad.id }),
    enabled: !!candidate,
  });
  return (
    <div className="space-y-4">
      <p className="pipeline-metadata">{t(($) => $.pipeline.missing_source)}</p>
      <label className="block text-label">
        {t(($) => $.pipeline.request)}
        <Input value={request} onChange={(e) => setRequest(e.target.value)} />
      </label>
      {!mika && (
        <p className="pipeline-error">{t(($) => $.pipeline.mika_missing)}</p>
      )}
      {messages.data?.map((m) => (
        <div key={m.id} className="pipeline-box">
          <ReadonlyContent content={m.content} />
        </div>
      ))}
      {response && !candidate && (
        <p role="alert" className="pipeline-error">
          {t(($) => $.pipeline.mika_invalid)}
        </p>
      )}
      {waiting && <p role="status">{t(($) => $.pipeline.mika_pending)}</p>}
      {(messages.error || pending.error || validation.error) && (
        <p role="alert" className="pipeline-error">
          {messages.error?.message ??
            pending.error?.message ??
            validation.error?.message}
        </p>
      )}
      {generate.error && (
        <p role="alert" className="pipeline-error">
          {generate.error.message}
        </p>
      )}
      {validation.data?.plan && (
        <FlowGraph
          plan={validation.data.plan}
          selected={selectedNode}
          onSelect={setSelectedNode}
        />
      )}
      {validation.data?.diagnostics.map((d, i) => (
        <p key={i} className="pipeline-error">
          {d.message}
        </p>
      ))}
      <div className="pipeline-toolbar">
        <Button
          disabled={!mika || !request.trim() || generate.isPending || waiting}
          onClick={() => generate.mutate()}
        >
          {t(($) => $.pipeline.generate)}
        </Button>
        <Button
          variant="outline"
          disabled={
            !candidate ||
            !validation.data?.syntax_valid ||
            waiting ||
            generate.isPending
          }
          onClick={() => candidate && onApply(candidate)}
        >
          {t(($) => $.pipeline.apply)}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setSession("");
            setRequest("");
          }}
        >
          {t(($) => $.pipeline.reset)}
        </Button>
      </div>
    </div>
  );
}
