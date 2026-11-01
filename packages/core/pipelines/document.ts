import { z } from "zod";
import {
  Document,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type YAMLMap,
} from "yaml";
import type { PipelineCapabilities } from "./schema";

export type CanvasErrorCode =
  | "parse"
  | "mapping"
  | "kind"
  | "id"
  | "duplicate"
  | "missing"
  | "instructions"
  | "retry"
  | "paths"
  | "manual"
  | "inferred"
  | "material_conflict"
  | "direction"
  | "cycle"
  | "branch"
  | "gate";
export class CanvasEditError extends Error {
  constructor(
    public code: CanvasErrorCode,
    public detail = "",
  ) {
    super(`${code}${detail ? `: ${detail}` : ""}`);
  }
}
const strings = z.array(z.string());
const artifacts = z.object({ paths: strings.default([]) }).strict();
const executionFields = {
  owner: z.string().default(""),
  retry: z.number().int().min(0).max(10).default(0),
  allow_failure: z.boolean().default(false),
  artifacts: artifacts.optional(),
};
const jobSchema = z
  .object({
    stage: z.string().default(""),
    instructions: z.string().default(""),
    tags: strings.max(1).optional(),
    needs: strings.optional(),
    dependencies: strings.optional(),
    when: z.enum(["on_success", "on_failure", "manual"]).default("on_success"),
    ...executionFields,
  })
  .strict();
const stateSchema = z
  .object({
    title: z.string().default(""),
    entry: z.string().default(""),
    by: z.string().default(""),
    gate: z.string().optional(),
    output: z.unknown().optional(),
    exit_check: z.unknown().optional(),
    ...executionFields,
  })
  .strict();
