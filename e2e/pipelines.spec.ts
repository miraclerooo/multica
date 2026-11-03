import { test, expect as baseExpect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createTestApi } from "./helpers";

const expect = baseExpect.configure({ timeout: 15_000 });
const runtimeErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
  expect(runtimeErrors.get(page)).toEqual([]);
});

test.use({ actionTimeout: 15_000 });

const source = `kind: gitlab_yaml
stages: [investigate, review]
read_sources:
  stage: investigate
  instructions: Preserve the original custom instruction.
  artifacts: {paths: [reports/context.md]}
confirm_findings:
  stage: review
  needs: [read_sources]
  when: manual
`;
const hermes = `kind: hermes_yaml
id: custom-context
roles: {}
states:
  collect_context:
    entry: Preserve this custom Hermes instruction.
gates: {}
edges: []
`;
async function setup(page: Page) {
  const api = await createTestApi();
  const workspace = (await api.getWorkspaces())[0]!;
  const project = await api.createProject("Pipeline acceptance workspace");
  const issue = await api.createIssue("Custom pipeline UI verification", {
    project_id: project.id,
    status: "todo",
  });
  const agent = await api.seedDocumentAgent(issue.id);
  const res = await api.request("/api/squads", {
    method: "POST",
    body: JSON.stringify({ name: "Research team", leader_id: agent.agentId }),
  });
  expect(res.status).toBe(201);
  const squad = await res.json();
  await page.addInitScript((token) => {
    if (window.top !== window) return;
    localStorage.setItem("multica_token", token!);
    localStorage.setItem("multica:chat:isOpen", "false");
  }, api.getToken());
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  return {
    api,
    workspace,
    project,
    issue,
    squad,
    cleanup: async () => {
      await api.removePipelineSquadFixture(squad.id);
      await api.cleanup();
    },
  };
}

