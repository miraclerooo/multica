import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createTestApi } from "./helpers";

test.use({ actionTimeout: 15_000 });
const check = expect.configure({ timeout: 15_000 });
const yaml =
  "kind: gitlab_yaml\nstages: [research]\ncollect:\n  stage: research\n  instructions: Preserve this custom research instruction.\n";
const hermes =
  "kind: hermes_yaml\nroles: {}\nstates:\n  collect:\n    entry: Preserve my separate Hermes instruction.\nedges: []\n";

async function fixture(page: Page) {
  const api = await createTestApi();
  const workspace = (await api.getWorkspaces())[0]!;
  const project = await api.createProject("Named pipeline UI fixtures");
  const seedIssue = await api.createIssue("Pipeline fixture identity", {
    project_id: project.id,
  });
  const agent = await api.seedDocumentAgent(seedIssue.id);
  async function post(path: string, body: unknown) {
    const response = await api.request(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    check(response.status, await response.clone().text()).toBeLessThan(300);
    return response.json();
  }
  const squad = await post("/api/squads", {
    name: "Selection research team",
    leader_id: agent.agentId,
  });
  const other = await post("/api/squads", {
    name: "Other selection team",
    leader_id: agent.agentId,
  });
  const issueIds: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((token) => {
    localStorage.setItem("multica_token", token!);
    localStorage.setItem("multica:chat:isOpen", "false");
    localStorage.setItem(
      "multica_create_mode",
      JSON.stringify({ state: { lastMode: "manual" }, version: 0 }),
    );
  }, api.getToken());
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  return {
    api,
    workspace,
    squad,
    other,
    agent,
    post,
    issueIds,
    errors,
    report: (body: unknown) =>
      post(`/api/daemon/runtimes/${agent.runtimeId}/build-report`, body),
    cleanup: async () => {
      for (const id of issueIds)
        await api.request(`/api/issues/${id}`, { method: "DELETE" });
      await api.removePipelineSquadFixture(squad.id);
      await api.removePipelineSquadFixture(other.id);
      await api.cleanup();
    },
  };
}

test("named catalogs keep independent source/version histories and an explicit squad default", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const f = await fixture(page);
  try {
    await page.goto(`/${f.workspace.slug}/squads/${f.squad.id}`);
    await page.getByRole("button", { name: "Pipeline", exact: true }).click();
    const area = page.getByTestId("pipeline-catalog"),
      dialog = page.getByTestId("pipeline-editor-dialog");
    await check(
      area.getByRole("combobox", { name: "Squad default", exact: true }),
    ).toHaveCount(0);
    await check(
      area.getByRole("combobox", { name: "Choose a pipeline", exact: true }),
    ).toHaveCount(0);
    const create = async (name: string, source: string) => {
      await area
        .getByRole("button", { name: "New pipeline", exact: true })
        .click();
      await dialog
        .getByRole("textbox", { name: "Pipeline name", exact: true })
        .fill(name);
      await dialog.getByRole("tab", { name: "Source", exact: true }).click();
      await dialog
        .getByRole("textbox", { name: "YAML", exact: true })
        .fill(source);
      await check(
        dialog.getByRole("button", { name: "Save version", exact: true }),
      ).toBeEnabled();
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/pipelines/catalog") &&
          r.request().method() === "POST",
      );
      await dialog
        .getByRole("button", { name: "Save version", exact: true })
        .click();
      const created = await (await response).json();
      await check(dialog).toHaveCount(0);
      return created;
    };
    const a = await create("Research", yaml),
      b = await create("Hermes review", hermes);
    const chooser = area.getByRole("combobox", {
      name: "Choose a pipeline",
      exact: true,
    });
    await check(chooser.locator("option")).toHaveCount(2);
    await chooser.selectOption(a.pipeline.id);
    const unchanged = await (
      await f.api.request(`/api/squads/${f.squad.id}`)
    ).json();
    check(unchanged.instructions_mode).toBe("markdown");
    await area
      .getByRole("textbox", { name: "Pipeline name", exact: true })
      .fill("Research renamed");
    const rename = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/pipelines/catalog/${a.pipeline.id}`) &&
        r.request().method() === "PATCH",
    );
    await area.getByRole("button", { name: "Rename", exact: true }).click();
    check((await rename).status()).toBe(200);
    await area
      .getByRole("button", { name: "Edit pipeline", exact: true })
      .click();
    await dialog.getByRole("tab", { name: "Source", exact: true }).click();
    const editor = dialog.getByRole("textbox", { name: "YAML", exact: true });
    await check(editor).toHaveValue(yaml);
    await editor.fill(
      yaml.replace("research instruction.", "research instruction v2."),
    );
    await check(
      dialog.getByRole("button", { name: "Save version", exact: true }),
    ).toBeEnabled();
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/pipelines/definitions") &&
        r.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "Save version", exact: true })
      .click();
    const version = await (await response).json();
    check(version.pipeline_id).toBe(a.pipeline.id);
    check(version.revision).toBe(2);
    await check(dialog).toHaveCount(0);
    await page
      .getByRole("button", { name: "Execution mode", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Execution mode", exact: true })
      .selectOption("pipeline");
    await page
      .getByRole("dialog")
      .getByRole("combobox", { name: "Choose a pipeline", exact: true })
      .selectOption(b.pipeline.id);
    await page
      .getByRole("button", { name: "Save squad default", exact: true })
      .click();
    await check(
      page.getByRole("button", { name: "Execution mode", exact: true }),
    ).toContainText("Pipeline");
    const after = await (
      await f.api.request(`/api/squads/${f.squad.id}`)
    ).json();
    check(after.pipeline_definition_id).toBe(b.definition.id);
    const bVersions = await (
      await f.api.request(
        `/api/pipelines/definitions?squad_id=${f.squad.id}&pipeline_id=${b.pipeline.id}`,
      )
    ).json();
    check(bVersions.items).toHaveLength(1);
    check(bVersions.items[0].source).toBe(hermes);
    await page.screenshot({
      animations: "disabled",
      style: "nextjs-portal {display:none!important}",
      path: info.outputPath("catalog-desktop.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await check(chooser).toBeVisible();
    check(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      animations: "disabled",
      style: "nextjs-portal {display:none!important}",
      path: info.outputPath("catalog-390.png"),
    });
    await area
      .getByRole("button", { name: "Edit pipeline", exact: true })
      .click();
    await dialog.getByRole("tab", { name: "Source", exact: true }).click();
    await editor.scrollIntoViewIfNeeded();
    await page.screenshot({
      animations: "disabled",
      style: "nextjs-portal {display:none!important}",
      path: info.outputPath("catalog-editor-390.png"),
    });
    await writeFile(
      info.outputPath("catalog-responses.json"),
      JSON.stringify({ a, b, version, after, bVersions }, null, 2),
    );
    check(f.errors).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("creates one frozen issue, rechecks real compatibility and resumes the same selection", async ({page}, info) => {
  test.setTimeout(180_000);
  const f = await fixture(page);
  try {
    const a = await f.post("/api/pipelines/catalog",{squad_id:f.squad.id,name:"Frozen research",source:yaml,idempotency_key:randomUUID()});
    const b = await f.post("/api/pipelines/catalog",{squad_id:f.other.id,name:"Other pipeline",source:hermes,idempotency_key:randomUUID()});
    await page.goto(`/${f.workspace.slug}/issues`);
    await page.getByRole("button", {name:"New Issue",exact:true}).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", {name:"Issue title"}).fill("One selected research issue");
    await dialog.getByRole("button", {name:"Unassigned",exact:true}).click();
    await page.getByRole("button", {name:f.squad.name,exact:true}).click();
    const selector = dialog.getByRole("combobox", {name:"This issue’s execution"});
    await check(selector).toBeEnabled();
    await selector.selectOption(a.pipeline.id);
    await check(dialog.getByTestId("execution-summary")).toContainText("Frozen research · v1");
    await dialog.getByRole("button", {name:f.squad.name,exact:true}).first().click();
    await page.getByRole("button", {name:f.other.name,exact:true}).click();
    await check(selector).toHaveValue("default");
    await check(selector.locator(`option[value="${a.pipeline.id}"]`)).toHaveCount(0);
    await dialog.getByRole("button", {name:f.other.name,exact:true}).first().click();
    await page.getByRole("button", {name:f.squad.name,exact:true}).click();
    await check(selector).toHaveValue(a.pipeline.id);
    await check(dialog.getByRole("textbox", {name:"Issue title"})).toHaveText("One selected research issue");
    // Close the assignment picker before recording the stable creation form.
    await dialog.getByRole("textbox", {name:"Issue title"}).click();
    await check(page.getByRole("textbox", {name:"Assign to..."})).toHaveCount(0);
    await page.setViewportSize({width:390,height:844});
    await check(dialog.getByRole("button", {name:"Create Issue",exact:true})).toBeEnabled();
    await check(dialog.getByRole("button", {name:"Create Issue",exact:true})).toBeInViewport({ratio:1});
    await page.screenshot({animations: "disabled", style: "nextjs-portal { display: none !important; }", path:info.outputPath("create-selection-390.png"),fullPage:true});
    const createdResponse = page.waitForResponse(r => r.url().endsWith("/api/issues") && r.request().method() === "POST");
    await dialog.getByRole("button", {name:"Create Issue",exact:true}).click();
    const created = await (await createdResponse).json();f.issueIds.push(created.id);
    check(created.execution).toMatchObject({pipeline_id:a.pipeline.id,definition_id:a.definition.id,state:"waiting_runtime"});
    await check(dialog.getByRole("heading", {name:"Issue created"})).toBeVisible();
    const panel = dialog.getByTestId("issue-execution");
    await check(panel).toContainText("Waiting for runtime readiness");
    await check(panel.getByRole("button", {name:"Start saved execution"})).toBeDisabled();
    const old = {version:"0.7.2-ipoke.3de828da5",capabilities:[],release_channel:"ipoke",commit:"a".repeat(40)};
    const upgraded = {...old,version:"dev-v1.5-browser-fixture",capabilities:["pipeline-task-selection-v1"],commit:"b".repeat(40)};
    await f.report({daemon:old,disk:null,disk_reason:"disk_probe_unavailable"});
    await panel.getByRole("button", {name:"Recheck"}).click();
    await panel.locator("summary").focus();
    await page.keyboard.press("Enter");
    await check(panel).toContainText("Installed CLI: Unknown");
    await f.report({daemon:old,disk:upgraded,disk_reason:"",reload_pending_reason:"active_tasks"});
    await panel.getByRole("button", {name:"Recheck"}).click();
    await check(panel).toContainText("daemon_pending");
    await check(panel.getByRole("button", {name:"Start saved execution"})).toBeDisabled();
    await page.screenshot({animations: "disabled", style: "nextjs-portal { display: none !important; }", path:info.outputPath("daemon-pending-390.png"),fullPage:true});
    await panel.locator("summary").focus();
    await page.keyboard.press("Enter");
    await check(panel.locator("details")).toHaveAttribute("open", "");
    await check(panel).toContainText("Running daemon: 0.7.2-ipoke.3de828da5");
    await check(panel).toContainText("Installed CLI: dev-v1.5-browser-fixture");
    await panel.locator("details").scrollIntoViewIfNeeded();
    await page.screenshot({animations: "disabled", style: "nextjs-portal { display: none !important; }", path:info.outputPath("runtime-identities-390.png"),fullPage:true});
    await f.post("/api/pipelines/definitions",{squad_id:f.squad.id,pipeline_id:a.pipeline.id,source:yaml+"# newer version\n",idempotency_key:randomUUID(),expected_pipeline_revision:a.pipeline.revision});
    await f.report({daemon:upgraded,disk:upgraded,disk_reason:""});
    await panel.getByRole("button", {name:"Recheck"}).click();
    await check(panel.getByRole("button", {name:"Start saved execution"})).toBeEnabled();
    const startResponse = page.waitForResponse(r => r.url().endsWith(`/api/issues/${created.id}/execution/start`) && r.request().method() === "POST");
    await panel.getByRole("button", {name:"Start saved execution"}).click();
    const started = await (await startResponse).json();
    check(started.run.definition_id).toBe(a.definition.id);
    const repeated = await f.post(`/api/issues/${created.id}/execution/start`,{});
    check(repeated.run.id).toBe(started.run.id);
    const runs = await (await f.api.request(`/api/pipeline-runs?issue_id=${created.id}`)).json();
    check(runs.items).toHaveLength(1);
    await check(panel).toContainText("Started");
    await page.screenshot({animations: "disabled", style: "nextjs-portal { display: none !important; }", path:info.outputPath("same-issue-started-390.png"),fullPage:true});
    await page.setViewportSize({width:1440,height:1000});
    await page.emulateMedia({colorScheme:"dark"});
    await check(page.locator("html")).toHaveClass(/dark/);
    await page.screenshot({animations: "disabled", style: "nextjs-portal { display: none !important; }", path:info.outputPath("execution-dark.png"),fullPage:true});
    const defaults = await (await f.api.request(`/api/squads/${f.squad.id}`)).json();
    check(defaults.instructions_mode).toBe("markdown");
    await writeFile(info.outputPath("execution-responses.json"),JSON.stringify({created,started,repeated,runs,defaults,otherPipeline:b.pipeline},null,2));
    check(f.errors).toEqual([]);
  } finally {await f.cleanup();}
});

test("squad quick creation hands the preserved prompt to execution selection without dispatch", async ({page}, info) => {
  const f=await fixture(page);
  try {
    const a=await f.post("/api/pipelines/catalog",{squad_id:f.squad.id,name:"Chosen after quick capture",source:yaml,idempotency_key:randomUUID()});
    const writes: string[]=[];
    page.on("request",request=>{if(request.method()==="POST" && /quick-create|sub-issues/.test(request.url())) writes.push(request.url());});
    await page.goto(`/${f.workspace.slug}/issues`);
    await page.getByRole("button",{name:"New Issue",exact:true}).click();
    await page.getByRole("button",{name:"Switch to Agent",exact:true}).click();
    const dialog=page.getByRole("dialog");
    await dialog.getByText("Created by",{exact:true}).click();
    await page.getByText(f.squad.name,{exact:true}).click();
    await dialog.locator('.ProseMirror[contenteditable="true"]').fill("Preserve this squad prompt before choosing execution.");
    await dialog.getByRole("button",{name:/Choose execution/}).click();
    const selector=dialog.getByRole("combobox",{name:"This issue’s execution"});
    await check(selector).toBeEnabled();
    await selector.selectOption(a.pipeline.id);
    await check(dialog.getByTestId("execution-summary")).toContainText("Chosen after quick capture · v1");
    await check(dialog).toContainText("Preserve this squad prompt before choosing execution.");
    await dialog.getByRole("textbox",{name:"Issue title"}).fill("Finish this preserved squad draft");
    await page.setViewportSize({width:390,height:500});
    await selector.scrollIntoViewIfNeeded();
    await check(dialog.getByRole("button",{name:"Create Issue",exact:true})).toBeInViewport({ratio:1});
    await page.setViewportSize({width:390,height:844});
    await check(dialog.getByRole("button",{name:"Create Issue",exact:true})).toBeInViewport({ratio:1});
    await check(dialog.getByText("Preserve this squad prompt before choosing execution.",{exact:true})).toBeInViewport({ratio:1});
    await page.screenshot({animations:"disabled",style:"nextjs-portal { display: none !important; }",path:info.outputPath("quick-handoff-390.png"),fullPage:true});
    check(writes).toEqual([]);check(f.errors).toEqual([]);
  } finally {await f.cleanup();}
});

test("default and guidance choices stay task-local, and personal assignment removes the selector", async ({page}, info) => {
  test.setTimeout(180_000);
  const f=await fixture(page);
  try {
    const a=await f.post("/api/pipelines/catalog",{squad_id:f.squad.id,name:"Default workflow",source:yaml,idempotency_key:randomUUID()});
    const squad=await (await f.api.request(`/api/squads/${f.squad.id}`)).json();
    const updated=await f.api.request(`/api/squads/${f.squad.id}`,{method:"PUT",body:JSON.stringify({pipeline_id:a.pipeline.id,expected_revision:squad.revision})});
    check(updated.status).toBe(200);
    const requests: unknown[]=[];
    page.on("request", r => {if(r.method()==="POST" && r.url().endsWith("/api/issues")) requests.push(r.postDataJSON());});
    await page.goto(`/${f.workspace.slug}/issues`);
    for (const mode of ["default","markdown"]) {
      await page.getByRole("button",{name:"New Issue",exact:true}).click();
      const dialog=page.getByRole("dialog",{name:"New Issue",exact:true});
      await dialog.getByRole("textbox",{name:"Issue title"}).fill(`Task-specific ${mode}`);
      const unassigned=dialog.getByRole("button",{name:"Unassigned",exact:true});
      if(await unassigned.count()) {
        await unassigned.click();await page.getByRole("button",{name:f.squad.name,exact:true}).click();
      }
      const selector=dialog.getByRole("combobox",{name:"This issue’s execution"});
      await check(selector).toBeEnabled();await selector.selectOption(mode);
      await check(dialog.getByRole("button",{name:"Create Issue",exact:true})).toBeEnabled();
      const pending=page.waitForResponse(r=>r.request().method()==="POST" && r.url().endsWith("/api/issues"));
      await dialog.getByRole("button",{name:"Create Issue",exact:true}).click();
      const created=await (await pending).json();f.issueIds.push(created.id);
      check(created.execution.requested_mode).toBe(mode);
      check(created.execution.mode).toBe(mode==="default"?"pipeline":"markdown");
      const result=page.getByRole("dialog",{name:"Issue created",exact:true});
      await check(result.getByRole("heading",{name:"Issue created"})).toBeVisible();
      await result.getByRole("button",{name:"Close",exact:true}).click();
    }
    await page.getByRole("button",{name:"New Issue",exact:true}).click();
    const dialog=page.getByRole("dialog",{name:"New Issue",exact:true});
    const title=dialog.getByRole("textbox",{name:"Issue title"});
    await title.fill("Personal task keeps its draft");
    await dialog.getByRole("button",{name:f.squad.name,exact:true}).first().click();
    await page.getByRole("button",{name:"Unassigned",exact:true}).click();
    await check(dialog.getByTestId("execution-selection")).toHaveCount(0);
    await check(title).toHaveText("Personal task keeps its draft");
    const pending=page.waitForResponse(r=>r.request().method()==="POST" && r.url().endsWith("/api/issues"));
    await title.press("Meta+Enter");
    const created=await (await pending).json();f.issueIds.push(created.id);
    check(created.execution ?? null).toBeNull();
    check(requests).toHaveLength(3);
    check(requests[0]).toMatchObject({execution:{mode:"default"},idempotency_key:expect.any(String)});
    check(requests[1]).toMatchObject({execution:{mode:"markdown"},idempotency_key:expect.any(String)});
    check(requests[2]).not.toHaveProperty("execution");
    const after=await (await f.api.request(`/api/squads/${f.squad.id}`)).json();
    check(after.pipeline_definition_id).toBe(a.definition.id);
    await writeFile(info.outputPath("task-local-requests.json"),JSON.stringify({requests,after},null,2));
    check(f.errors).toEqual([]);
  } finally {await f.cleanup();}
});
