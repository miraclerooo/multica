import { test, expect, type Page, type Locator } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createTestApi } from "./helpers";

test.use({ actionTimeout: 15_000 });
const check = expect.configure({ timeout: 15_000 });
const explanation =
  "Complete delivery explanation.\n\n" +
  "Keep every verification detail and limitation. ".repeat(55) +
  "\n\nFinal paragraph with the exact trailing blank line.\n\n";
async function setup(page: Page) {
  const api = await createTestApi(),
    workspace = (await api.getWorkspaces())[0]!;
  let cleanupSquadId = "";
  try {
    const project = await api.createProject("v1.7 browser canonical");
    const agents = [];
    for (const name of ["Planner", "Executor", "Cassia", "Designer"]) {
      const issue = await api.createIssue(`Fake identity ${name}`, {
        project_id: project.id,
      });
      const agent = await api.seedDocumentAgent(issue.id);
      const changed = await api.request(`/api/agents/${agent.agentId}`, {
        method: "PUT",
        body: JSON.stringify({ name }),
      });
      check(changed.ok, await changed.clone().text()).toBe(true);
      agents.push({ ...agent, name });
    }
    const post = async (path: string, body: unknown) => {
      const r = await api.request(path, {
        method: "POST",
        body: JSON.stringify(body),
      });
      check(r.status, await r.clone().text()).toBeLessThan(300);
      return r.json();
    };
    const squad = await post("/api/squads", {
      name: "Research team v1.7",
      leader_id: agents[0]!.agentId,
    });
    for (const agent of agents.slice(1))
      await post(`/api/squads/${squad.id}/members`, {
        member_type: "agent",
        member_id: agent.agentId,
        role: "",
      });
    cleanupSquadId = squad.id;
    const candidates = await (
      await api.request(`/api/pipelines/candidates?squad_id=${squad.id}`)
    ).json();
    check(candidates.agents).toHaveLength(4);
    check(candidates.default_owner_user_id).toBe(
      candidates.current_user.user_id,
    );
    check(candidates.current_user.user_id).not.toBe(
      candidates.current_user.member_id,
    );
    await page.addInitScript((token) => {
      localStorage.setItem("multica_token", token!);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, api.getToken());
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/${workspace.slug}/squads/${squad.id}`);
    await page.getByRole("button", { name: "Pipeline", exact: true }).click();
    const editor = () => page.getByTestId("pipeline-editor-dialog");
    const source = async () => {
      await editor().getByRole("tab", { name: "Source", exact: true }).click();
      return editor()
        .getByRole("textbox", { name: "YAML", exact: true })
        .inputValue();
    };
    const graph = async () => {
      await editor()
        .getByRole("tab", { name: "Flow graph", exact: true })
        .click();
    };
    const select = async (id: string) => {
      await editor()
        .locator(`[data-canvas-node="${id}"] .pipeline-node`)
        .click();
      return editor().getByTestId("canvas-properties");
    };
    return {
      api,
      workspace,
      project,
      agents,
      squad,
      candidates,
      post,
      editor,
      source,
      graph,
      select,
      cleanup: async () => {
        await api.removePipelineSquadFixture(squad.id);
        await api.cleanup();
      },
    };
  } catch (error) {
    if (cleanupSquadId) await api.removePipelineSquadFixture(cleanupSquadId);
    await api.cleanup();
    throw error;
  }
}
async function capture(page: Page, path: string) {
  await page.screenshot({
    path,
    animations: "disabled",
    style: "nextjs-portal {display:none!important;}",
  });
}
async function save(
  page: Page,
  dialog: Locator,
  route: string,
  button = "Save version",
) {
  await check(
    dialog.getByRole("button", { name: button, exact: true }),
  ).toBeEnabled();
  const response = page.waitForResponse(
    (r) => r.url().endsWith(route) && r.request().method() === "POST",
  );
  await dialog.getByRole("button", { name: button, exact: true }).click();
  const r = await response;
  check(r.status()).toBe(201);
  return r.json();
}

test("edits the real four-member pipeline through dialogs and preserves multiline file identity across drafts and immutable saves", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const f = await setup(page);
  try {
    await check(
      page.getByRole("combobox", { name: "Squad default", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "New pipeline", exact: true })
      .click();
    const dialog = f.editor();
    await check(
      dialog.getByRole("tab", { name: "Flow graph", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await check(
      dialog.getByRole("textbox", { name: "Pipeline name", exact: true }),
    ).toBeEnabled();
    await dialog
      .getByRole("textbox", { name: "Pipeline name", exact: true })
      .fill("Research delivery");
    await check(
      dialog.getByRole("combobox", { name: "Select node", exact: true }),
    ).toHaveCount(0);
    await check(
      dialog.getByRole("combobox", { name: "Select connection", exact: true }),
    ).toHaveCount(0);
    await check(
      dialog.getByRole("button", { name: "Add connection", exact: true }),
    ).toHaveCount(0);
    let properties = await f.select("node_1");
    await check(
      properties.getByRole("tab", { name: "Basic settings", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await check(
      properties.locator('optgroup[label="Squad members"] option'),
    ).toHaveCount(4);
    for (const agent of f.agents)
      check(
        await properties
          .getByRole("combobox", { name: "Executor", exact: true })
          .locator("option")
          .allTextContents(),
      ).toContainEqual(expect.stringContaining(agent.name));
    await properties
      .getByRole("textbox", { name: "Node name", exact: true })
      .fill("Complete research output");
    await properties
      .getByRole("combobox", { name: "Executor", exact: true })
      .selectOption(`member:${f.agents[1]!.agentId}`);
    let rows = properties.getByTestId("deliverable-row");
    await rows
      .nth(0)
      .getByRole("textbox", { name: "File name", exact: true })
      .fill("report.md");
    const description = rows
      .nth(0)
      .getByRole("textbox", { name: "File description", exact: true });
    await check(description).toHaveAttribute("rows", "3");
    await description.fill(explanation);
    await properties
      .getByRole("button", { name: "Add file", exact: true })
      .click();
    rows = properties.getByTestId("deliverable-row");
    await rows
      .nth(1)
      .getByRole("textbox", { name: "File name", exact: true })
      .fill("report.md");
    await rows
      .nth(1)
      .getByRole("textbox", { name: "File description", exact: true })
      .fill("Different source.\n\nSecond directory identity.");
    await check(
      dialog.getByRole("button", { name: "Save version", exact: true }),
    ).toBeDisabled();
    await f.select("node_2");
    properties = await f.select("node_1");
    await check(
      properties
        .getByTestId("deliverable-row")
        .nth(0)
        .getByRole("textbox", { name: "File description", exact: true }),
    ).toHaveValue(explanation);
    await properties
      .getByRole("tab", { name: "Instructions", exact: true })
      .click();
    const instruction =
      "Read the entire original context.\nPreserve this second instruction line.";
    await properties
      .getByRole("textbox", { name: "Complete instructions", exact: true })
      .fill(instruction);
    await properties
      .getByRole("tab", { name: "Basic settings", exact: true })
      .click();
    await properties
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    const edited = await f.source();
    check(edited).toContain(f.agents[1]!.agentId);
    check(edited).not.toContain("@v17-meta");
    check(edited).toContain("node_1:");
    check(edited).toContain("Complete research output");
    await dialog
      .getByRole("textbox", { name: "YAML", exact: true })
      .press("Control+z");
    check(await f.source()).not.toContain("Complete research output");
    await dialog
      .getByRole("textbox", { name: "YAML", exact: true })
      .press("Control+Shift+z");
    check(await f.source()).toBe(edited);
    await f.graph();
    await capture(page, info.outputPath("v17-editor-desktop.png"));
    properties = await f.select("node_1");
    await properties
      .getByTestId("deliverable-row")
      .nth(0)
      .getByRole("textbox", { name: "File description", exact: true })
      .scrollIntoViewIfNeeded();
    await capture(page, info.outputPath("v17-multiline-desktop.png"));
    await page.setViewportSize({ width: 390, height: 844 });
    await properties
      .getByTestId("deliverable-row")
      .nth(0)
      .getByRole("textbox", { name: "File description", exact: true })
      .scrollIntoViewIfNeeded();
    await capture(page, info.outputPath("v17-multiline-390.png"));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Keep your changes?", exact: true })
      .getByRole("button", { name: "Keep draft and close", exact: true })
      .click();
    await check(f.editor()).toHaveCount(0);
    await check(
      page.getByRole("button", { name: "New pipeline", exact: true }),
    ).toBeFocused();
    await check(
      page.getByRole("combobox", { name: "Choose a pipeline", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "New pipeline", exact: true })
      .click();
    check(await f.source()).toBe(edited);
    const created = await save(page, dialog, "/api/pipelines/catalog");
    check(created.pipeline.name).toBe("Research delivery");
    check(created.definition.compiler_version).toBe("2");
    const node = created.definition.plan.nodes.find(
      (n: { id: string }) => n.id === "node_1",
    );
    check(node).toMatchObject({
      title: "Complete research output",
      agent_id: f.agents[1]!.agentId,
      instructions: instruction,
    });
    check(node.deliverables).toEqual([
      { path: "plan.md", name: "report.md", description: explanation },
      {
        path: "report.md",
        name: "report.md",
        description: "Different source.\n\nSecond directory identity.",
      },
    ]);
    check(created.definition.source_hash).toBe(
      createHash("sha256").update(created.definition.source).digest("hex"),
    );
    const squad = await (
      await f.api.request(`/api/squads/${f.squad.id}`)
    ).json();
    check(squad.instructions_mode).toBe("markdown");
    await page
      .getByRole("button", { name: "Edit pipeline", exact: true })
      .click();
    check(await f.source()).toBe(created.definition.source);
    await f.graph();
    properties = await f.select("node_4");
    await check(
      properties.getByRole("combobox", { name: "Human owner", exact: true }),
    ).toHaveValue(`user:${f.candidates.current_user.user_id}`);
    await properties
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByRole("button", { name: "Add node", exact: true }).click();
    const adding = page.getByRole("dialog", { name: "Add node", exact: true });
    await adding
      .getByRole("combobox", { name: "Node type", exact: true })
      .selectOption("manual");
    await adding
      .getByRole("textbox", { name: "Node name", exact: true })
      .fill("Additional human review");
    await check(
      adding.getByRole("combobox", { name: "Human owner", exact: true }),
    ).toHaveValue(`user:${f.candidates.current_user.user_id}`);
    await capture(page, info.outputPath("v17-human-390.png"));
    await adding.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.getByRole("button", { name: "Add node", exact: true }).click();
    await check(
      adding.getByRole("textbox", { name: "Node name", exact: true }),
    ).toHaveValue("Additional human review");
    await adding
      .getByRole("textbox", { name: "Node name", exact: true })
      .press("Enter");
    await check(dialog.locator('[data-canvas-node="node_5"]')).toHaveCount(1);
    const saved = await save(page, dialog, "/api/pipelines/definitions");
    check(saved.revision).toBe(2);
    check(
      saved.plan.nodes.find((n: { id: string }) => n.id === "node_5"),
    ).toMatchObject({
      title: "Additional human review",
      owner_user_id: f.candidates.current_user.user_id,
    });
    const old = await (
      await f.api.request(`/api/pipelines/definitions/${created.definition.id}`)
    ).json();
    check(old.source).toBe(created.definition.source);
    await writeFile(
      info.outputPath("v17-dialog-responses.json"),
      JSON.stringify(
        { candidates: f.candidates, created, saved, old, squad },
        null,
        2,
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("previews a first squad default and freezes the explicitly selected legacy-runtime member without substituting the leader", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const f = await setup(page);
  try {
    const writes: unknown[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith(`/api/squads/${f.squad.id}`) && r.method() === "PUT")
        writes.push(r.postDataJSON());
    });
    await page
      .getByRole("button", { name: "Execution mode", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Execution mode", exact: true })
      .selectOption("pipeline");
    await page
      .getByRole("button", { name: "Preview default workflow", exact: true })
      .click();
    check(
      (await (await f.api.request(`/api/squads/${f.squad.id}`)).json())
        .instructions_mode,
    ).toBe("markdown");
    check(writes).toEqual([]);
    const properties = await f.select("node_2");
    await properties
      .getByRole("combobox", { name: "Executor", exact: true })
      .selectOption(`member:${f.agents[2]!.agentId}`);
    await properties
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    const created = await save(
      page,
      f.editor(),
      "/api/pipelines/catalog",
      "Save and enable",
    );
    const enabled = await (
      await f.api.request(`/api/squads/${f.squad.id}`)
    ).json();
    check(enabled.instructions_mode).toBe("pipeline");
    check(enabled.pipeline_definition_id).toBe(created.definition.id);
    await check(
      page.getByRole("button", { name: "Execution mode", exact: true }),
    ).toContainText("Pipeline");
    const modern = {
      version: "local-v17-fixture",
      commit: "b".repeat(40),
      release_channel: "ipoke",
      capabilities: ["pipeline-task-selection-v1"],
    };
    const legacy = {
      version: "0.7.2",
      commit: "a".repeat(40),
      release_channel: "ipoke",
      capabilities: [],
    };
    for (const agent of f.agents)
      await f.post(`/api/daemon/runtimes/${agent.runtimeId}/build-report`, {
        daemon: agent.name === "Cassia" ? legacy : modern,
        disk: agent.name === "Cassia" ? null : modern,
        disk_reason: agent.name === "Cassia" ? "disk_probe_unavailable" : "",
      });
    const preview = await f.post("/api/pipelines/preflight", {
      squad_id: f.squad.id,
      execution: { mode: "default" },
    });
    check(preview.mode).toBe("pipeline");
    check(preview.definition_id).toBe(created.definition.id);
    const cassia = preview.readiness.runtimes.find(
      (r: { runtime_id: string }) => r.runtime_id === f.agents[2]!.runtimeId,
    );
    check(cassia).toBeTruthy();
    check(cassia.status).toBe("insufficient");
    check(cassia.disk).toBeNull();
    check(cassia.daemon.version).toBe("0.7.2");
    const issue = await f.api.createIssue("Frozen explicit member test", {
      project_id: f.project.id,
      assignee_type: "squad",
      assignee_id: f.squad.id,
      execution: {
        mode: "pipeline",
        pipeline_id: created.pipeline.id,
        definition_id: created.definition.id,
      },
    });
    const frozen = await (
      await f.api.request(`/api/issues/${issue.id}/execution`)
    ).json();
    check(frozen.execution.bindings.node_2).toBe(f.agents[2]!.agentId);
    check(frozen.execution.definition_id).toBe(created.definition.id);
    await page
      .getByRole("button", { name: "Execution mode", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Execution mode", exact: true })
      .selectOption("markdown");
    await check(
      page.getByRole("button", { name: "Execution mode", exact: true }),
    ).toContainText("Instructions");
    check(
      (await (await f.api.request(`/api/issues/${issue.id}/execution`)).json())
        .execution.definition_id,
    ).toBe(created.definition.id);
    await page.goto(`/${f.workspace.slug}/issues/${issue.identifier}`);
    const panel = page.getByTestId("issue-execution");
    await panel.scrollIntoViewIfNeeded();
    await panel.locator("summary").filter({ hasText: "insufficient" }).click();
    await check(panel).toContainText("Installed CLI: Unknown");
    await check(panel).toContainText("0.7.2");
    await check(
      panel.getByRole("button", { name: "Start saved execution", exact: true }),
    ).toBeDisabled();
    await capture(page, info.outputPath("v17-selected-runtime.png"));
    await writeFile(
      info.outputPath("v17-default-readiness.json"),
      JSON.stringify({ created, enabled, preview, issue, frozen }, null, 2),
    );
  } finally {
    await f.cleanup();
  }
});
