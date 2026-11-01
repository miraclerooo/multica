import { test, expect, type Page, type Locator } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createTestApi } from "./helpers";

test.use({ actionTimeout: 15_000 });
const check = expect.configure({ timeout: 15_000 });
const gitlab = `# Preserve this complete document and its inline comments.
kind: gitlab_yaml
stages: [research, check, publish]
alpha:
  stage: research
  instructions: |
    Preserve this entire original instruction.
    URL: https://example.test/report#section
    A third line stays intact.
  artifacts: {paths: [reports/original.md]} # exact original path
beta:
  stage: check
  instructions: Keep the second instruction unchanged.
gate:
  stage: publish
  when: manual
`;
const hermes = `# Hermes owns real states and gate declarations.
kind: hermes_yaml
roles: {}
gates:
  approval: {type: manual, owner: human_reviewer}
states:
  collect:
    title: Collect full context
    entry: |
      Keep this complete entry.
      Keep its second line.
    gate: approval
    output: {report: original}
    exit_check: {expected: true}
  finish:
    entry: Keep the finishing instruction.
edges:
  - {from: collect, to: finish, type: forward}
`;
async function fixture(page: Page, source = gitlab) {
  const api = await createTestApi(),
    workspace = (await api.getWorkspaces())[0]!;
  const project = await api.createProject("Canvas canonical browser checks");
  const seed = await api.createIssue("Fake executor identity", {
    project_id: project.id,
  });
  const agent = await api.seedDocumentAgent(seed.id);
  const post = async (path: string, body: unknown) => {
    const response = await api.request(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    check(response.status, await response.clone().text()).toBeLessThan(300);
    return response.json();
  };
  const squad = await post("/api/squads", {
    name: "Canvas research squad",
    leader_id: agent.agentId,
  });
  const me = await (await api.request("/api/me")).json();
  await post(`/api/squads/${squad.id}/members`, {
    member_type: "member",
    member_id: me.id,
    role: "human_reviewer",
  });
  const role = await api.request(`/api/squads/${squad.id}/members/role`, {
    method: "PATCH",
    body: JSON.stringify({
      member_type: "agent",
      member_id: agent.agentId,
      role: "reviewer",
    }),
  });
  check(role.ok).toBe(true);
  const catalog = await post("/api/pipelines/catalog", {
    squad_id: squad.id,
    name: "Original custom canvas",
    source,
    idempotency_key: randomUUID(),
  });
  const ids: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((token) => {
    localStorage.setItem("multica_token", token!);
    localStorage.setItem("multica:chat:isOpen", "false");
  }, api.getToken());
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto(`/${workspace.slug}/squads/${squad.id}`);
  await page.getByRole("button", { name: "Pipeline", exact: true }).click();
  await check(
    page.getByRole("textbox", { name: "YAML", exact: true }),
  ).toHaveValue(source);
  const graph = async () => {
    await page.getByRole("button", { name: "Flow graph", exact: true }).click();
    await check(page.getByTestId("pipeline-canvas")).toBeVisible();
  };
  const text = async () => {
    await page.getByRole("button", { name: "YAML", exact: true }).click();
    return page
      .getByRole("textbox", { name: "YAML", exact: true })
      .inputValue();
  };
  const selectNode = async (id: string) => {
    await page
      .getByRole("combobox", { name: "Select node", exact: true })
      .selectOption(id);
    return page.getByTestId("canvas-properties");
  };
  const addNode = async (id: string, stage: string, instructions: string) => {
    await page
      .getByRole("button", { name: "Add execution node", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Add execution node",
      exact: true,
    });
    await dialog
      .getByRole("textbox", { name: "Node ID", exact: true })
      .fill(id);
    if (await dialog.getByLabel("Stage", { exact: true }).count())
      await dialog.getByLabel("Stage", { exact: true }).fill(stage);
    await dialog
      .getByRole("textbox", { name: "Complete instructions", exact: true })
      .fill(instructions);
    await dialog
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await check(
      page
        .getByTestId("canvas-properties")
        .getByRole("textbox", { name: "Node ID", exact: true }),
    ).toHaveValue(id);
  };
  return {
    api,
    workspace,
    agent,
    squad,
    catalog,
    post,
    ids,
    errors,
    graph,
    text,
    selectNode,
    addNode,
    cleanup: async () => {
      for (const id of ids)
        await api.request(`/api/issues/${id}`, { method: "DELETE" });
      await api.removePipelineSquadFixture(squad.id);
      await api.cleanup();
    },
  };
}
async function drag(page: Page, from: Locator, to: Locator) {
  await check(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
  await from.scrollIntoViewIfNeeded();
  const a = await from.boundingBox(),
    b = await to.boundingBox();
  check(a).not.toBeNull();
  check(b).not.toBeNull();
  const startHit = await from.evaluate((el) => {
    const r = el.getBoundingClientRect(),
      hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      expected: el.getAttribute("aria-label"),
      actual: hit?.closest("button")?.getAttribute("aria-label"),
      tag: hit?.tagName,
    };
  });
  check(startHit.actual, JSON.stringify(startHit)).toBe(startHit.expected);
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2);
  await page.mouse.down();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, {
    steps: 12,
  });
  const hit = await to.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(
      r.x + r.width / 2,
      r.y + r.height / 2,
    );
    return {
      expected: el.getAttribute("aria-label"),
      actual: hit?.closest("button")?.getAttribute("aria-label"),
      tag: hit?.tagName,
    };
  });
  check(hit.actual, JSON.stringify(hit)).toBe(hit.expected);
  await page.mouse.up();
}
const screenshot = (page: Page, path: string) =>
  page.screenshot({
    path,
    fullPage: true,
    animations: "disabled",
    style: "nextjs-portal { display: none !important; }",
  });