const hermesSchema = z
  .object({
    kind: z.literal("hermes_yaml"),
    id: z.string().optional(),
    name: z.string().optional(),
    version: z.union([z.string(), z.number()]).optional(),
    roles: z.record(z.string(), z.object({}).strict()).default({}),
    gates: z
      .record(
        z.string(),
        z
          .object({ type: z.literal("manual"), owner: z.string().default("") })
          .strict(),
      )
      .default({}),
    states: z.record(z.string(), stateSchema).default({}),
    edges: z
      .array(
        z
          .object({
            from: z.string(),
            to: z.string(),
            type: z.literal("forward"),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export interface CanvasNode {
  id: string;
  sourceId: string;
  gateId?: string;
  type: "agent" | "manual";
  title: string;
  stage: string;
  instructions: string;
  role: string;
  owner: string;
  when: "on_success" | "on_failure" | "manual";
  retry: number;
  allowFailure: boolean;
  paths: string[];
  output: string;
  exitCheck: string;
}
export type CanvasEdgeKind =
  | "needs"
  | "stage"
  | "material"
  | "forward"
  | "gate";
export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  kind: CanvasEdgeKind;
}
export interface CanvasDocument {
  kind: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  stages: string[];
  restriction: CanvasEditError | null;
}
export type NodeFields = Partial<
  Pick<
    CanvasNode,
    | "title"
    | "stage"
    | "instructions"
    | "role"
    | "owner"
    | "when"
    | "retry"
    | "allowFailure"
    | "paths"
    | "output"
    | "exitCheck"
  >
> & { id?: string; afterState?: string };
export type CanvasCommand =
  | {
      type: "add_node";
      nodeType: "agent" | "manual";
      fields: NodeFields & { id: string };
    }
  | { type: "update_node"; id: string; fields: NodeFields }
  | { type: "delete_node"; id: string }
  | {
      type: "add_edge";
      from: string;
      to: string;
      material?: boolean;
      confirmInferred?: boolean;
    }
  | { type: "delete_edge"; id: string; confirmInferred?: boolean }
  | {
      type: "reconnect_edge";
      id: string;
      from: string;
      to: string;
      confirmInferred?: boolean;
    };

const edgeId = (kind: CanvasEdgeKind, from: string, to: string) =>
  JSON.stringify([kind, from, to]);
const edge = (kind: CanvasEdgeKind, from: string, to: string): CanvasEdge => ({
  id: edgeId(kind, from, to),
  kind,
  from,
  to,
});
const gateNodeId = (state: string, gate: string) => `${state}.gate.${gate}`;
function document(source: string) {
  const doc = parseDocument(
    source.trim() ? source : "kind: gitlab_yaml\nstages: []\n",
  );
  if (doc.errors.length)
    throw new CanvasEditError("parse", doc.errors[0]!.message);
  if (!isMap(doc.contents)) throw new CanvasEditError("mapping");
  visit(doc, (_key, node) => {
    if (
      isAlias(node) ||
      ((isMap(node) || isSeq(node) || isScalar(node)) && node.anchor)
    )
      throw new CanvasEditError("mapping", "anchors/aliases");
    if (
      isMap(node) &&
      node.items.some(
        (p) => !isScalar(p.key) || typeof p.key.value !== "string",
      )
    )
      throw new CanvasEditError("mapping", "mapping keys");
  });
  return doc;
}
function fieldSource(doc: ReturnType<typeof document>, path: string[]) {
  const node = doc.getIn(path, true);
  if (!isMap(node) && !isSeq(node) && !isScalar(node)) return "";
  const single = new Document();
  single.setIn([], node.clone());
  return single.toString();
}

// This is an editable source projection, not a compiler. Only the server can
// establish executable validity; unsupported shapes never get regenerated.
export function readCanvasDocument(source: string): CanvasDocument {
  let kind = "unknown";
  try {
    const doc = document(source);
    const raw: unknown = doc.toJS();
    const root = z.record(z.string(), z.unknown()).parse(raw);
    kind =
      typeof root.kind === "string"
        ? root.kind
        : root.kind === undefined
          ? "gitlab_yaml"
          : "unknown";
    const nodes: CanvasNode[] = [],
      edges: CanvasEdge[] = [];
    let stages: string[] = [];
    if (kind === "gitlab_yaml") {
      stages = strings.parse(root.stages ?? []);
      const jobs = Object.entries(root)
        .filter(([key]) => key !== "kind" && key !== "stages")
        .map(([id, value]) => [id, jobSchema.parse(value)] as const);
      for (const [id, j] of jobs) {
        if (
          j.when === "manual" &&
          ((j.tags?.length ?? 0) > 0 || j.retry || j.artifacts?.paths.length)
        )
          throw new CanvasEditError("manual", id);
        nodes.push({
          id,
          sourceId: id,
          type: j.when === "manual" ? "manual" : "agent",
          title: id,
          stage: j.stage,
          instructions: j.instructions,
          role: j.tags?.[0] ?? "",
          owner: j.owner,
          when: j.when,
          retry: j.retry,
          allowFailure: j.allow_failure,
          paths: j.artifacts?.paths ?? [],
          output: "",
          exitCheck: "",
        });
        const needs =
          j.needs ??
          jobs
            .filter(
              ([, up]) =>
                stages.indexOf(up.stage) >= 0 &&
                stages.indexOf(up.stage) < stages.indexOf(j.stage),
            )
            .map(([key]) => key);
        needs.forEach((from) =>
          edges.push(edge(j.needs ? "needs" : "stage", from, id)),
        );
        j.dependencies?.forEach((from) =>
          edges.push(edge("material", from, id)),
        );
      }
    } else if (kind === "hermes_yaml") {
      const root = hermesSchema.parse(raw),
        used = new Set<string>();
      stages = Object.keys(root.states);
      for (const [id, s] of Object.entries(root.states)) {
        nodes.push({
          id,
          sourceId: id,
          type: "agent",
          title: s.title || id,
          stage: id,
          instructions: s.entry,
          role: s.by,
          owner: s.owner,
          when: "on_success",
          retry: s.retry,
          allowFailure: s.allow_failure,
          paths: s.artifacts?.paths ?? [],
          output: fieldSource(doc, ["states", id, "output"]),
          exitCheck: fieldSource(doc, ["states", id, "exit_check"]),
        });
        if (s.gate) {
          const g = root.gates[s.gate];
          if (!g || used.has(s.gate)) throw new CanvasEditError("gate", s.gate);
          used.add(s.gate);
          const gid = gateNodeId(id, s.gate);
          nodes.push({
            id: gid,
            sourceId: id,
            gateId: s.gate,
            type: "manual",
            title: s.gate,
            stage: id,
            instructions: "",
            role: "",
            owner: g.owner,
            when: "manual",
            retry: 0,
            allowFailure: false,
            paths: [],
            output: "",
            exitCheck: "",
          });
          edges.push(edge("gate", id, gid));
        }
      }
      root.edges.forEach((e) =>
        edges.push(
          edge(
            "forward",
            root.states[e.from]?.gate
              ? gateNodeId(e.from, root.states[e.from]!.gate!)
              : e.from,
            e.to,
          ),
        ),
      );
    } else throw new CanvasEditError("kind", kind);
    if (new Set(nodes.map((n) => n.id)).size !== nodes.length)
      throw new CanvasEditError(
        "mapping",
        "duplicate compiled node identifiers",
      );
    return { kind, nodes, edges, stages, restriction: null };
  } catch (error) {
    return {
      kind,
      nodes: [],
      edges: [],
      stages: [],
      restriction:
        error instanceof CanvasEditError
          ? error
          : new CanvasEditError(
              "mapping",
              error instanceof z.ZodError
                ? error.issues.map((i) => i.path.join(".")).join(", ")
                : String(error),
            ),
    };
  }
}

export function canvasCapabilityRestriction(
  caps: PipelineCapabilities | undefined,
  kind: string,
): string | null {
  if (
    !caps ||
    caps.schema_version !== 1 ||
    caps.compiler_version !== "1" ||
    !caps.kinds.includes(kind) ||
    caps.features.custom_nodes !== true ||
    caps.features.manual_gates !== true ||
    (kind === "gitlab_yaml"
      ? caps.features.gitlab_dag !== true
      : kind === "hermes_yaml"
        ? caps.features.hermes_forward_chain !== true
        : true)
  )
    return "capability";
  return null;
}
function mapAt(doc: ReturnType<typeof document>, path: string[]): YAMLMap {
  const node = path.length ? doc.getIn(path, true) : doc.contents;
  if (!isMap(node)) throw new CanvasEditError("mapping", path.join("."));
  return node;
}
function ensureMap(doc: ReturnType<typeof document>, path: string[]) {
  if (!doc.hasIn(path)) doc.setIn(path, doc.createNode({}));
  return mapAt(doc, path);
}
function renameKey(map: YAMLMap, from: string, to: string) {
  const pair = map.items.find((p) => isScalar(p.key) && p.key.value === from);
  if (!pair || !isScalar(pair.key)) throw new CanvasEditError("missing", from);
  pair.key.value = to;
}
function updateReferences(
  doc: ReturnType<typeof document>,
  path: string[],
  from: string,
  to?: string,
) {
  const seq = doc.getIn(path, true);
  if (!isSeq(seq)) return;
  if (to === undefined)
    seq.items = seq.items.filter((n) => !isScalar(n) || n.value !== from);
  else
    seq.items.forEach((n) => {
      if (isScalar(n) && n.value === from) n.value = to;
    });
}
function setList(
  doc: ReturnType<typeof document>,
  path: string[],
  values: string[],
) {
  doc.setIn(path, doc.createNode(values));
}
function checkId(id: string, kind: string) {
  if (
    !/^[\p{L}\p{N}_.-]+$/u.test(id) ||
    (kind === "gitlab_yaml" &&
      (id.startsWith(".") || ["kind", "stages"].includes(id)))
  )
    throw new CanvasEditError("id", id);
}
function addStage(doc: ReturnType<typeof document>, stage: string) {
  if (!stage.trim()) throw new CanvasEditError("direction", stage);
  if (!doc.has("stages")) setList(doc, ["stages"], []);
  const list = doc.get("stages", true);
  if (!isSeq(list)) throw new CanvasEditError("mapping", "stages");
  if (!list.items.some((n) => isScalar(n) && n.value === stage))
    list.add(stage);
}
function setRole(
  doc: ReturnType<typeof document>,
  kind: string,
  id: string,
  role: string,
) {
  if (kind === "gitlab_yaml") setList(doc, [id, "tags"], role ? [role] : []);
  else {
    if (role) {
      ensureMap(doc, ["roles"]);
      if (!doc.hasIn(["roles", role]))
        doc.setIn(["roles", role], doc.createNode({}));
      doc.setIn(["states", id, "by"], role);
    } else doc.deleteIn(["states", id, "by"]);
  }
}
function checkPaths(paths: string[]) {
  if (
    paths.some(
      (p) =>
        !p ||
        p.startsWith("/") ||
        p.split("/").some((s) => !s || s === "." || s === "..") ||
        /[\\*?[\]]/.test(p) ||
        p.includes(String.fromCharCode(0)),
    )
  )
    throw new CanvasEditError("paths");
}
function writeFields(
  doc: ReturnType<typeof document>,
  kind: string,
  node: CanvasNode,
  fields: NodeFields,
) {
  const path =
    kind === "gitlab_yaml"
      ? [node.sourceId]
      : node.type === "manual"
        ? ["gates", node.gateId!]
        : ["states", node.sourceId];
  if (
    node.type === "manual" &&
    (fields.role ||
      fields.retry ||
      fields.paths?.length ||
      fields.output ||
      fields.exitCheck)
  )
    throw new CanvasEditError("manual", node.id);
  if (
    fields.instructions !== undefined &&
    node.type === "agent" &&
    !fields.instructions.trim()
  )
    throw new CanvasEditError("instructions", node.id);
  if (
    fields.retry !== undefined &&
    (!Number.isInteger(fields.retry) || fields.retry < 0 || fields.retry > 10)
  )
    throw new CanvasEditError("retry");
  if (fields.paths) checkPaths(fields.paths);
  if (kind === "gitlab_yaml" && fields.stage !== undefined) {
    addStage(doc, fields.stage);
    doc.setIn([...path, "stage"], fields.stage);
  }
  if (
    kind === "hermes_yaml" &&
    node.type === "agent" &&
    fields.title !== undefined
  )
    doc.setIn([...path, "title"], fields.title);
  if (
    fields.instructions !== undefined &&
    (node.type === "agent" || kind === "gitlab_yaml")
  )
    doc.setIn(
      [...path, kind === "gitlab_yaml" ? "instructions" : "entry"],
      fields.instructions,
    );
  if (fields.role !== undefined && node.type === "agent")
    setRole(doc, kind, node.sourceId, fields.role);
  if (fields.owner !== undefined) doc.setIn([...path, "owner"], fields.owner);
  if (
    fields.allowFailure !== undefined &&
    (kind === "gitlab_yaml" || node.type === "agent")
  )
    doc.setIn([...path, "allow_failure"], fields.allowFailure);
  if (node.type === "agent") {
    if (fields.retry !== undefined) doc.setIn([...path, "retry"], fields.retry);
    if (fields.paths !== undefined)
      doc.setIn([...path, "artifacts", "paths"], doc.createNode(fields.paths));
    if (kind === "gitlab_yaml" && fields.when !== undefined) {
      if (!["on_success", "on_failure"].includes(fields.when))
        throw new CanvasEditError("manual");
      doc.setIn([...path, "when"], fields.when);
    }
    for (const [field, key] of [
      ["output", "output"],
      ["exitCheck", "exit_check"],
    ] as const) {
      if (kind !== "hermes_yaml" || fields[field] === undefined) continue;
      const text = fields[field]!;
      if (!text.trim()) doc.deleteIn([...path, key]);
      else {
        const value = parseDocument(text);
        if (value.errors.length) throw new CanvasEditError("parse", key);
        doc.setIn([...path, key], value.contents);
      }
    }
  }
}
function removeHermesEdges(
  doc: ReturnType<typeof document>,
  predicate: (from: string, to: string) => boolean,
) {
  const edges = doc.get("edges", true);
  if (isSeq(edges))
    edges.items = edges.items.filter(
      (n) =>
        !isMap(n) || !predicate(String(n.get("from")), String(n.get("to"))),
    );
}

export function canvasDeletionImpact(model: CanvasDocument, id: string) {
  const n = model.nodes.find((n) => n.id === id);
  const removed = new Set([
    id,
    ...model.nodes
      .filter((other) => other.sourceId === n?.sourceId && n?.type === "agent")
      .map((n) => n.id),
  ]);
  return {
    nodes: [...removed],
    edges: model.edges.filter((e) => removed.has(e.from) || removed.has(e.to)),
    materials: model.edges
      .filter((e) => removed.has(e.from) && e.kind === "material")
      .map((e) => e.to),
  };
}
export function canvasStageConversions(
  source: string,
  command: CanvasCommand,
): string[] {
  const model = readCanvasDocument(source);
  if (
    model.kind !== "gitlab_yaml" ||
    !["add_edge", "delete_edge", "reconnect_edge"].includes(command.type)
  )
    return [];
  const old =
    "id" in command ? model.edges.find((e) => e.id === command.id) : undefined;
  const targets = [
    ...(old && old.kind !== "material" ? [old.to] : []),
    ...((command.type === "add_edge" && !command.material) ||
    (command.type === "reconnect_edge" && old?.kind !== "material")
      ? [command.to]
      : []),
  ];
  const doc = document(source);
  return [...new Set(targets)].filter((id) => !doc.hasIn([id, "needs"]));
}

// Every operation is a transaction on a fresh AST. Rejected reconnects and
// cancelled confirmations cannot leave half-applied source edits behind.
export function applyCanvasEdit(
  source: string,
  command: CanvasCommand,
): { source: string; selected?: string } {
  const model = readCanvasDocument(source);
  if (model.restriction) throw model.restriction;
  const doc = document(source),
    kind = model.kind;
  const nodeById = (id: string) => {
    const n = model.nodes.find((n) => n.id === id);
    if (!n) throw new CanvasEditError("missing", id);
    return n;
  };
  let selected: string | undefined;
  if (command.type === "add_node") {
    const f = command.fields,
      id = f.id;
    checkId(id, kind);
    if (
      kind === "gitlab_yaml"
        ? doc.has(id)
        : doc.hasIn(["states", id]) || doc.hasIn(["gates", id])
    )
      throw new CanvasEditError("duplicate", id);
    if (kind === "hermes_yaml" && command.nodeType === "manual") {
      const parent = nodeById(f.afterState ?? "");
      if (
        parent.type !== "agent" ||
        doc.hasIn(["states", parent.sourceId, "gate"])
      )
        throw new CanvasEditError("gate", parent.id);
      ensureMap(doc, ["gates"]).set(
        id,
        doc.createNode({
          type: "manual",
          ...(f.owner ? { owner: f.owner } : {}),
        }),
      );
      doc.setIn(["states", parent.sourceId, "gate"], id);
      selected = gateNodeId(parent.sourceId, id);
    } else {
      const target =
        kind === "gitlab_yaml" ? doc.contents : ensureMap(doc, ["states"]);
      if (!isMap(target)) throw new CanvasEditError("mapping");
      target.set(
        id,
        doc.createNode(
          kind === "gitlab_yaml"
            ? {
                stage: f.stage || model.stages[0] || "work",
                ...(command.nodeType === "manual" ? { when: "manual" } : {}),
              }
            : {},
        ),
      );
      const n: CanvasNode = {
        id,
        sourceId: id,
        title: id,
        stage: f.stage || model.stages[0] || "work",
        type: command.nodeType,
        instructions: "",
        role: "",
        owner: "",
        when: command.nodeType === "manual" ? "manual" : "on_success",
        retry: 0,
        allowFailure: false,
        paths: [],
        output: "",
        exitCheck: "",
      };
      writeFields(doc, kind, n, {
        ...f,
        stage: n.stage,
        instructions:
          f.instructions ?? (command.nodeType === "agent" ? "" : ""),
      });
      selected = id;
    }
  } else if (command.type === "update_node") {
    const n = nodeById(command.id),
      f = command.fields,
      id = f.id ?? (n.gateId || n.sourceId);
    checkId(id, kind);
    const old = n.gateId || n.sourceId;
    if (id !== old) {
      const map =
        kind === "gitlab_yaml"
          ? mapAt(doc, [])
          : mapAt(doc, [n.type === "manual" ? "gates" : "states"]);
      if (
        map.has(id) ||
        (kind === "hermes_yaml" && model.nodes.some((v) => v.id === id))
      )
        throw new CanvasEditError("duplicate", id);
      renameKey(map, old, id);
      if (kind === "gitlab_yaml")
        for (const other of model.nodes)
          for (const field of ["needs", "dependencies"])
            updateReferences(
              doc,
              [other.id === old ? id : other.id, field],
              old,
              id,
            );
      else if (n.type === "manual")
        doc.setIn(["states", n.sourceId, "gate"], id);
      else {
        const edges = doc.get("edges", true);
        if (isSeq(edges))
          for (const e of edges.items)
            if (isMap(e))
              for (const field of ["from", "to"])
                if (e.get(field) === old) e.set(field, id);
      }
    }
    const updated = {
      ...n,
      id:
        n.type === "manual" && kind === "hermes_yaml"
          ? gateNodeId(n.sourceId, id)
          : id,
      sourceId: n.type === "manual" && kind === "hermes_yaml" ? n.sourceId : id,
      gateId: n.gateId ? id : undefined,
    };
    if (
      n.type === "manual" &&
      kind === "hermes_yaml" &&
      f.afterState &&
      f.afterState !== n.sourceId
    ) {
      const parent = nodeById(f.afterState);
      if (
        parent.type !== "agent" ||
        doc.hasIn(["states", parent.sourceId, "gate"])
      )
        throw new CanvasEditError("gate", parent.id);
      doc.deleteIn(["states", n.sourceId, "gate"]);
      removeHermesEdges(doc, (from) => from === n.sourceId);
      doc.setIn(["states", parent.sourceId, "gate"], id);
      updated.sourceId = parent.sourceId;
      updated.id = gateNodeId(parent.sourceId, id);
    }
    writeFields(doc, kind, updated, f);
    selected = updated.id;
  } else if (command.type === "delete_node") {
    const n = nodeById(command.id);
    if (kind === "gitlab_yaml") {
      doc.delete(n.sourceId);
      for (const other of model.nodes)
        for (const field of ["needs", "dependencies"])
          updateReferences(doc, [other.id, field], n.sourceId);
    } else if (n.type === "manual") {
      doc.deleteIn(["gates", n.gateId!]);
      doc.deleteIn(["states", n.sourceId, "gate"]);
      // Removing a gate must not silently connect its work directly downstream.
      removeHermesEdges(doc, (from) => from === n.sourceId);
    } else {
      doc.deleteIn(["states", n.sourceId]);
      const gate = model.nodes.find(
        (other) => other.sourceId === n.sourceId && other.gateId,
      );
      if (gate) doc.deleteIn(["gates", gate.gateId!]);
      removeHermesEdges(
        doc,
        (from, to) => from === n.sourceId || to === n.sourceId,
      );
    }
  } else {
    if (
      canvasStageConversions(source, command).length &&
      !command.confirmInferred
    )
      throw new CanvasEditError("inferred");
    const remove = (id: string) => {
      const e = model.edges.find((e) => e.id === id);
      if (!e) throw new CanvasEditError("missing", id);
      if (e.kind === "gate") throw new CanvasEditError("gate");
      if (kind === "hermes_yaml") {
        removeHermesEdges(
          doc,
          (from, to) =>
            from === nodeById(e.from).sourceId &&
            to === nodeById(e.to).sourceId,
        );
        return;
      }
      const field = e.kind === "material" ? "dependencies" : "needs";
      if (field === "needs" && doc.hasIn([e.to, "dependencies"]))
        throw new CanvasEditError("material_conflict", e.to);
      if (!doc.hasIn([e.to, field]))
        setList(
          doc,
          [e.to, field],
          model.edges
            .filter((v) => v.to === e.to && v.kind === e.kind)
            .map((v) => v.from),
        );
      updateReferences(doc, [e.to, field], e.from);
    };
    if (command.type !== "add_edge") remove(command.id);
    if (command.type !== "delete_edge") {
      const from = nodeById(command.from),
        to = nodeById(command.to);
      if (from.id === to.id || from.sourceId === to.sourceId)
        throw new CanvasEditError("cycle");
      if (kind === "hermes_yaml") {
        if (to.type === "manual") throw new CanvasEditError("gate");
        const current = readCanvasDocument(doc.toString());
        if (
          current.edges.some(
            (e) =>
              e.kind === "forward" &&
              (nodeById(e.from).sourceId === from.sourceId || e.to === to.id),
          )
        )
          throw new CanvasEditError("branch");
        if (!doc.has("edges")) doc.set("edges", doc.createNode([]));
        const edges = doc.get("edges", true);
        if (!isSeq(edges)) throw new CanvasEditError("mapping");
        edges.add(
          doc.createNode({
            from: from.sourceId,
            to: to.sourceId,
            type: "forward",
          }),
        );
      } else {
        const old =
          command.type === "reconnect_edge"
            ? model.edges.find((e) => e.id === command.id)
            : undefined;
        const material =
          command.type === "add_edge"
            ? command.material
            : old?.kind === "material";
        if (
          model.stages.indexOf(from.stage) > model.stages.indexOf(to.stage) ||
          (material &&
            model.stages.indexOf(from.stage) >= model.stages.indexOf(to.stage))
        )
          throw new CanvasEditError("direction");
        const field = material ? "dependencies" : "needs";
        if (doc.hasIn([to.id, material ? "needs" : "dependencies"]))
          throw new CanvasEditError("material_conflict", to.id);
        const materialized = material && !doc.hasIn([to.id, field]);
        if (!doc.hasIn([to.id, field]))
          setList(
            doc,
            [to.id, field],
            model.edges
              .filter(
                (e) =>
                  e.to === to.id &&
                  (material
                    ? e.kind === "stage"
                    : e.kind === "stage" || e.kind === "needs"),
              )
              .map((e) => e.from),
          );
        const list = doc.getIn([to.id, field], true);
        if (!isSeq(list)) throw new CanvasEditError("mapping");
        const exists = list.items.some(
          (n) => isScalar(n) && n.value === from.id,
        );
        if (exists && !materialized) throw new CanvasEditError("duplicate");
        if (!exists) list.add(from.id);
      }
    }
  }
  const result = doc.toString(),
    next = readCanvasDocument(result);
  if (next.restriction) throw next.restriction;
  const color = new Map<string, number>();
  const visitNode = (id: string) => {
    if (color.get(id) === 1) throw new CanvasEditError("cycle", id);
    if (color.get(id) === 2) return;
    color.set(id, 1);
    next.edges
      .filter((e) => e.to === id && e.kind !== "material")
      .forEach((e) => visitNode(e.from));
    color.set(id, 2);
  };
  next.nodes.forEach((n) => visitNode(n.id));
  return { source: result, selected };
}
