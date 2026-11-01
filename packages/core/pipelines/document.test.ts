// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  applyCanvasEdit,
  canvasDeletionImpact,
  canvasStageConversions,
  canvasCapabilityRestriction,
  readCanvasDocument,
  CanvasEditError,
  type CanvasCommand,
} from "./document";
import { PipelineCapabilitiesSchema } from "./schema";

const source = `# Keep the complete user's document.
kind: gitlab_yaml
stages: [work, review, publish]
alpha:
  stage: work
  instructions: |
    Keep this full instruction.
    URL: https://example.test/a#fragment
    Preserve "quotes" and # literal content.
  artifacts: {paths: [reports/original.md]} # keep paths
  allow_failure: true
beta:
  stage: review
  instructions: Read the original report.
gate:
  stage: publish
  when: manual
`;
const hermes = `# Real forward-chain source.
kind: hermes_yaml
roles: {}
gates:
  approval: {type: manual, owner: reviewer}
states:
  collect:
    title: Collect every original instruction
    entry: |
      Preserve all of this text.
      Second line unchanged.
    gate: approval
    output: {report: original}
    exit_check: {expected: true}
  finish:
    entry: Finish the task.
edges:
  - {from: collect, to: finish, type: forward} # real state identifiers
`;
const apply = (text: string, command: CanvasCommand) =>
  applyCanvasEdit(text, command).source;
it("requires the compiler and dialect editing capabilities actually understood by the client", () => {
  const caps = PipelineCapabilitiesSchema.parse({
    schema_version: 1,
    compiler_version: "1",
    kinds: ["gitlab_yaml", "hermes_yaml"],
    features: {
      custom_nodes: true,
      manual_gates: true,
      gitlab_dag: true,
      hermes_forward_chain: true,
    },
  });
  expect(canvasCapabilityRestriction(caps, "gitlab_yaml")).toBeNull();
  expect(canvasCapabilityRestriction(caps, "hermes_yaml")).toBeNull();
  expect(canvasCapabilityRestriction(undefined, "gitlab_yaml")).toBeTruthy();
  expect(
    canvasCapabilityRestriction(
      { ...caps, compiler_version: "future" },
      "gitlab_yaml",
    ),
  ).toBeTruthy();
  expect(
    canvasCapabilityRestriction({ ...caps, schema_version: 2 }, "gitlab_yaml"),
  ).toBeTruthy();
  expect(
    canvasCapabilityRestriction(
      { ...caps, features: { ...caps.features, manual_gates: false } },
      "gitlab_yaml",
    ),
  ).toBeTruthy();
  expect(canvasCapabilityRestriction(caps, "future_yaml")).toBeTruthy();
});
function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(CanvasEditError);
    expect((error as CanvasEditError).code).toBe(code);
  }
}