test("edits the actual GitLab document through nodes, dragged connections and server-compiled immutable versions", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const f = await fixture(page);
  try {
    const frozen = await f.post("/api/issues", {
      title: "Frozen before canvas editing",
      assignee_type: "squad",
      assignee_id: f.squad.id,
      execution: {
        mode: "pipeline",
        pipeline_id: f.catalog.pipeline.id,
        definition_id: f.catalog.definition.id,
      },
      idempotency_key: randomUUID(),
    });
    f.ids.push(frozen.id);
    await f.graph();
    await f.addNode(
      "delta",
      "check",
      "A complete new delta instruction.\nSecond delta line.",
    );
    await f.addNode(
      "parallel",
      "check",
      "An independent parallel instruction.",
    );
    let properties = await f.selectNode("alpha");
    const newInstructions =
      "The complete edited instruction.\nURL: https://example.test/report#section\nA third line stays intact.\nFourth explicit line.";
    await properties
      .getByRole("textbox", { name: "Node ID", exact: true })
      .fill("researcher");
    await properties
      .getByRole("textbox", { name: "Node ID", exact: true })
      .press("Delete");
    await check(
      page.getByRole("dialog", { name: "Review node deletion", exact: true }),
    ).toHaveCount(0);
    await properties
      .getByRole("textbox", { name: "Complete instructions", exact: true })
      .fill(newInstructions);
    await properties
      .getByRole("combobox", { name: "Execution role", exact: true })
      .selectOption("reviewer");
    await properties
      .getByRole("spinbutton", { name: "Retries (0–10)", exact: true })
      .fill("2");
    await properties
      .getByRole("combobox", { name: "Condition", exact: true })
      .selectOption("on_failure");
    await properties
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await check(page.locator('[data-canvas-node="researcher"]')).toBeVisible();
    await page.getByRole("button", { name: "Fit view", exact: true }).click();
    await drag(
      page,
      page.getByRole("button", { name: "Connect from delta", exact: true }),
      page.getByRole("button", { name: "Connect to beta", exact: true }),
    );
    await page
      .getByRole("dialog", { name: "Replace stage inference", exact: true })
      .getByRole("button", { name: "Confirm change", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Select connection", exact: true })
      .selectOption(JSON.stringify(["needs", "delta", "beta"]));
    await drag(
      page,
      page.getByRole("button", { name: "Reconnect start", exact: true }),
      page.getByRole("button", { name: "Connect from parallel", exact: true }),
    );
    await page
      .getByRole("combobox", { name: "Select connection", exact: true })
      .selectOption(JSON.stringify(["needs", "parallel", "beta"]));
    await drag(
      page,
      page.getByRole("button", { name: "Reconnect end", exact: true }),
      page.getByRole("button", { name: "Connect to delta", exact: true }),
    );
    await page
      .getByRole("dialog", { name: "Replace stage inference", exact: true })
      .getByRole("button", { name: "Confirm change", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Select connection", exact: true })
      .selectOption(JSON.stringify(["needs", "parallel", "delta"]));
    await page
      .getByRole("button", { name: "Delete connection", exact: true })
      .click();
    await check(page.locator("[data-canvas-node]")).toHaveCount(5);
    const beforeDelete = await f.text();
    await f.graph();
    properties = await f.selectNode("gate");
    await check(
      properties.getByRole("combobox", { name: "Execution role", exact: true }),
    ).toHaveCount(0);
    await check(properties.getByRole("spinbutton")).toHaveCount(0);
    await properties
      .getByRole("button", { name: "Delete node", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Review node deletion", exact: true })
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    check(await f.text()).toBe(beforeDelete);
    await f.graph();
    properties = await f.selectNode("gate");
    await properties
      .getByRole("button", { name: "Delete node", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Review node deletion", exact: true })
      .getByRole("button", { name: "Confirm change", exact: true })
      .click();
    await check(page.locator("[data-canvas-node]")).toHaveCount(4);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await check(page.locator("[data-canvas-node]")).toHaveCount(5);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await check(page.locator("[data-canvas-node]")).toHaveCount(4);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    const beforeLayout = await f.text();
    await f.graph();
    await page.getByRole("button", { name: "Fit view", exact: true }).click();
    const card = page.locator('[data-canvas-node="researcher"] .pipeline-node');
    await card.scrollIntoViewIfNeeded();
    const position = await card.boundingBox();
    check(position).not.toBeNull();
    await page.mouse.move(
      position!.x + position!.width / 2,
      position!.y + position!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      position!.x + position!.width / 2 + 42,
      position!.y + position!.height / 2 + 24,
      { steps: 10 },
    );
    await page.mouse.up();
    const moved = await card.boundingBox();
    check(moved!.x - position!.x).toBeGreaterThan(35);
    check(await f.text()).toBe(beforeLayout);
    await f.graph();
    const beforeZoom = await card.boundingBox();
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    check((await card.boundingBox())!.width).toBeGreaterThan(beforeZoom!.width);
    const viewport = page
        .getByTestId("pipeline-canvas")
        .locator(".pipeline-canvas-viewport"),
      area = await viewport.boundingBox();
    check(area).not.toBeNull();
    const beforePan = await card.boundingBox();
    await page.mouse.move(area!.x + 30, area!.y + area!.height - 20);
    await page.mouse.down();
    await page.mouse.move(area!.x + 65, area!.y + area!.height - 10, {
      steps: 8,
    });
    await page.mouse.up();
    check((await card.boundingBox())!.x - beforePan!.x).toBeGreaterThan(25);
    check(await f.text()).toBe(beforeLayout);
    await f.graph();
    await page.getByRole("button", { name: "Fit view", exact: true }).click();
    await screenshot(page, info.outputPath("canvas-gitlab-desktop.png"));
    await page.emulateMedia({ colorScheme: "dark" });
    await check(page.locator("html")).toHaveClass(/dark/);
    await screenshot(page, info.outputPath("canvas-gitlab-dark.png"));
    await page.emulateMedia({ colorScheme: "light" });
    const finalSource = await f.text();
    check(finalSource).toContain("# Preserve this complete document");
    check(finalSource).toContain("# exact original path");
    check(finalSource).not.toContain("always");
    const save = page.getByRole("button", {
      name: "Save version",
      exact: true,
    });
    await check(save).toBeEnabled();
    const pending = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/pipelines/definitions") &&
        r.request().method() === "POST",
    );
    await save.click();
    const savedResponse = await pending;
    check(savedResponse.status()).toBe(201);
    const saved = await savedResponse.json();
    check(saved.pipeline_id).toBe(f.catalog.pipeline.id);
    check(saved.revision).toBe(2);
    check(saved.source).toBe(finalSource);
    check(saved.source_hash).toBe(
      createHash("sha256").update(finalSource).digest("hex"),
    );
    check(saved.plan.source_hash).toBe(saved.source_hash);
    check(
      saved.plan.nodes.find((n: { id: string }) => n.id === "researcher"),
    ).toMatchObject({
      instructions: newInstructions,
      role: "reviewer",
      retry: 2,
      when: "on_failure",
      paths: ["reports/original.md"],
    });
    check(
      saved.plan.nodes.find((n: { id: string }) => n.id === "beta")
        .instructions,
    ).toBe("Keep the second instruction unchanged.");
    check(
      saved.plan.nodes.find((n: { id: string }) => n.id === "delta").needs,
    ).toEqual(["researcher"]);
    const selection = await (
      await f.api.request(`/api/issues/${frozen.id}/execution`)
    ).json();
    check(selection.execution.definition_id).toBe(f.catalog.definition.id);
    const squad = await (
      await f.api.request(`/api/squads/${f.squad.id}`)
    ).json();
    check(squad.instructions_mode).toBe("markdown");
    const original = await (
      await f.api.request(
        `/api/pipelines/definitions/${f.catalog.definition.id}`,
      )
    ).json();
    check(original.source).toBe(gitlab);
    await writeFile(
      info.outputPath("canvas-gitlab-response.json"),
      JSON.stringify({ saved, selection, squad, original }, null, 2),
    );
    check(f.errors).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("edits Hermes states and real manual gates at 390px, then creates an independent empty pipeline", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const f = await fixture(page, hermes);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await f.graph();
    await page
      .getByRole("button", { name: "Add execution node", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Add execution node", exact: true })
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await check(
      page.getByRole("button", { name: "Add execution node", exact: true }),
    ).toBeFocused();
    await f.addNode(
      "research",
      "",
      "Read every original context line.\nProduce a complete research report.",
    );
    let properties = page.getByTestId("canvas-properties");
    await properties
      .getByRole("textbox", { name: "Title", exact: true })
      .fill("Research complete context");
    await properties
      .getByRole("combobox", { name: "Execution role", exact: true })
      .selectOption("reviewer");
    await properties
      .getByRole("textbox", {
        name: "Exact output paths, one per line",
        exact: true,
      })
      .fill("reports/research.md");
    await properties
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await check(
      page.getByRole("button", { name: "Save version", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Add connection", exact: true })
      .click();
    let dialog = page.getByRole("dialog", {
      name: "Add connection",
      exact: true,
    });
    await dialog
      .getByRole("combobox", { name: "From node", exact: true })
      .selectOption("finish");
    await dialog
      .getByRole("combobox", { name: "To node", exact: true })
      .selectOption("research");
    await dialog
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add manual gate", exact: true })
      .click();
    dialog = page.getByRole("dialog", { name: "Add manual gate", exact: true });
    await dialog
      .getByRole("textbox", { name: "Gate ID", exact: true })
      .fill("human_release");
    await dialog
      .getByRole("combobox", { name: "After state", exact: true })
      .selectOption("research");
    await dialog
      .getByRole("textbox", { name: "Human owner role", exact: true })
      .fill("human_reviewer");
    await dialog
      .getByRole("textbox", { name: "Human owner role", exact: true })
      .press("Enter");
    properties = page.getByTestId("canvas-properties");
    await check(
      properties.getByRole("textbox", { name: "Gate ID", exact: true }),
    ).toHaveValue("human_release");
    await check(
      properties.getByRole("combobox", { name: "Execution role", exact: true }),
    ).toHaveCount(0);
    await check(properties.getByRole("spinbutton")).toHaveCount(0);
    await check(
      properties.getByRole("textbox", { name: "Output (YAML)", exact: true }),
    ).toHaveCount(0);
    await properties.scrollIntoViewIfNeeded();
    await screenshot(page, info.outputPath("canvas-hermes-gate-390.png"));
    properties = await f.selectNode("collect");
    await properties
      .getByRole("textbox", { name: "Node ID", exact: true })
      .fill("context");
    await properties
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    properties = await f.selectNode("context.gate.approval");
    await properties
      .getByRole("textbox", { name: "Gate ID", exact: true })
      .fill("context_review");
    await properties
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    const beforeIllegal = await f.text();
    await f.graph();
    await page
      .getByRole("button", { name: "Add connection", exact: true })
      .click();
    dialog = page.getByRole("dialog", { name: "Add connection", exact: true });
    await dialog
      .getByRole("combobox", { name: "From node", exact: true })
      .selectOption("context");
    await dialog
      .getByRole("combobox", { name: "To node", exact: true })
      .selectOption("research");
    await dialog
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await check(dialog).toContainText(
      "one forward chain without branches or joins",
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    check(await f.text()).toBe(beforeIllegal);
    await f.graph();
    properties = await f.selectNode("context.gate.context_review");
    await properties
      .getByRole("button", { name: "Delete node", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Review node deletion", exact: true })
      .getByRole("button", { name: "Confirm change", exact: true })
      .click();
    await check(
      page.getByRole("button", { name: "Save version", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    check(await f.text()).toBe(beforeIllegal);
    await f.graph();
    await page.getByRole("button", { name: "Fit view", exact: true }).click();
    await page
      .getByTestId("pipeline-canvas")
      .locator(".pipeline-canvas-viewport")
      .scrollIntoViewIfNeeded();
    await screenshot(page, info.outputPath("canvas-hermes-chain-390.png"));
    await check(
      page.getByRole("button", { name: "Save version", exact: true }),
    ).toBeEnabled();
    const pending = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/pipelines/definitions") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Save version", exact: true })
      .click();
    const saved = await (await pending).json();
    check(saved.revision).toBe(2);
    check(saved.plan.nodes).toHaveLength(5);
    check(
      saved.plan.nodes.find((n: { id: string }) => n.id === "context"),
    ).toMatchObject({
      instructions: "Keep this complete entry.\nKeep its second line.\n",
      output: { report: "original" },
      exit_check: { expected: true },
    });
    check(
      saved.plan.nodes.find(
        (n: { id: string }) => n.id === "context.gate.context_review",
      ),
    ).toMatchObject({ type: "manual", source_id: "context" });
    check(
      saved.plan.nodes.find((n: { id: string }) => n.id === "research"),
    ).toMatchObject({ role: "reviewer", paths: ["reports/research.md"] });
    check(saved.source).not.toContain("  context.gate.");
    await page
      .getByRole("button", { name: "New pipeline", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Pipeline name", exact: true })
      .fill("My empty Hermes pipeline");
    await f.graph();
    await page
      .getByRole("button", { name: "Empty Hermes canvas", exact: true })
      .click();
    await f.addNode(
      "solo",
      "",
      "The only state in this intentionally empty pipeline.",
    );
    await page.getByRole("button", { name: "Fit view", exact: true }).click();
    check(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page
      .getByTestId("pipeline-canvas")
      .locator(".pipeline-canvas-viewport")
      .scrollIntoViewIfNeeded();
    await screenshot(page, info.outputPath("canvas-new-empty-390.png"));
    await check(
      page.getByRole("button", { name: "Save version", exact: true }),
    ).toBeEnabled();
    const creating = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/pipelines/catalog") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Save version", exact: true })
      .click();
    const created = await (await creating).json();
    check(created.pipeline.id).not.toBe(f.catalog.pipeline.id);
    check(created.pipeline.name).toBe("My empty Hermes pipeline");
    check(created.definition.revision).toBe(1);
    check(
      created.definition.plan.nodes.map((n: { id: string }) => n.id),
    ).toEqual(["solo"]);
    const old = await (
      await f.api.request(
        `/api/pipelines/definitions?pipeline_id=${f.catalog.pipeline.id}&squad_id=${f.squad.id}`,
      )
    ).json();
    check(old.items).toHaveLength(2);
    await writeFile(
      info.outputPath("canvas-hermes-response.json"),
      JSON.stringify({ saved, created, old }, null, 2),
    );
    check(f.errors).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("keeps invalid source, two drafts, historical versions and real 409 comparison/reload separate", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const f = await fixture(page);
  try {
    const second = await f.post("/api/pipelines/catalog", {
      squad_id: f.squad.id,
      name: "Separate second pipeline",
      source: hermes,
      idempotency_key: randomUUID(),
    });
    await f.graph();
    const properties = await f.selectNode("alpha");
    await properties
      .getByRole("textbox", { name: "Complete instructions", exact: true })
      .fill("Retained first pipeline canvas edit.");
    await properties
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    const local = await f.text();
    await page
      .getByRole("combobox", { name: "Pipelines", exact: true })
      .selectOption(second.pipeline.id);
    await check(
      page.getByRole("textbox", { name: "YAML", exact: true }),
    ).toHaveValue(hermes);
    await page
      .getByRole("textbox", { name: "YAML", exact: true })
      .fill(hermes + "# Isolated second draft\n");
    await page
      .getByRole("combobox", { name: "Pipelines", exact: true })
      .selectOption(f.catalog.pipeline.id);
    await check(
      page.getByRole("textbox", { name: "YAML", exact: true }),
    ).toHaveValue(local);
    await page
      .getByRole("textbox", { name: "YAML", exact: true })
      .fill("kind: gitlab_yaml\nstages: [");
    await f.graph();
    await check(
      page.getByText(/last available diagram is read-only/),
    ).toBeVisible();
    await check(
      page.getByRole("button", { name: "Add execution node", exact: true }),
    ).toBeDisabled();
    await check(
      page.getByRole("button", { name: "Save version", exact: true }),
    ).toBeDisabled();
    await screenshot(
      page,
      info.outputPath("canvas-invalid-source-readonly.png"),
    );
    check(await f.text()).toBe("kind: gitlab_yaml\nstages: [");
    await page
      .getByRole("textbox", { name: "YAML", exact: true })
      .press("Meta+z");
    await check(
      page.getByRole("textbox", { name: "YAML", exact: true }),
    ).toHaveValue(local);
    await page.reload();
    await page.getByRole("button", { name: "Pipeline", exact: true }).click();
    await check(
      page.getByRole("textbox", { name: "YAML", exact: true }),
    ).toHaveValue(local);
    const current = await (
      await f.api.request(`/api/pipelines/catalog/${f.catalog.pipeline.id}`)
    ).json();
    const concurrent = await f.post("/api/pipelines/definitions", {
      squad_id: f.squad.id,
      pipeline_id: f.catalog.pipeline.id,
      expected_pipeline_revision: current.revision,
      source: gitlab.replace(
        "Keep the second instruction unchanged.",
        "A concurrent saved instruction.",
      ),
      idempotency_key: randomUUID(),
    });
    await check(
      page.getByRole("button", { name: "Save version", exact: true }),
    ).toBeEnabled();
    const rejected = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/pipelines/definitions") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Save version", exact: true })
      .click();
    check((await rejected).status()).toBe(409);
    const comparison = page.getByRole("dialog");
    await check(comparison).toContainText(
      "Retained first pipeline canvas edit.",
    );
    await check(comparison).toContainText("A concurrent saved instruction.");
    const fitsComparison = async () => {
      check(await comparison.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      const bounds = await comparison.boundingBox();
      for (const button of await comparison.getByRole("button").all()) {
        const box = await button.boundingBox();
        check(box).not.toBeNull();
        check(box!.x).toBeGreaterThanOrEqual(bounds!.x);
        check(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
      }
    };
    await fitsComparison();
    await screenshot(page, info.outputPath("canvas-real-409.png"));
    await page.setViewportSize({width:390,height:844});
    await fitsComparison();
    await screenshot(page, info.outputPath("canvas-real-409-390.png"));
    await comparison
      .getByRole("button", { name: "Reload current version", exact: true })
      .click();
    await check(
      page.getByRole("textbox", { name: "YAML", exact: true }),
    ).toHaveValue(concurrent.source);
    await page.setViewportSize({width:1440,height:1000});
    await page
      .getByRole("button", { name: "Restore kept draft", exact: true })
      .click();
    await check(
      page.getByRole("textbox", { name: "YAML", exact: true }),
    ).toHaveValue(local);
    await check(
      page.getByRole("button", { name: "Save version", exact: true }),
    ).toBeEnabled();
    const saving = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/pipelines/definitions") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Save version", exact: true })
      .click();
    const saved = await (await saving).json();
    check(saved.revision).toBe(3);
    check(saved.source).toBe(local);
    await page.getByText("Version history", { exact: true }).click();
    const row = page
      .locator(".pipeline-toolbar.justify-between")
      .filter({ hasText: /v1 · gitlab_yaml/ });
    await row.getByRole("button", { name: "Open source", exact: true }).click();
    await check(
      page.getByText(
        "Historical version — read-only. Open the current definition to edit.",
        { exact: true },
      ),
    ).toBeVisible();
    await check(
      page.getByRole("textbox", { name: "YAML", exact: true }),
    ).toHaveAttribute("readonly");
    await f.graph();
    await check(
      page.getByRole("button", { name: "Add execution node", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Edit current definition", exact: true })
      .click();
    await check(
      page.getByRole("button", { name: "Add execution node", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("combobox", { name: "Pipelines", exact: true })
      .selectOption(second.pipeline.id);
    await check(
      page.getByRole("textbox", { name: "YAML", exact: true }),
    ).toHaveValue(hermes + "# Isolated second draft\n");
    await writeFile(
      info.outputPath("canvas-conflict-response.json"),
      JSON.stringify({ concurrent, saved }, null, 2),
    );
    check(f.errors).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
