"use client";

import { useId, useState } from "react";
import type {
  CanvasDocument,
  CanvasNode,
  NodeFields,
} from "@multica/core/pipelines";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { useT } from "../i18n";

export interface CanvasRole {
  value: string;
  label: string;
}
export function CanvasNodeForm({
  model,
  node,
  nodeType,
  roles,
  disabled,
  onApply,
  onCancel,
}: {
  model: CanvasDocument;
  node?: CanvasNode;
  nodeType: "agent" | "manual";
  roles: CanvasRole[];
  disabled: boolean;
  onApply: (fields: NodeFields & { id: string }) => void;
  onCancel: () => void;
}) {
  const { t } = useT("squads");
  const stagesId = useId();
  const manual = nodeType === "manual",
    hermes = model.kind === "hermes_yaml";
  const initial = {
    id: node?.gateId || node?.sourceId || "",
    title: node?.title ?? "",
    stage: node?.stage || model.stages[0] || "work",
    instructions: node?.instructions ?? "",
    role: node?.role ?? "",
    owner: node?.owner ?? "",
    when: node?.when ?? "on_success",
    retry: node?.retry ?? 0,
    paths: node?.paths.join("\n") ?? "",
    allowFailure: node?.allowFailure ?? false,
    output: node?.output ?? "",
    exitCheck: node?.exitCheck ?? "",
    afterState:
      node?.sourceId ?? model.nodes.find((n) => n.type === "agent")?.id ?? "",
  };
  const [values, setValues] = useState(initial);
  const update = <K extends keyof typeof initial>(
    key: K,
    value: (typeof initial)[K],
  ) => setValues((s) => ({ ...s, [key]: value }));
  const availableRole =
    !values.role || roles.some((r) => r.value === values.role);
  const submit = () => {
    if (disabled || (!manual && !availableRole)) return;
    const fields: NodeFields & { id: string } = { id: values.id };
    const assign = <K extends keyof NodeFields>(
      key: K,
      value: NodeFields[K],
      before: unknown,
    ) => {
      if (!node || value !== before) Object.assign(fields, { [key]: value });
    };
    if (!hermes) assign("stage", values.stage, initial.stage);
    if (hermes && !manual) assign("title", values.title, initial.title);
    if (!manual || !hermes)
      assign("instructions", values.instructions, initial.instructions);
    assign("owner", values.owner, initial.owner);
    if (manual && !hermes)
      assign("allowFailure", values.allowFailure, initial.allowFailure);
    if (hermes && manual)
      assign("afterState", values.afterState, initial.afterState);
    if (!manual) {
      assign("role", values.role, initial.role);
      assign("retry", values.retry, initial.retry);
      assign("allowFailure", values.allowFailure, initial.allowFailure);
      if (!node || values.paths !== initial.paths)
        fields.paths = values.paths
          .split("\n")
          .map((p) => p.trim())
          .filter(Boolean);
      if (hermes) {
        assign("output", values.output, initial.output);
        assign("exitCheck", values.exitCheck, initial.exitCheck);
      } else assign("when", values.when, initial.when);
    }
    onApply(fields);
  };
  return (
    <form
      className="space-y-4 min-w-0"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="canvas-node-form"
    >
      <fieldset
        disabled={disabled}
        className="grid gap-3 min-w-0 sm:grid-cols-2"
      >
        <label className="grid gap-1 text-caption">
          {manual && hermes
            ? t(($) => $.canvas.gate_id)
            : t(($) => $.canvas.id)}
          <Input
            autoFocus={!node}
            required
            value={values.id}
            onChange={(e) => update("id", e.target.value)}
          />
        </label>
        {!hermes && (
          <label className="grid gap-1 text-caption">
            {t(($) => $.canvas.stage)}
            <Input
              required
              value={values.stage}
              list={stagesId}
              onChange={(e) => update("stage", e.target.value)}
            />
            <datalist id={stagesId}>
              {model.stages.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </label>
        )}
        {hermes && !manual && (
          <label className="grid gap-1 text-caption">
            {t(($) => $.canvas.title)}
            <Input
              value={values.title}
              onChange={(e) => update("title", e.target.value)}
            />
          </label>
        )}
        {hermes && manual && (
          <label className="grid gap-1 text-caption">
            {t(($) => $.canvas.attach_state)}
            <select
              className="pipeline-select w-full"
              required
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
                        g.sourceId === n.id &&
                        g.type === "manual" &&
                        g.id !== node?.id,
                    )}
                  >
                    {n.title || n.id}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="grid gap-1 text-caption">
          {t(($) => $.canvas.owner)}
          <Input
            value={values.owner}
            onChange={(e) => update("owner", e.target.value)}
          />
        </label>
        {manual && !hermes && (
          <label className="flex items-center gap-2 text-caption">
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
            <label className="grid gap-1 text-caption">
              {t(($) => $.canvas.role)}
              <select
                className="pipeline-select w-full"
                value={values.role}
                onChange={(e) => update("role", e.target.value)}
              >
                <option value="">{t(($) => $.pipeline.leader)}</option>
                {!availableRole && (
                  <option value={values.role}>{values.role}</option>
                )}
                {roles.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
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
                required
                value={Number.isNaN(values.retry) ? "" : values.retry}
                onChange={(e) => update("retry", e.target.valueAsNumber)}
              />
            </label>
            <label className="flex items-center gap-2 text-caption">
              <input
                type="checkbox"
                checked={values.allowFailure}
                onChange={(e) => update("allowFailure", e.target.checked)}
              />
              {t(($) => $.canvas.allow_failure)}
            </label>
            <label className="grid gap-1 text-caption sm:col-span-2">
              {t(($) => $.canvas.paths)}
              <textarea
                className="pipeline-field"
                rows={3}
                value={values.paths}
                onChange={(e) => update("paths", e.target.value)}
              />
            </label>
          </>
        )}
        {(!manual || !hermes) && (
          <label className="grid gap-1 text-caption sm:col-span-2">
            {t(($) => $.canvas.instructions)}
            <textarea
              className="pipeline-field"
              rows={7}
              required={!manual}
              value={values.instructions}
              onChange={(e) => update("instructions", e.target.value)}
            />
          </label>
        )}
        {hermes && !manual && (
          <>
            <label className="grid gap-1 text-caption">
              {t(($) => $.canvas.output)}
              <textarea
                className="pipeline-field"
                rows={3}
                value={values.output}
                onChange={(e) => update("output", e.target.value)}
              />
            </label>
            <label className="grid gap-1 text-caption">
              {t(($) => $.canvas.exit_check)}
              <textarea
                className="pipeline-field"
                rows={3}
                value={values.exitCheck}
                onChange={(e) => update("exitCheck", e.target.value)}
              />
            </label>
          </>
        )}
      </fieldset>
      {!manual && !availableRole && (
        <p role="alert" className="pipeline-error">
          {t(($) => $.canvas.role_unavailable)}
        </p>
      )}
      <div className="pipeline-toolbar">
        <Button
          type="submit"
          size="sm"
          disabled={disabled || (!manual && !availableRole)}
        >
          {t(($) => $.canvas.apply)}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          {t(($) => $.pipeline.cancel)}
        </Button>
      </div>
    </form>
  );
}