it("projects explicit, stage-derived and material edges separately", () => {
  const text = source.replace(
    "  instructions: Read the original report.",
    "  instructions: Read the original report.\n  dependencies: [alpha]",
  );
  const model = readCanvasDocument(text);
  expect(model.restriction).toBeNull();
  expect(model.edges.filter((e) => e.to === "beta").map((e) => e.kind)).toEqual(
    ["stage", "material"],
  );
  expect(
    readCanvasDocument(
      apply(source, {
        type: "add_node",
        nodeType: "agent",
        fields: {
          id: "parallel",
          stage: "work",
          instructions: "Another independent task.",
        },
      }),
    ).nodes.map((n) => n.id),
  ).toContain("parallel");
});
it("renames only real IDs and references while preserving comments, paths and complete instructions", () => {
  const text = source.replace(
    "  instructions: Read the original report.",
    "  instructions: Read the original report.\n  needs: [alpha]",
  );
  const result = apply(text, {
    type: "update_node",
    id: "alpha",
    fields: { id: "renamed", role: "reviewer", retry: 2, when: "on_failure" },
  });
  const before = parse(text),
    after = parse(result);
  expect(after.renamed.instructions).toBe(before.alpha.instructions);
  expect(after.renamed.artifacts).toEqual(before.alpha.artifacts);
  expect(after.renamed.allow_failure).toBe(true);
  expect(after.beta.needs).toEqual(["renamed"]);
  expect(after.renamed).not.toHaveProperty("title");
  expect(after.renamed.tags).toEqual(["reviewer"]);
  expect(result).toContain("# Keep the complete user's document.");
  expect(result).toContain("# keep paths");
});
it("requires explicit review before replacing stage inference and removes only the chosen relationship", () => {
  const edge = readCanvasDocument(source).edges.find(
    (e) => e.from === "alpha" && e.to === "gate",
  )!;
  const command: CanvasCommand = { type: "delete_edge", id: edge.id };
  expect(canvasStageConversions(source, command)).toEqual(["gate"]);
  expectCode(() => apply(source, command), "inferred");
  const result = apply(source, { ...command, confirmInferred: true });
  expect(parse(result).gate.needs).toEqual(["beta"]);
  expect(parse(result).alpha.artifacts.paths).toEqual(["reports/original.md"]);
});
it("never discards dependencies to materialize a needs edge", () => {
  const text = source.replace(
    "  instructions: Read the original report.",
    "  instructions: Read the original report.\n  dependencies: [alpha]",
  );
  const id = readCanvasDocument(text).edges.find(
    (e) => e.to === "beta" && e.kind === "stage",
  )!.id;
  expectCode(
    () => apply(text, { type: "delete_edge", id, confirmInferred: true }),
    "material_conflict",
  );
  expect(parse(text).beta.dependencies).toEqual(["alpha"]);
});
it("edits an explicit material relation without deleting nodes or changing stage ordering", () => {
  const text =
    source +
    "final:\n  stage: publish\n  instructions: Publish.\n  dependencies: [alpha]\n";
  const id = readCanvasDocument(text).edges.find(
    (e) => e.to === "final" && e.kind === "material",
  )!.id;
  const result = apply(text, {
    type: "reconnect_edge",
    id,
    from: "beta",
    to: "final",
  });
  expect(parse(result).final.dependencies).toEqual(["beta"]);
  expect(parse(result).stages).toEqual(parse(text).stages);
  expect(readCanvasDocument(result).nodes).toHaveLength(4);
});
it("makes the material policy explicit without discarding inherited sources", () => {
  const result = apply(source, {
    type: "add_edge",
    from: "alpha",
    to: "gate",
    material: true,
  });
  expect(parse(result).gate.dependencies).toEqual(["alpha", "beta"]);
  expect(parse(result).gate).not.toHaveProperty("needs");
  expect(
    readCanvasDocument(result).edges.filter(
      (e) => e.to === "gate" && e.kind === "material",
    ),
  ).toHaveLength(2);
});
it("rejects cyclic, duplicate, foreign and later-stage edges transactionally", () => {
  const text =
    "kind: gitlab_yaml\nstages: [work]\na: {stage: work, instructions: A, needs: []}\nb: {stage: work, instructions: B, needs: [a]}\n";
  expectCode(
    () => apply(text, { type: "add_edge", from: "a", to: "a" }),
    "cycle",
  );
  expectCode(
    () => apply(text, { type: "add_edge", from: "b", to: "a" }),
    "cycle",
  );
  expectCode(
    () => apply(text, { type: "add_edge", from: "a", to: "b" }),
    "duplicate",
  );
  expectCode(
    () => apply(text, { type: "add_edge", from: "missing", to: "a" }),
    "missing",
  );
  const id = readCanvasDocument(text).edges[0]!.id;
  expectCode(
    () => apply(text, { type: "reconnect_edge", id, from: "b", to: "b" }),
    "cycle",
  );
  expect(parse(text).b.needs).toEqual(["a"]);
  expectCode(
    () =>
      apply(source, {
        type: "add_edge",
        from: "gate",
        to: "alpha",
        confirmInferred: true,
      }),
    "direction",
  );
});
it.each([-1, 1.5, 11, NaN])("rejects unsupported retry %s", (retry) =>
  expectCode(
    () =>
      apply(source, { type: "update_node", id: "alpha", fields: { retry } }),
    "retry",
  ),
);
it.each(["../secret", "/tmp/report", "a//b", "reports/*.md"])(
  "rejects nonexact material path %s",
  (path) =>
    expectCode(
      () =>
        apply(source, {
          type: "update_node",
          id: "alpha",
          fields: { paths: [path] },
        }),
      "paths",
    ),
);
it("deletes a node and its explicit references without bridging an intervening gate", () => {
  const text = source
    .replace(
      "  instructions: Read the original report.",
      "  instructions: Read the original report.\n  needs: [alpha]",
    )
    .replace("  when: manual", "  when: manual\n  needs: [beta]");
  const model = readCanvasDocument(text);
  expect(canvasDeletionImpact(model, "beta").edges).toHaveLength(2);
  const result = apply(text, { type: "delete_node", id: "beta" });
  expect(parse(result).gate.needs).toEqual([]);
  expect(parse(result).beta).toBeUndefined();
  expect(parse(result).alpha.instructions).toBe(parse(text).alpha.instructions);
});
it("creates a manual GitLab job without executor configuration", () => {
  const result = apply(source, {
    type: "add_node",
    nodeType: "manual",
    fields: {
      id: "another_gate",
      stage: "custom",
      owner: "human",
      allowFailure: true,
    },
  });
  expect(parse(result).another_gate).toMatchObject({
    stage: "custom",
    when: "manual",
    owner: "human",
    allow_failure: true,
  });
  expect(parse(result).another_gate).not.toHaveProperty("tags");
  expect(parse(result).stages).toContain("custom");
  expect(
    parse(
      apply(result, {
        type: "update_node",
        id: "another_gate",
        fields: { allowFailure: false },
      }),
    ).another_gate.allow_failure,
  ).toBe(false);
  expectCode(
    () =>
      apply(result, {
        type: "update_node",
        id: "another_gate",
        fields: { role: "reviewer" },
      }),
    "manual",
  );
});
describe("Hermes source mapping", () => {
  it("keeps virtual gates out of states and preserves custom output/entry content", () => {
    const model = readCanvasDocument(hermes);
    expect(model.restriction).toBeNull();
    expect(model.nodes.map((n) => n.id)).toEqual([
      "collect",
      "collect.gate.approval",
      "finish",
    ]);
    const result = apply(hermes, {
      type: "update_node",
      id: "collect",
      fields: { id: "research", title: "Research title", role: "reviewer" },
    });
    const parsed = parse(result);
    expect(parsed.states.research.entry).toBe(
      parse(hermes).states.collect.entry,
    );
    expect(parsed.states.research.output).toEqual({ report: "original" });
    expect(parsed.states.research.exit_check).toEqual({ expected: true });
    expect(parsed.roles).toEqual({ reviewer: {} });
    expect(parsed.edges[0].from).toBe("research");
    expect(parsed.states.research.gate).toBe("approval");
    expect(result).toContain("# real state identifiers");
  });
  it("creates, renames and removes a gate with its actual declaration/reference and no auto bridge", () => {
    let text = apply(hermes, {
      type: "add_node",
      nodeType: "manual",
      fields: { id: "review_final", afterState: "finish", owner: "human" },
    });
    text = apply(text, {
      type: "update_node",
      id: "finish.gate.review_final",
      fields: { id: "human_decision", owner: "new-owner" },
    });
    expect(parse(text).states.finish.gate).toBe("human_decision");
    expect(parse(text).gates.human_decision.owner).toBe("new-owner");
    expect(parse(text).states["finish.gate.human_decision"]).toBeUndefined();
    text = apply(text, { type: "delete_node", id: "collect.gate.approval" });
    expect(parse(text).states.collect.gate).toBeUndefined();
    expect(parse(text).gates.approval).toBeUndefined();
    expect(parse(text).edges).toEqual([]);
  });
  it("uses only forward state edges and disallows branches/joins, cycles and virtual gate targets", () => {
    const text = apply(hermes, {
      type: "add_node",
      nodeType: "agent",
      fields: { id: "extra", instructions: "Extra work." },
    });
    expectCode(
      () => apply(text, { type: "add_edge", from: "collect", to: "extra" }),
      "branch",
    );
    expectCode(
      () => apply(text, { type: "add_edge", from: "extra", to: "finish" }),
      "branch",
    );
    expectCode(
      () => apply(text, { type: "add_edge", from: "finish", to: "collect" }),
      "cycle",
    );
    expectCode(
      () =>
        apply(text, {
          type: "add_edge",
          from: "finish",
          to: "collect.gate.approval",
        }),
      "gate",
    );
    const result = apply(text, {
      type: "add_edge",
      from: "finish",
      to: "extra",
    });
    expect(parse(result).edges.at(-1)).toEqual({
      from: "finish",
      to: "extra",
      type: "forward",
    });
  });
  it("moves role bindings without removing declarations still used elsewhere", () => {
    let text = apply(hermes, {
      type: "update_node",
      id: "collect",
      fields: { role: "reviewer" },
    });
    text = apply(text, {
      type: "update_node",
      id: "finish",
      fields: { role: "reviewer" },
    });
    text = apply(text, {
      type: "update_node",
      id: "collect",
      fields: { role: "" },
    });
    expect(parse(text).roles).toEqual({ reviewer: {} });
    expect(parse(text).states.collect.by).toBeUndefined();
    expect(parse(text).states.finish.by).toBe("reviewer");
  });
});
it.each([
  "kind: future_yaml\nstates: {}\n",
  "kind: gitlab_yaml\nstages: [",
  "kind: gitlab_yaml\nstages: [w]\na: {stage: w, instructions: A, when: always}\n",
  "kind: gitlab_yaml\nstages: [w]\na: {stage: w, instructions: A, future: value}\n",
  "kind: gitlab_yaml\nstages: [w]\na: &a {stage: w, instructions: A}\nb: *a\n",
])("keeps unsafe source read-only without changing its bytes", (text) => {
  expect(readCanvasDocument(text).restriction).toBeTruthy();
  expect(() =>
    apply(text, {
      type: "add_node",
      nodeType: "agent",
      fields: { id: "new", instructions: "New instruction." },
    }),
  ).toThrow(CanvasEditError);
});
it("starts from empty source without inserting a fixed workflow", () => {
  const text = apply("", {
    type: "add_node",
    nodeType: "agent",
    fields: {
      id: "custom",
      stage: "mine",
      instructions: "My complete original instruction.",
    },
  });
  expect(readCanvasDocument(text).nodes.map((n) => n.id)).toEqual(["custom"]);
  expect(parse(text).stages).toEqual(["mine"]);
});