test("preserves independent custom sources in dialogs and atomically enables a reviewed version", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const f = await setup(page);
  try {
    await page.goto(`/${f.workspace.slug}/squads/${f.squad.id}`);
    await page
      .getByRole("button", { name: "Execution mode", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Execution mode", exact: true })
      .selectOption("pipeline");
    await page
      .getByRole("button", { name: "Preview default workflow", exact: true })
      .click();
    const dialog = page.getByTestId("pipeline-editor-dialog"),
      editor = dialog.getByRole("textbox", { name: "YAML", exact: true });
    await dialog
      .getByRole("textbox", { name: "Pipeline name", exact: true })
      .fill("Custom preserved workflow");
    await dialog.getByRole("tab", { name: "Source", exact: true }).click();
    await editor.fill(source);
    await expect(dialog.getByLabel("Dialect", { exact: true })).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Save and enable", exact: true }),
    ).toBeEnabled({ timeout: 15_000 });
    await dialog.getByRole("tab", { name: "Flow graph", exact: true }).click();
    await expect(
      dialog.locator('[data-canvas-node="read_sources"]'),
    ).toHaveCount(1);
    await expect(
      dialog.locator('[data-canvas-node="confirm_findings"]'),
    ).toHaveCount(1);
    await page.screenshot({
      style: "nextjs-portal {display:none!important}",
      path: info.outputPath("definition-real-plan.png"),
    });
    const changed = await f.api.request(`/api/squads/${f.squad.id}`, {
      method: "PUT",
      body: JSON.stringify({ description: "A concurrent management edit" }),
    });
    expect(changed.ok).toBe(true);
    await dialog
      .getByRole("button", { name: "Save and enable", exact: true })
      .click();
    const conflict = page.getByRole("dialog", {
      name: "Compare latest",
      exact: true,
    });
    await expect(conflict).toBeVisible({ timeout: 15_000 });
    await conflict
      .getByRole("button", { name: "Use reviewed latest version", exact: true })
      .click();
    await dialog.getByRole("tab", { name: "Source", exact: true }).click();
    await expect(editor).toHaveValue(source);
    await dialog
      .getByRole("button", { name: "Save and enable", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    const enabled = await (
      await f.api.request(`/api/squads/${f.squad.id}`)
    ).json();
    expect(enabled.instructions_mode).toBe("pipeline");
    const definition = await (
      await f.api.request(
        `/api/pipelines/definitions/${enabled.pipeline_definition_id}`,
      )
    ).json();
    expect(definition.source).toBe(source);
    await page.getByRole("button", { name: "Pipeline", exact: true }).click();
    await page
      .getByRole("button", { name: "New pipeline", exact: true })
      .click();
    await dialog
      .getByRole("textbox", { name: "Pipeline name", exact: true })
      .fill("Separate Hermes workflow");
    await dialog.getByRole("tab", { name: "Source", exact: true }).click();
    await editor.fill(hermes);
    await expect(
      dialog.getByRole("button", { name: "Save version", exact: true }),
    ).toBeEnabled({ timeout: 15_000 });
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/pipelines/catalog") &&
        r.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "Save version", exact: true })
      .click();
    const separate = await (await response).json();
    await expect(dialog).toHaveCount(0);
    await page.reload();
    await page.getByRole("button", { name: "Pipeline", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Choose a pipeline", exact: true })
      .selectOption(separate.pipeline.id);
    await page
      .getByRole("button", { name: "Edit pipeline", exact: true })
      .click();
    await dialog.getByRole("tab", { name: "Source", exact: true }).click();
    await expect(editor).toHaveValue(hermes);
    const unchanged = await (
      await f.api.request(`/api/squads/${f.squad.id}`)
    ).json();
    expect(unchanged.pipeline_definition_id).toBe(
      enabled.pipeline_definition_id,
    );
    await writeFile(
      info.outputPath("independent-sources.json"),
      JSON.stringify({ enabled, definition, separate, unchanged }, null, 2),
    );
  } finally {
    await f.cleanup();
  }
});

test("declares a selected Hermes squad role and keeps leader fallback valid", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const f = await setup(page);
  try {
    const role = await f.api.request(`/api/squads/${f.squad.id}/members/role`, {
      method: "PATCH",
      body: JSON.stringify({
        member_type: "agent",
        member_id: f.squad.leader_id,
        role: "reviewer",
      }),
    });
    expect(role.ok).toBe(true);
    await page.goto(`/${f.workspace.slug}/squads/${f.squad.id}`);
    await page.getByRole("button", { name: "Pipeline", exact: true }).click();
    await page
      .getByRole("button", { name: "New pipeline", exact: true })
      .click();
    const dialog = page.getByTestId("pipeline-editor-dialog");
    await dialog
      .getByRole("textbox", { name: "Pipeline name", exact: true })
      .fill("Preserved Hermes workflow");
    const original =
      "kind: hermes_yaml\n# Preserve the user's workflow.\nroles: {}\nstates:\n  collect:\n    entry: Preserve the original instruction.\n";
    await dialog.getByRole("tab", { name: "Source", exact: true }).click();
    const editor = dialog.getByRole("textbox", { name: "YAML", exact: true });
    await editor.fill(original);
    await expect(
      dialog.getByRole("button", { name: "Save version", exact: true }),
    ).toBeEnabled({ timeout: 15_000 });
    await dialog.getByRole("tab", { name: "Flow graph", exact: true }).click();
    await dialog.locator('[data-canvas-node="collect"] .pipeline-node').click();
    let properties = dialog.getByTestId("canvas-properties");
    await properties
      .getByRole("combobox", { name: "Executor", exact: true })
      .selectOption("role:reviewer");
    const selectedResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/pipelines/validate") &&
        (r.request().postData() ?? "").includes("by: reviewer"),
    );
    await properties
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    const selected = await (await selectedResponse).json();
    expect(selected).toMatchObject({ syntax_valid: true, binding_valid: true });
    expect(selected.plan.nodes[0].role).toBe("reviewer");
    await dialog.getByRole("tab", { name: "Source", exact: true }).click();
    const selectedSource = await editor.inputValue();
    expect(selectedSource).toContain("# Preserve the user's workflow.");
    expect(selectedSource).toContain(
      "entry: Preserve the original instruction.",
    );
    await dialog.getByRole("tab", { name: "Flow graph", exact: true }).click();
    await page.screenshot({
      style: "nextjs-portal {display:none!important}",
      path: info.outputPath("hermes-role-selected.png"),
    });
    properties = dialog.getByTestId("canvas-properties");
    await properties
      .getByRole("combobox", { name: "Executor", exact: true })
      .selectOption("leader");
    const leaderResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/pipelines/validate") &&
        !(r.request().postData() ?? "").includes("by: reviewer"),
    );
    await properties
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    const leader = await (await leaderResponse).json();
    expect(leader).toMatchObject({ syntax_valid: true, binding_valid: true });
    expect(leader.plan.nodes[0].role).toBe("");
    await expect(
      properties.getByRole("combobox", { name: "Executor", exact: true }),
    ).toHaveValue("leader");
    await expect(
      dialog.getByRole("button", { name: "Save version", exact: true }),
    ).toBeEnabled({ timeout: 15_000 });
    await page.screenshot({
      style: "nextjs-portal {display:none!important}",
      path: info.outputPath("hermes-role-leader.png"),
    });
    await dialog.getByRole("tab", { name: "Source", exact: true }).click();
    await writeFile(
      info.outputPath("hermes-role-validation.json"),
      JSON.stringify(
        {
          original_source: original,
          selected: { source: selectedSource, validation: selected },
          leader: { source: await editor.inputValue(), validation: leader },
        },
        null,
        2,
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("opens fixed materials, links Markdown idempotently, groups tasks and handles real approval conflicts at 390px", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const f = await setup(page);
  try {
    const fileDescription =
      "Retain every finding.\n\n" +
      "Detailed rationale with its original context. ".repeat(50) +
      "\n\nFinal paragraph with trailing newline.\n";
    const materialSource = source.replace(
      "artifacts: {paths: [reports/context.md]}",
      `artifacts:\n    files:\n      - path: reports/context.md\n        name: report.md\n        description: ${JSON.stringify(fileDescription)}\n      - path: logs/context.md\n        name: report.md\n        description: Additional context in another directory.`,
    );
    const save = await f.api.request("/api/pipelines/definitions", {
      method: "POST",
      body: JSON.stringify({
        squad_id: f.squad.id,
        source: materialSource,
        idempotency_key: randomUUID(),
        activate: true,
        expected_revision: f.squad.revision,
      }),
    });
    expect(save.status).toBe(201);
    const docRes = await f.api.request(
      `/api/projects/${f.project.id}/documents`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "Pinned findings",
          kind: "document",
          body: "Human introduction.\n\n## Evidence v1\nImmutable approval evidence.",
        }),
      },
    );
    expect(docRes.status).toBe(201);
    const doc = await docRes.json();
    await f.api.updateIssue(f.issue.id, {
      assignee_id: f.squad.id,
      assignee_type: "squad",
    });
    const runs = await (
      await f.api.request(`/api/pipeline-runs?issue_id=${f.issue.id}`)
    ).json();
    expect(runs.items.length).toBe(1);
    const run = runs.items[0];
    const artifact = await f.api.seedPipelineDocumentMaterial(
      run.id,
      doc.id,
      doc.version,
      false,
      true,
    );
    expect(artifact).toMatchObject({
      name: "report.md",
      description: fileDescription,
      path: "reports/context.md",
    });
    const newVersion = await f.api.request(
      `/api/projects/${f.project.id}/documents/${doc.id}`,
      {
        method: "PUT",
        body: JSON.stringify({
          title: doc.title,
          body: "New latest body v2. Human introduction.",
          base_version: doc.version,
        }),
      },
    );
    expect(newVersion.ok).toBeTruthy();
    await page.goto(`/${f.workspace.slug}/pipelines/${run.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("pipeline-run-details")).toContainText(
      fileDescription,
    );
    await expect(page.getByTestId("pipeline-run-details")).toContainText(
      "report.md",
    );
    await expect(page.getByTestId("pipeline-run-details")).toContainText(
      "reports/context.md",
    );
    const artifacts = await (
      await f.api.request(`/api/pipeline-runs/${run.id}/artifacts`)
    ).json();
    expect(
      artifacts.items.filter(
        (a: { status: string }) => a.status === "accessible",
      ),
    ).toHaveLength(2);
    expect(
      artifacts.items.filter(
        (a: { status: string }) => a.status === "declared",
      ),
    ).toHaveLength(2);
    expect(
      artifacts.items
        .filter((a: { status: string }) => a.status === "accessible")
        .map((a: { path: string }) => a.path)
        .sort(),
    ).toEqual(["logs/context.md", "reports/context.md"]);
    expect(
      artifacts.items.find(
        (a: { path: string }) => a.path === "logs/context.md",
      ),
    ).toMatchObject({ status: "declared", name: "report.md" });
    await expect(
      page.getByRole("button", { name: "Approve", exact: true }),
    ).toBeEnabled({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: "Reject", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Open material", exact: true })
      .first()
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      "Immutable approval evidence.",
    );
    await expect(page.getByRole("dialog")).not.toContainText(
      "New latest body v2",
    );
    await page.screenshot({
      style: "nextjs-portal { display: none !important; }",
      path: info.outputPath("pinned-material-v1.png"),
    });
    await page.keyboard.press("Escape");
    const collect = page
      .locator(".pipeline-material")
      .filter({ hasText: "reports/context.md" })
      .getByRole("button", {
        name: "Link to project document",
        exact: true,
      });
    await collect.click();
    let modal = page.getByRole("dialog");
    await modal.getByLabel("Target Markdown document").selectOption(doc.id);
    await expect(modal.getByLabel("Link label")).toHaveValue("report.md");
    await expect(modal.getByLabel("Optional description")).toHaveAttribute(
      "rows",
      "3",
    );
    await expect(modal.getByLabel("Optional description")).toHaveValue(
      fileDescription,
    );
    await modal.getByLabel("Link label").fill("Reviewed findings");
    const concurrent = await f.api.request(
      `/api/projects/${f.project.id}/documents/${doc.id}`,
      {
        method: "PUT",
        body: JSON.stringify({
          title: doc.title,
          body: "New latest body v2. Human introduction.\n\nConcurrent human paragraph.",
          base_version: 2,
        }),
      },
    );
    expect(concurrent.ok).toBeTruthy();
    await modal
      .getByRole("button", { name: "Insert link and save source" })
      .click();
    await expect(modal).toContainText("The document changed.");
    await expect(modal.getByLabel("Link label")).toHaveValue(
      "Reviewed findings",
    );
    await expect(modal.getByLabel("Optional description")).toHaveValue(
      fileDescription,
    );
    await modal
      .getByRole("button", { name: /Use reviewed latest version/ })
      .click();
    await modal
      .getByRole("button", { name: "Insert link and save source" })
      .click();
    await expect(modal).not.toBeVisible();
    await collect.click();
    modal = page.getByRole("dialog");
    await modal.getByLabel("Target Markdown document").selectOption(doc.id);
    await modal
      .getByRole("button", { name: "Insert link and save source" })
      .click();
    await expect(modal).not.toBeVisible();
    const linked = await (
      await f.api.request(`/api/projects/${f.project.id}/documents/${doc.id}`)
    ).json();
    expect(linked.body).toContain("New latest body v2. Human introduction.");
    expect(linked.body.match(/\[Reviewed findings\]/g)?.length).toBe(1);
    expect(linked.body).toContain("Concurrent human paragraph.");
    const records = await (
      await f.api.request(
        `/api/projects/${f.project.id}/documents/${doc.id}/sources`,
      )
    ).json();
    expect(
      records.sources.find(
        (r: { source: { label: string } }) =>
          r.source.label === "Reviewed findings",
      ).source.description,
    ).toBe(fileDescription);
    expect(linked.body).toContain("Final paragraph with trailing newline.");
    await writeFile(
      info.outputPath("multiline-material-link.json"),
      JSON.stringify({ artifact, linked, records }, null, 2),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    const opinion = page.getByLabel("Review comment");
    await opinion.fill("My retained review comment");
    await page.screenshot({
      style: "nextjs-portal { display: none !important; }",
      path: info.outputPath("approval-390.png"),
      fullPage: true,
    });
    const latest = await (
      await f.api.request(`/api/pipeline-runs/${run.id}`)
    ).json();
    const gate = latest.jobs.find(
      (j: { node: { id: string } }) => j.node.id === "confirm_findings",
    );
    const decide = await f.api.request(
      `/api/pipeline-runs/${run.id}/jobs/confirm_findings/decisions`,
      {
        method: "POST",
        body: JSON.stringify({
          decision: "approve",
          expected_revision: gate.revision,
          idempotency_key: randomUUID(),
        }),
      },
    );
    expect(decide.status, await decide.clone().text()).toBe(200);
    const stale = await f.api.request(
      `/api/pipeline-runs/${run.id}/jobs/confirm_findings/decisions`,
      {
        method: "POST",
        body: JSON.stringify({
          decision: "reject",
          reason: "stale reviewer",
          expected_revision: gate.revision,
          idempotency_key: randomUUID(),
        }),
      },
    );
    expect(stale.status).toBe(409);
    await expect(page.getByTestId("pipeline-run-details")).toContainText(
      "Recorded decision",
    );
    await expect(page.getByLabel("Restore kept draft")).toHaveValue(
      "My retained review comment",
    );
    await page.goto(
      `/${f.workspace.slug}/projects/${f.project.id}?view=docs&document=${doc.id}`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(page.locator(".document-title")).toHaveValue(
      "Pinned findings",
      {
        timeout: 30_000,
      },
    );
    await expect(page.locator(".document-rich-editor")).toContainText(
      "Concurrent human paragraph.",
    );
    await page
      .getByRole("button", { name: "Project documents", exact: true })
      .click();
    const directory = page.getByRole("dialog", { name: "Project documents" });
    const taskGroup = directory.locator(`[data-issue-id="${f.issue.id}"]`);
    await expect(taskGroup).toContainText("Custom pipeline UI verification");
    await expect(taskGroup).toContainText("Pinned findings");
    const [filtered] = await Promise.all([
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === `/api/projects/${f.project.id}/documents` &&
          url.searchParams.get("q") === "Custom pipeline"
        );
      }),
      directory
        .getByLabel("Search tasks and Markdown documents")
        .fill("Custom pipeline"),
    ]);
    expect(filtered.ok()).toBeTruthy();
    await expect(taskGroup).toContainText("Pinned findings");
    // Visibility alone includes the sheet's translucent opening transition.
    await expect(directory).toHaveCSS("opacity", "1");
    expect((await directory.boundingBox())!.x).toBeCloseTo(0, 0);
    const newDocument = directory.getByRole("button", { name: "New document" });
    const addBounds = (await newDocument.boundingBox())!;
    const closeBounds = (await directory
      .getByRole("button", { name: "Close", exact: true })
      .boundingBox())!;
    expect(addBounds.x + addBounds.width).toBeLessThanOrEqual(closeBounds.x);
    await page.screenshot({
      style: "nextjs-portal { display: none !important; }",
      path: info.outputPath("task-markdown-390.png"),
    });
    await newDocument.click();
    await expect(directory).not.toBeVisible();
    const createDialog = page.getByRole("dialog", {
      name: "New document",
      exact: true,
    });
    await expect(createDialog).toBeVisible();
    await createDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(createDialog).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "Project documents", exact: true }),
    ).toBeFocused();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.screenshot({
      style: "nextjs-portal { display: none !important; }",
      path: info.outputPath("task-markdown-body-390.png"),
    });
    await page
      .getByRole("link", { name: "Reviewed findings", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      "Immutable approval evidence.",
    );
    await page.keyboard.press("Escape");
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.screenshot({
      style: "nextjs-portal { display: none !important; }",
      path: info.outputPath("markdown-390-dark.png"),
    });
  } finally {
    await f.cleanup();
  }
});

test("keeps failed attempt history through real retry and cancellation, and blocks upstream gates", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const f = await setup(page);
  try {
    const saved = await f.api.request("/api/pipelines/definitions", {
      method: "POST",
      body: JSON.stringify({
        squad_id: f.squad.id,
        source,
        idempotency_key: randomUUID(),
        activate: true,
        expected_revision: f.squad.revision,
      }),
    });
    expect(saved.status).toBe(201);
    const doc = await (
      await f.api.request(`/api/projects/${f.project.id}/documents`, {
        method: "POST",
        body: JSON.stringify({
          title: "Failure evidence",
          kind: "document",
          body: "Fake executor failure evidence",
        }),
      })
    ).json();
    await f.api.updateIssue(f.issue.id, {
      assignee_id: f.squad.id,
      assignee_type: "squad",
    });
    const run = (
      await (
        await f.api.request(`/api/pipeline-runs?issue_id=${f.issue.id}`)
      ).json()
    ).items[0];
    await f.api.seedPipelineDocumentMaterial(run.id, doc.id, doc.version, true);
    await page.goto(`/${f.workspace.slug}/pipelines/${run.id}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("button", { name: /^confirm_findings/ })
      .first()
      .click();
    await expect(
      page.getByRole("button", { name: "Approve", exact: true }),
    ).toBeDisabled();
    await expect(page.getByTestId("pipeline-run-details")).toContainText(
      "Waiting for upstream dependencies or required materials",
    );
    await page
      .getByRole("button", { name: /^read_sources/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Retry node", exact: true }).click();
    await expect(
      page
        .getByRole("combobox", { name: "Attempt", exact: true })
        .locator("option"),
    ).toHaveCount(2);
    const retried = await (
      await f.api.request(`/api/pipeline-runs/${run.id}`)
    ).json();
    expect(retried.jobs[0].attempts.length).toBe(2);
    expect(retried.jobs[0].attempts[0].report.report).toContain(
      "E2E fixture executor",
    );
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Cancel run", exact: true }).click();
    await expect(page.getByTestId("pipeline-run-details")).toContainText(
      "cancelled",
    );
    const cancelled = await (
      await f.api.request(`/api/pipeline-runs/${run.id}`)
    ).json();
    expect(cancelled.status).toBe("cancelled");
  } finally {
    await f.cleanup();
  }
});
