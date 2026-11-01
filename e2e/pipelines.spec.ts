import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createTestApi } from "./helpers";

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

test("preserves custom YAML across dialects, validates real plans and atomically enables a version", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const f = await setup(page);
  try {
    await page.goto(`/${f.workspace.slug}/squads/${f.squad.id}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "Pipeline", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "YAML", exact: true });
    await page.getByRole("textbox", {name:"Pipeline name"}).fill("Custom preserved workflow");
    await editor.fill(source);
    await expect(
      page.getByRole("button", { name: "Save and enable", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Flow graph", exact: true }).click();
    await expect(page.getByTestId("pipeline-graph")).toContainText(
      "read_sources",
    );
    await expect(page.getByTestId("pipeline-graph")).toContainText(
      "confirm_findings",
    );
    await page.screenshot({
      style: "nextjs-portal { display: none !important; }",
      path: info.outputPath("definition-real-plan.png"),
    });
    await page
      .getByLabel("Dialect", { exact: true })
      .selectOption("hermes_yaml");
    await page.getByRole("button", { name: "Start separate draft" }).click();
    await page.getByRole("button", { name: "YAML", exact: true }).click();
    await editor.fill(hermes);
    await expect(
      page.getByRole("button", { name: "Save version", exact: true }),
    ).toBeEnabled();
    await page
      .getByLabel("Dialect", { exact: true })
      .selectOption("gitlab_yaml");
    await page.getByRole("button", { name: "Start separate draft" }).click();
    await expect(editor).toHaveValue(source);
    const changed = await f.api.request(`/api/squads/${f.squad.id}`, {
      method: "PUT",
      body: JSON.stringify({ description: "A concurrent management edit" }),
    });
    expect(changed.ok).toBeTruthy();
    await page
      .getByRole("button", { name: "Save and enable", exact: true })
      .click();
    const conflict = page.getByRole("dialog");
    await expect(conflict).toContainText("The saved configuration changed");
    await conflict
      .getByRole("button", { name: "Use reviewed latest version" })
      .click();
    await expect(editor).toHaveValue(source);
    await page
      .getByRole("button", { name: "Save and enable", exact: true })
      .click();
    await expect(page.getByTestId("squad-pipeline")).not.toContainText(
      "Unsaved changes",
    );
    const saved = await (
      await f.api.request(`/api/squads/${f.squad.id}`)
    ).json();
    expect(saved.instructions_mode).toBe("pipeline");
    const definition = await (
      await f.api.request(
        `/api/pipelines/definitions/${saved.pipeline_definition_id}`,
      )
    ).json();
    expect(definition.source).toBe(source);
    await page
      .getByLabel("Dialect", { exact: true })
      .selectOption("hermes_yaml");
    await page.getByRole("button", { name: "Start separate draft" }).click();
    await expect(editor).toHaveValue(hermes);
    await page
      .getByRole("button", { name: "Save version", exact: true })
      .click();
    await expect(page.getByTestId("squad-pipeline")).not.toContainText(
      "Unsaved changes",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Pipeline", exact: true }).click();
    // The catalog opens its latest version; saving it keeps the squad's pinned default.
    await expect(editor).toHaveValue(hermes);
    const unchangedDefault = await (
      await f.api.request(`/api/squads/${f.squad.id}`)
    ).json();
    expect(unchangedDefault.pipeline_definition_id).toBe(saved.pipeline_definition_id);
  } finally {
    await f.cleanup();
  }
});

test("declares a selected Hermes squad role and keeps leader fallback valid", async ({
  page,
}, info) => {
  const f = await setup(page);
  try {
    const renamed = await f.api.request(`/api/squads/${f.squad.id}/members/role`, {
      method: "PATCH",
      body: JSON.stringify({
        member_type: "agent",
        member_id: f.squad.leader_id,
        role: "reviewer",
      }),
    });
    expect(renamed.ok).toBeTruthy();
    await page.goto(`/${f.workspace.slug}/squads/${f.squad.id}`);
    await page.getByRole("button", { name: "Pipeline", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "YAML", exact: true });
    await page.getByRole("textbox", {name:"Pipeline name"}).fill("Custom preserved workflow");
    const original = `kind: hermes_yaml
# Preserve the user's workflow.
roles: {}
states:
  collect:
    entry: Preserve the original instruction.
`;
    await editor.fill(original);
    const save = page.getByRole("button", {
      name: "Save and enable",
      exact: true,
    });
    await expect(save).toBeEnabled({ timeout: 15_000 });
    await page.getByText("Role bindings", { exact: true }).click();
    const picker = page.locator("select").filter({
      has: page.locator('option[value="reviewer"]'),
    });
    await expect(picker).toHaveCount(1);
    const [selectedResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/pipelines/validate") &&
          (response.request().postData() ?? "").includes("by: reviewer"),
      ),
      picker.selectOption("reviewer"),
    ]);
    const selected = await selectedResponse.json();
    expect(selectedResponse.request().postDataJSON().squad_id).toBe(f.squad.id);
    expect(selected).toMatchObject({ syntax_valid: true, binding_valid: true });
    expect(selected.plan.nodes[0].role).toBe("reviewer");
    await expect(picker).toHaveValue("reviewer");
    await expect(save).toBeEnabled({ timeout: 15_000 });
    if (!(await picker.isVisible())) {
      await page.getByText("Role bindings", { exact: true }).click();
    }
    await expect(picker).toBeVisible();
    const selectedSource = await editor.inputValue();
    expect(selectedSource).toContain("entry: Preserve the original instruction.");
    expect(selectedSource).toContain("# Preserve the user's workflow.");
    await page.screenshot({
      style: "nextjs-portal { display: none !important; }",
      path: info.outputPath("hermes-role-selected.png"),
      fullPage: true,
    });
    const [leaderResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/pipelines/validate") &&
          !(response.request().postData() ?? "").includes("by: reviewer"),
      ),
      picker.selectOption({ value: "" }),
    ]);
    const leader = await leaderResponse.json();
    expect(leader).toMatchObject({ syntax_valid: true, binding_valid: true });
    expect(leader.plan.nodes[0].role).toBe("");
    await expect(picker).toHaveValue("");
    await expect(save).toBeEnabled({ timeout: 15_000 });
    if (!(await picker.isVisible())) {
      await page.getByText("Role bindings", { exact: true }).click();
    }
    await expect(picker).toBeVisible();
    await page.screenshot({
      style: "nextjs-portal { display: none !important; }",
      path: info.outputPath("hermes-role-leader.png"),
      fullPage: true,
    });
    await writeFile(
      info.outputPath("hermes-role-validation.json"),
      JSON.stringify({
        original_source: original,
        selected: { source: selectedSource, validation: selected },
        leader: { source: await editor.inputValue(), validation: leader },
      }, null, 2),
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
    const save = await f.api.request("/api/pipelines/definitions", {
      method: "POST",
      body: JSON.stringify({
        squad_id: f.squad.id,
        source,
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
    await f.api.seedPipelineDocumentMaterial(run.id, doc.id, doc.version);
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
    await expect(
      page.getByRole("button", { name: "Approve", exact: true }),
    ).toBeEnabled();
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
    const collect = page.getByRole("button", {
      name: "Link to project document",
      exact: true,
    });
    await collect.click();
    let modal = page.getByRole("dialog");
    await modal.getByLabel("Target Markdown document").selectOption(doc.id);
    await modal.getByLabel("Link label").fill("Reviewed findings");
    await modal
      .getByLabel("Optional description")
      .fill("Retain this description on conflict");
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
      "Retain this description on conflict",
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
    expect(decide.ok).toBeTruthy();
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
    await expect(page.getByLabel("Draft retained")).toHaveValue(
      "My retained review comment",
    );
    await page.goto(
      `/${f.workspace.slug}/projects/${f.project.id}?view=docs&document=${doc.id}`,
      { waitUntil: "domcontentloaded" },
    );
    await expect(page.locator(".document-title")).toHaveValue("Pinned findings", {
      timeout: 30_000,
    });
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
