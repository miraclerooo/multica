"use client";

import { useMemo, useRef, useState } from "react";
import {
  clearPipelineNodeDraft,
  putPipelineNodeDraft,
  usePipelineNodeDraftStore,
  type CanvasDocument,
  type CanvasNode,
  type NodeFields,
  type PipelineCandidates,
  type PipelineNodeFormValues,
} from "@multica/core/pipelines";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { useT } from "../i18n";

export function CanvasNodeForm({
  model,
  node,
  nodeType,
  candidates,
  disabled,
  formKey,
  source,
  onApply,
  onCancel,
}: {
  model: CanvasDocument;
  node?: CanvasNode;
  nodeType: "agent" | "manual";
  candidates: PipelineCandidates | null | undefined;
  disabled: boolean;
  formKey: string;
  source: string;
  onApply: (fields: NodeFields) => boolean;
  onCancel: () => void;
}) {
  const { t } = useT("squads");
  const manual = nodeType === "manual",
    hermes = model.kind === "hermes_yaml";
  const [tab, setTab] = useState("basic"),
    [search, setSearch] = useState(""),
    [error, setError] = useState("");
  const instructionsRef = useRef<HTMLTextAreaElement>(null);
  const draft = usePipelineNodeDraftStore((s) => s.draft.forms[formKey]);
  const initial = useMemo<PipelineNodeFormValues>(
    () => ({
      id: node?.gateId || node?.sourceId || "",
      title: node?.title ?? "",
      stage: node?.stage || model.stages.at(-1) || "work",
      instructions: node?.instructions ?? "",
      executor: node?.agentId
        ? `member:${node.agentId}`
        : node?.role
          ? `role:${node.role}`
          : "leader",
      ownerChoice: node?.ownerUserId
        ? `user:${node.ownerUserId}`
        : node?.owner
          ? `role:${node.owner}`
          : !node && manual && candidates?.default_owner_user_id
            ? `user:${candidates.default_owner_user_id}`
            : "none",
      when: node?.when ?? "on_success",
      retry: node?.retry ?? 0,
      allowFailure: node?.allowFailure ?? false,
      deliverables:
        node?.deliverables ??
        node?.paths.map((path) => ({
          path,
          name: path.split("/").at(-1)!,
          description: "",
        })) ??
        [],
      output: node?.output ?? "",
      exitCheck: node?.exitCheck ?? "",
      afterState:
        node?.sourceId ??
        model.nodes.find(
          (n) =>
            n.type === "agent" &&
            !model.nodes.some(
              (g) => g.type === "manual" && g.sourceId === n.id,
            ),
        )?.id ??
        "",
    }),
    [node, model, candidates, manual],
  );
  const values = draft?.values ?? initial,
    stale = !!draft && draft.source !== source;
  const update = <K extends keyof PipelineNodeFormValues>(
    key: K,
    value: PipelineNodeFormValues[K],
  ) => {
    if (!disabled)
      putPipelineNodeDraft(formKey, draft?.source ?? source, {
        ...values,
        [key]: value,
      });
  };
  const roles = [
    ...new Set(candidates?.agents.map((a) => a.role).filter(Boolean) ?? []),
  ];
  const executorAvailable =
    (values.executor === "leader" &&
      candidates?.agents.some(
        (a) => a.agent_id === candidates.leader_id && a.can_invoke,
      )) ||
    (values.executor.startsWith("role:") &&
      candidates?.agents.filter((a) => a.role === values.executor.slice(5))
        .length === 1 &&
      candidates.agents.some(
        (a) => a.role === values.executor.slice(5) && a.can_invoke,
      )) ||
    (values.executor.startsWith("member:") &&
      candidates?.agents.some(
        (a) => a.agent_id === values.executor.slice(7) && a.can_invoke,
      ));
  const ownerAvailable =
    !values.ownerChoice.startsWith("user:") ||
    candidates?.humans.some((h) => h.user_id === values.ownerChoice.slice(5));
  const blocked =
    disabled ||
    !candidates ||
    stale ||
    !ownerAvailable ||
    (!manual && !executorAvailable);
  const submit = () => {
    if (blocked) return;
    if (!values.title.trim() || (!manual && !values.instructions.trim())) {
      setError(t(($) => $.v17.required));
      if (!manual && !values.instructions.trim()) {
        setTab("instructions");
        requestAnimationFrame(() => instructionsRef.current?.focus());
      }
      return;
    }
    const fields: NodeFields = {};
    const assign = <K extends keyof NodeFields>(
      key: K,
      value: NodeFields[K],
      before: unknown,
    ) => {
      if (!node || JSON.stringify(value) !== JSON.stringify(before))
        Object.assign(fields, { [key]: value });
    };
    if (values.id && (!node || values.id !== initial.id)) fields.id = values.id;
    assign("title", values.title, initial.title);
    if (!hermes) assign("stage", values.stage, initial.stage);
    if (!manual || !hermes)
      assign("instructions", values.instructions, initial.instructions);
    if (!node || values.ownerChoice !== initial.ownerChoice) {
      fields.ownerUserId = values.ownerChoice.startsWith("user:")
        ? values.ownerChoice.slice(5)
        : "";
      fields.owner = values.ownerChoice.startsWith("role:")
        ? values.ownerChoice.slice(5)
        : "";
    }
    if (hermes && manual)
      assign("afterState", values.afterState, initial.afterState);
    if (!hermes || !manual)
      assign("allowFailure", values.allowFailure, initial.allowFailure);
    if (!manual) {
      if (!node || values.executor !== initial.executor) {
        fields.agentId = values.executor.startsWith("member:")
          ? values.executor.slice(7)
          : "";
        fields.role = values.executor.startsWith("role:")
          ? values.executor.slice(5)
          : "";
      }
      assign("retry", values.retry, initial.retry);
      if (
        JSON.stringify(values.deliverables) !==
        JSON.stringify(initial.deliverables)
      )
        fields.deliverables = values.deliverables.map((file) => ({
          ...file,
          path: file.path || file.name,
        }));
      if (hermes) {
        assign("output", values.output, initial.output);
        assign("exitCheck", values.exitCheck, initial.exitCheck);
      } else assign("when", values.when, initial.when);
    }
    if (onApply(fields)) {
      clearPipelineNodeDraft(formKey);
      setError("");
    }
  };
  return (
    <form
      noValidate
      className="space-y-4 min-w-0"
      data-testid="canvas-node-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div
        className="pipeline-toolbar"
        role="tablist"
        aria-label={t(($) => $.canvas.node_properties)}
      >
        <Button
          type="button"
          size="sm"
          variant={tab === "basic" ? "secondary" : "ghost"}
          role="tab"
          aria-selected={tab === "basic"}
          onClick={() => setTab("basic")}
        >
          {t(($) => $.v17.basic)}
        </Button>
        {(!hermes || !manual) && (
          <Button
            type="button"
            size="sm"
            variant={tab === "instructions" ? "secondary" : "ghost"}
            role="tab"
            aria-selected={tab === "instructions"}
            onClick={() => setTab("instructions")}
          >
            {t(($) => $.v17.instructions)}
          </Button>
        )}
      </div>
      {stale && (
        <div role="alert" className="pipeline-error">
          <p>{t(($) => $.v17.node_draft_stale)}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              clearPipelineNodeDraft(formKey);
              setError("");
            }}
          >
            {t(($) => $.v17.reload_properties)}
          </Button>
        </div>
      )}
      {((!executorAvailable && !manual) || !ownerAvailable) && (
        <p role="status" className="pipeline-error">
          {t(($) => $.v17.binding_unavailable)}
        </p>
      )}
      {manual && values.ownerChoice.startsWith("role:") && (
        <p role="status" className="pipeline-metadata">
          {t(($) => $.v17.saved_role)}: {values.ownerChoice.slice(5)}
        </p>
      )}
      {error && (
        <p role="alert" className="pipeline-error">
          {error}
        </p>
      )}
      <fieldset
        disabled={disabled || !candidates}
        className="min-w-0 space-y-4"
      >
        <div
          hidden={tab !== "basic"}
          className="space-y-4 min-w-0"
          role="tabpanel"
        >
          <label className="grid gap-1 text-caption">
            {t(($) => $.v17.node_name)}
            <Input
              autoFocus={!node}
              value={values.title}
              onChange={(e) => update("title", e.target.value)}
            />
          </label>
          {!manual && (
            <label className="grid gap-1 text-caption">
              {t(($) => $.v17.executor)}
              <select
                className="pipeline-select w-full"
                value={values.executor}
                onChange={(e) => update("executor", e.target.value)}
              >
                <option value="leader">{t(($) => $.pipeline.leader)}</option>
                {!executorAvailable && (
                  <option value={values.executor}>
                    {node?.role || node?.agentId || values.executor} ·{" "}
                    {t(($) => $.v17.binding_unavailable)}
                  </option>
                )}
                <optgroup label={t(($) => $.v17.members)}>
                  {candidates?.agents.map((a) => (
                    <option
                      key={a.agent_id}
                      value={`member:${a.agent_id}`}
                      disabled={!a.can_invoke}
                    >
                      {a.name}
                      {a.role ? ` · ${a.role}` : ""}
                      {a.reason ? ` · ${a.reason}` : ""}
                    </option>
                  ))}
                </optgroup>
                {!!roles.length && (
                  <optgroup label={t(($) => $.v17.roles)}>
                    {roles.map((role) => (
                      <option key={role} value={`role:${role}`}>
                        {t(($) => $.v17.saved_role)} · {role}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
          )}
          {manual && (
            <div className="space-y-2">
              <label className="grid gap-1 text-caption">
                {t(($) => $.v17.search_people)}
                <Input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <label className="grid gap-1 text-caption">
                {t(($) => $.v17.human_owner)}
                <select
                  className="pipeline-select w-full"
                  value={values.ownerChoice}
                  onChange={(e) => update("ownerChoice", e.target.value)}
                >
                  <option value="none">{t(($) => $.v17.no_owner)}</option>
                  {values.ownerChoice.startsWith("role:") && (
                    <option value={values.ownerChoice}>
                      {t(($) => $.v17.saved_role)} ·{" "}
                      {values.ownerChoice.slice(5)}
                    </option>
                  )}
                  {!ownerAvailable && (
                    <option value={values.ownerChoice}>
                      {node?.ownerUserId} ·{" "}
                      {t(($) => $.v17.binding_unavailable)}
                    </option>
                  )}
                  {candidates?.humans
                    .filter(
                      (h) =>
                        h.name
                          .toLocaleLowerCase()
                          .includes(search.toLocaleLowerCase()) ||
                        `user:${h.user_id}` === values.ownerChoice,
                    )
                    .map((h) => (
                      <option key={h.user_id} value={`user:${h.user_id}`}>
                        {h.name}
                      </option>
                    ))}
                </select>
              </label>
              <p className="pipeline-metadata">{t(($) => $.v17.owner_help)}</p>
            </div>
          )}
          {!manual && (
            <section
              className="space-y-3 min-w-0"
              aria-label={t(($) => $.v17.files)}
            >
              <div className="pipeline-toolbar justify-between">
                <h4>{t(($) => $.v17.files)}</h4>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    update("deliverables", [
                      ...values.deliverables,
                      { path: "", name: "", description: "" },
                    ])
                  }
                >
                  {t(($) => $.v17.add_file)}
                </Button>
              </div>
              {values.deliverables.map((file, i) => (
                <div
                  key={i}
                  className="pipeline-box space-y-2 min-w-0"
                  data-testid="deliverable-row"
                >
                  <label className="grid gap-1 text-caption">
                    {t(($) => $.v17.file_name)}
                    <Input
                      value={file.name}
                      onChange={(e) =>
                        update(
                          "deliverables",
                          values.deliverables.map((v, n) =>
                            n === i ? { ...v, name: e.target.value } : v,
                          ),
                        )
                      }
                    />
                  </label>
                  <label className="grid gap-1 text-caption">
                    {t(($) => $.v17.file_description)}
                    <textarea
                      className="pipeline-field resize-y"
                      rows={3}
                      value={file.description}
                      onChange={(e) =>
                        update(
                          "deliverables",
                          values.deliverables.map((v, n) =>
                            n === i ? { ...v, description: e.target.value } : v,
                          ),
                        )
                      }
                    />
                  </label>
                  {file.path &&
                    (file.path !== file.name ||
                      values.deliverables.some(
                        (other) => other !== file && other.name === file.name,
                      )) && (
                      <p className="pipeline-metadata break-all">
                        {t(($) => $.v17.path)}: {file.path}
                      </p>
                    )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      update(
                        "deliverables",
                        values.deliverables.filter((_, n) => i !== n),
                      )
                    }
                  >
                    {t(($) => $.v17.remove_file)}
                  </Button>
                </div>
              ))}
            </section>
          )}
          <details className="pipeline-box space-y-3">
            <summary className="cursor-pointer">
              {t(($) => $.v17.advanced)}
            </summary>
            <label className="grid gap-1 text-caption">
              {manual && hermes
                ? t(($) => $.canvas.gate_id)
                : t(($) => $.canvas.id)}
              <Input
                value={values.id}
                onChange={(e) => update("id", e.target.value)}
              />
            </label>
            {!hermes && (
              <label className="grid gap-1 text-caption">
                {t(($) => $.canvas.stage)}
                <Input
                  value={values.stage}
                  onChange={(e) => update("stage", e.target.value)}
                />
              </label>
            )}
            {hermes && manual && (
              <label className="grid gap-1 text-caption">
                {t(($) => $.canvas.attach_state)}
                <select
                  className="pipeline-select w-full"
                  value={values.afterState}
                  onChange={(e) => update("afterState", e.target.value)}
                >
                  {model.nodes
                    .filter((n) => n.type === "agent")
                    .map((n) => (
                      <option
                        key={n.id}
                        value={n.id}
                        disabled={model.nodes.some(
                          (g) =>
                            g.type === "manual" &&
                            g.sourceId === n.id &&
                            g.id !== node?.id,
                        )}
                      >
                        {n.title}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {(!manual || !hermes) && (
              <label className="flex gap-2 items-center text-caption">
                <input
                  type="checkbox"
                  checked={values.allowFailure}
                  onChange={(e) => update("allowFailure", e.target.checked)}
                />
                {t(($) => $.canvas.allow_failure)}
              </label>
            )}
            {!manual && (
              <>
                {!hermes && (
                  <label className="grid gap-1 text-caption">
                    {t(($) => $.canvas.when)}
                    <select
                      className="pipeline-select w-full"
                      value={values.when}
                      onChange={(e) =>
                        update(
                          "when",
                          e.target.value as "on_success" | "on_failure",
                        )
                      }
                    >
                      <option value="on_success">{"on_success"}</option>
                      <option value="on_failure">{"on_failure"}</option>
                    </select>
                  </label>
                )}
                <label className="grid gap-1 text-caption">
                  {t(($) => $.canvas.retry)}
                  <Input
                    type="number"
                    min={0}
                    max={10}
                    step={1}
                    value={Number.isNaN(values.retry) ? "" : values.retry}
                    onChange={(e) =>
                      update(
                        "retry",
                        Number.isFinite(e.target.valueAsNumber)
                          ? e.target.valueAsNumber
                          : 0,
                      )
                    }
                  />
                </label>
                {hermes && (
                  <>
                    <label className="grid gap-1 text-caption">
                      {t(($) => $.canvas.output)}
                      <textarea
                        rows={3}
                        className="pipeline-field"
                        value={values.output}
                        onChange={(e) => update("output", e.target.value)}
                      />
                    </label>
                    <label className="grid gap-1 text-caption">
                      {t(($) => $.canvas.exit_check)}
                      <textarea
                        rows={3}
                        className="pipeline-field"
                        value={values.exitCheck}
                        onChange={(e) => update("exitCheck", e.target.value)}
                      />
                    </label>
                  </>
                )}
              </>
            )}
          </details>
        </div>
        <div hidden={tab !== "instructions"} role="tabpanel">
          <label className="grid gap-1 text-caption">
            {t(($) => $.canvas.instructions)}
            <textarea
              ref={instructionsRef}
              className="pipeline-field resize-y"
              rows={10}
              value={values.instructions}
              onChange={(e) => update("instructions", e.target.value)}
            />
          </label>
        </div>
      </fieldset>
      <div className="pipeline-toolbar">
        <Button type="submit" size="sm" disabled={blocked}>
          {t(($) => $.canvas.apply)}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          {t(($) => $.pipeline.cancel)}
        </Button>
      </div>
    </form>
  );
}
