import { test, expect as baseExpect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createTestApi } from "./helpers";

const expect = baseExpect.configure({ timeout: 15_000 });
test.use({ actionTimeout: 15_000 });
const runtimeErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
  expect(runtimeErrors.get(page)).toEqual([]);
});
async function setup(page: Page, deep = false) {
  const api = await createTestApi(),
    workspace = (await api.getWorkspaces())[0]!;
  const project = await api.createProject("v1.8 progress canonical");
  const issue = await api.createIssue("Frozen task progress", {
    project_id: project.id,
    description: "Task reading position must stay here.\n\n".repeat(90),
  });
  const agent = await api.seedDocumentAgent(issue.id);
  const post = async (path: string, body: unknown) => {
    const res = await api.request(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(res.ok, await res.clone().text()).toBe(true);
    return res.json();
  };
  const squad = await post("/api/squads", {
    name: "Progress fixture team",
    leader_id: agent.agentId,
  });
  try {
    const candidates = await (
      await api.request(`/api/pipelines/candidates?squad_id=${squad.id}`)
    ).json();
    const stages = deep
      ? Array.from({ length: 14 }, (_, i) => `Stage ${i + 1}`)
      : ["Preparation", "Parallel", "Sign-off"];
    const source = deep
      ? `kind: gitlab_yaml\nstages: ${JSON.stringify(stages)}\n` +
        stages
          .map(
            (stage, i) =>
              `node_${i}:\n  title: ${i === 13 ? "Deep final approval" : `Frozen node ${i + 1}`}\n  stage: ${JSON.stringify(stage)}\n  needs: []\n  when: manual\n  owner_user_id: ${candidates.current_user.user_id}\n`,
          )
          .join("")
      : `kind: gitlab_yaml\nstages: [Preparation, Parallel, Sign-off]\ncollect:\n  title: Frozen research\n  stage: Preparation\n  instructions: Preserve the original research instruction.\n  needs: []\nbuild:\n  title: Frozen implementation\n  stage: Parallel\n  needs: []\n  instructions: Preserve the original implementation instruction.\nreview:\n  title: Frozen parallel review\n  stage: Parallel\n  needs: []\n  when: manual\n  owner_user_id: ${candidates.current_user.user_id}\npublish:\n  title: Frozen final sign-off\n  stage: Sign-off\n  needs: [collect, build, review]\n  when: manual\n  owner_user_id: ${candidates.current_user.user_id}\n`;
    const created = await post("/api/pipelines/catalog", {
      squad_id: squad.id,
      name: "Frozen delivery workflow",
      source,
      idempotency_key: randomUUID(),
      activate: true,
      expected_revision: squad.revision,
    });
    await api.updateIssue(issue.id, {
      assignee_type: "squad",
      assignee_id: squad.id,
    });
    const runs = await (
      await api.request(`/api/pipeline-runs?issue_id=${issue.id}`)
    ).json();
    expect(runs.items).toHaveLength(1);
    const original = runs.items[0];
    const state = {
      ...original,
      status: "running",
      reason: "",
      jobs: original.jobs.map(
        (
          job: { node: { id: string; type: string }; revision: number },
          i: number,
        ) => ({
          ...job,
          status: deep
            ? "waiting_approval"
            : i === 0
              ? "succeeded"
              : i === 1
                ? "running"
                : i === 2
                  ? "waiting_approval"
                  : "pending",
          reason: i === 2 ? "Review the current delivery" : "",
          owner_id:
            job.node.type === "manual"
              ? candidates.current_user.user_id
              : undefined,
          attempts:
            i === 1 && !deep
              ? [
                  {
                    number: 1,
                    task_id: agent.taskId,
                    executor_id: agent.agentId,
                    status: "failed",
                    inputs: [],
                    report: null,
                    usage: [],
                  },
                  {
                    number: 2,
                    task_id: agent.taskId,
                    executor_id: agent.agentId,
                    status: "running",
                    inputs: [],
                    report: null,
                    usage: [],
                  },
                ]
              : [],
        }),
      ),
    };
    const history = await api.seedPipelineProgress(
      original.id,
      state,
      deep ? 0 : 52,
    );
    await page.addInitScript((token) => {
      localStorage.setItem("multica_token", token!);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, api.getToken());
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    const writes: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/pipeline-runs") && r.method() !== "GET")
        writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    const visit = async () => {
      await page.goto(`/${workspace.slug}/issues/${issue.id}`);
      await expect(page.getByTestId("issue-pipeline-card")).toHaveAttribute(
        "data-progress-run",
        original.id,
      );
    };
    return {
      api,
      workspace,
      project,
      issue,
      agent,
      squad,
      created,
      original,
      state,
      history,
      post,
      writes,
      visit,
      cleanup: async () => {
        await api.removePipelineSquadFixture(squad.id);
        await api.cleanup();
      },
    };
  } catch (error) {
    await api.removePipelineSquadFixture(squad.id);
    await api.cleanup();
    throw error;
  }
}
async function capture(page: Page, path: string) {
  await page.screenshot({
    path,
    animations: "disabled",
    style: "nextjs-portal{display:none!important}",
  });
}

test("uses paginated frozen snapshots, keeps explicit history on a real pipeline event, and updates concurrent nodes without moving the reader or focus", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const f = await setup(page);
  try {
    const catalog = await (
      await f.api.request(`/api/pipelines/catalog/${f.created.pipeline.id}`)
    ).json();
    const changedDefinition = await f.post("/api/pipelines/definitions", {
      squad_id: f.squad.id,
      pipeline_id: f.created.pipeline.id,
      expected_pipeline_revision: catalog.revision,
      source: f.created.definition.source.replace(
        "Frozen implementation",
        "New definition implementation",
      ),
      idempotency_key: randomUUID(),
    });
    expect(changedDefinition.revision).toBe(2);
    const pages: number[] = [];
    page.on("response", (r) => {
      const u = new URL(r.url());
      if (
        u.pathname === "/api/pipeline-runs" &&
        u.searchParams.get("issue_id") === f.issue.id
      )
        pages.push(Number(u.searchParams.get("offset")));
    });
    await f.visit();
    const card = page.getByTestId("issue-pipeline-card"),
      picker = card.getByRole("combobox", { name: "Run history" });
    await expect(picker.locator("option")).toHaveCount(53);
    expect(pages).toContain(50);
    await expect(card.locator('[data-progress-node="build"]')).toContainText(
      "Attempt 2",
    );
    await expect(card.locator('[data-progress-node="build"]')).toContainText(
      "Running",
    );
    await expect(card.locator('[data-progress-node="review"]')).toContainText(
      "Waiting for approval",
    );
    await expect(card.getByTestId("pipeline-progress-counts")).toContainText(
      "Succeeded 1/4",
    );
    await capture(page, info.outputPath("progress-desktop.png"));
    const old = f.history[0]!;
    await picker.selectOption(old);
    await expect(card).toHaveAttribute("data-progress-run", old);
    await expect(card.getByTestId("pipeline-progress-counts")).toContainText(
      "Succeeded 0/4",
    );
    await expect(card.getByTestId("pipeline-progress-counts")).toContainText(
      "Failed 1",
    );
    await expect(card.getByTestId("pipeline-progress-counts")).toContainText(
      "Skipped 3",
    );
    await capture(page, info.outputPath("progress-failed-0-of-4.png"));
    // This real API decision emits pipeline:updated; history must remain pinned.
    const gate = f.state.jobs.find(
      (job: { node: { id: string } }) => job.node.id === "review",
    );
    const decided = await f.post(
      `/api/pipeline-runs/${f.original.id}/jobs/review/decisions`,
      {
        decision: "approve",
        reason: "Current evidence reviewed",
        expected_revision: gate.revision,
        idempotency_key: randomUUID(),
      },
    );
    await expect.poll(() => pages.length).toBeGreaterThan(2);
    await expect(picker).toHaveValue(old);
    await expect(card).toHaveAttribute("data-progress-run", old);
    await picker.selectOption(f.original.id);
    await expect(card).toHaveAttribute("data-progress-run", f.original.id);
    const reader = page.locator(`[data-tab-scroll-root="main:${f.issue.id}"]`);
    await reader.hover();
    await page.mouse.wheel(0, -650);
    const before = await reader.evaluate((el) => el.scrollTop);
    await picker.focus();
    await f.api.seedPipelineProgress(f.original.id, {
      ...decided,
      status: "running",
      jobs: decided.jobs.map((job: { node: { id: string } }) =>
        job.node.id === "build"
          ? { ...job, status: "succeeded", reason: "" }
          : job,
      ),
    });
    await card
      .getByRole("button", { name: "Refresh", exact: true })
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(card.getByTestId("pipeline-progress-counts")).toContainText(
      "Succeeded 3/4",
    );
    await expect(picker).toBeFocused();
    expect(
      Math.abs((await reader.evaluate((el) => el.scrollTop)) - before),
    ).toBeLessThan(3);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const readerAfterRefresh=await reader.evaluate(el=>el.scrollTop);
    const shell = page.getByTestId("comment-composer-shell");
    if (await shell.count()) await shell.click();
    const input = reader.locator('[contenteditable="true"]').last();
    await input.fill("Keep my unsent review note");
    const inputReaderTop = await reader.evaluate((el) => el.scrollTop),
      eventPages = pages.length;
    const cancelled = await f.post(
      `/api/pipeline-runs/${f.original.id}/cancel`,
      { reason: "Fixture event check", idempotency_key: randomUUID() },
    );
    await expect.poll(() => pages.length).toBeGreaterThan(eventPages);
    await expect(input).toBeFocused();
    await expect(input).toContainText("Keep my unsent review note");
    expect(
      Math.abs((await reader.evaluate((el) => el.scrollTop)) - inputReaderTop),
    ).toBeLessThan(3);
    expect(f.writes).toEqual([]);
    await writeFile(
      info.outputPath("progress-http.json"),
      JSON.stringify(
        {
          original: f.original,
          historyCount: f.history.length,
          history: old,
          listOffsets: pages,
          decided,
          changedDefinition,
          cancelled,
          inputFocusRetained: true,
          readerBefore: before,
          readerAfter: readerAfterRefresh,
          inputReaderBefore:inputReaderTop,
          inputReaderAfter:await reader.evaluate(el=>el.scrollTop),
          sidebarWrites: f.writes,
        },
        null,
        2,
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("traps keyboard focus at 390px and returns from existing run details to a fully visible deep sidebar node without moving task reading", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const f = await setup(page, true);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${f.workspace.slug}/issues/${f.issue.id}`);
    const reader = page.locator(`[data-tab-scroll-root="main:${f.issue.id}"]`);
    await expect(reader).toBeVisible();
    await expect.poll(()=>reader.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop)).toBeLessThan(3);
    await reader.hover();
    const beforeWheel=await reader.evaluate(el=>el.scrollTop);
    await page.mouse.wheel(0, -400);
    await expect.poll(()=>reader.evaluate(el=>el.scrollTop)).toBeLessThan(beforeWheel-390);
    const reading = await reader.evaluate((el) => el.scrollTop);
    const opener = page.getByRole("button", {
      name: "Toggle right sidebar",
      exact: true,
      includeHidden: true,
    });
    await opener.click();
    const sheet = page.getByTestId("issue-properties-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('[data-progress-node="node_0"]')).toBeVisible();
    await capture(page,info.outputPath("progress-overview-390.png"));
    const close = sheet.getByRole("button", {
      name: "Close properties",
      exact: true,
    });
    await close.focus();
    await page.keyboard.press("Shift+Tab");
    await expect
      .poll(() =>
        page.evaluate(() =>
          document
            .querySelector('[data-testid="issue-properties-sheet"]')
            ?.contains(document.activeElement),
        ),
      )
      .toBe(true);
    await opener.evaluate((el) => (el as HTMLElement).focus());
    await expect
      .poll(() =>
        page.evaluate(() =>
          document
            .querySelector('[data-testid="issue-properties-sheet"]')
            ?.contains(document.activeElement),
        ),
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(opener).toBeFocused();
    await opener.press("Enter");
    await expect(sheet).toBeVisible();
    const node = sheet.locator('[data-progress-node="node_13"]');
    await node.focus();
    await node.press("Enter");
    const dialog = page.getByTestId("pipeline-node-details");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Deep final approval", exact: true }),
    ).toBeInViewport();
    await expect(
      dialog.locator('.pipeline-node[aria-pressed="true"]').last(),
    ).toContainText("Deep final approval");
    await capture(page, info.outputPath("progress-node-details-390.png"));
    await dialog
      .getByRole("button", { name: "Back to sidebar node", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(node).toBeFocused();
    const bounds = await node.evaluate((el) => {
      const a = el.getBoundingClientRect(),
        b = document
          .querySelector('[data-testid="issue-properties-sheet"]')!
          .getBoundingClientRect();
      return {
        top: a.top,
        bottom: a.bottom,
        containerTop: b.top,
        containerBottom: b.bottom,
      };
    });
    expect(bounds.top).toBeGreaterThanOrEqual(bounds.containerTop);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.containerBottom);
    expect(
      Math.abs((await reader.evaluate((el) => el.scrollTop)) - reading),
    ).toBeLessThan(3);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await capture(page, info.outputPath("progress-deep-return-390.png"));
    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();
    expect(f.writes).toEqual([]);
    await writeFile(
      info.outputPath("progress-keyboard.json"),
      JSON.stringify(
        {
          bounds,
          readerBefore: reading,
          readerAfter: await reader.evaluate((el) => el.scrollTop),
          windowTop: await page.evaluate(() => window.scrollY),
          sidebarWrites: f.writes,
        },
        null,
        2,
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("keeps unavailable, malformed, forbidden, empty and unknown snapshots distinct in the actual HTTP consumer", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const f = await setup(page);
  try {
    await f.visit();
    const card = page.getByTestId("issue-pipeline-card");
    const errors = [
      {
        status: 503,
        body: { error: "fixture unavailable" },
        text: "Unable to load pipeline progress",
      },
      {
        status: 200,
        body: { unexpected: true },
        text: "Pipeline data is invalid",
      },
      {
        status: 403,
        body: { error: "fixture forbidden" },
        text: "You do not have permission",
      },
    ];
    for (const error of errors) {
      await page.route("**/api/pipeline-runs?**", (route) =>
        route.fulfill({ status: error.status, json: error.body }),
      );
      await card.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(card.getByRole("alert")).toContainText(error.text);
      await expect(card.locator("[data-progress-node]")).toHaveCount(0);
      await page.unroute("**/api/pipeline-runs?**");
    }
    await f.api.seedPipelineProgress(f.original.id, {
      ...f.state,
      status: "future_policy_hold",
      jobs: f.state.jobs.map((job: object, i: number) => ({
        ...job,
        status: i ? "succeeded" : "future_node_hold",
      })),
    });
    await page.reload();
    await card
      .getByRole("combobox", { name: "Run history" })
      .selectOption(f.original.id);
    await expect(card).toContainText("Unknown status (future_policy_hold)");
    await expect(card).toContainText("Unknown status (future_node_hold)");
    await expect(
      card.getByTestId("pipeline-progress-counts").locator(".bg-success"),
    ).toHaveCount(0);
    await capture(page, info.outputPath("progress-unknown.png"));
    const markdown = await f.api.createIssue(
      "Explicit instructions remain ordinary",
      {
        project_id: f.project.id,
        assignee_type: "squad",
        assignee_id: f.squad.id,
        execution: { mode: "markdown" },
      },
    );
    const squad = await (
      await f.api.request(`/api/squads/${f.squad.id}`)
    ).json();
    const enabled = await f.api.request(`/api/squads/${f.squad.id}`, {
      method: "PUT",
      body: JSON.stringify({
        instructions_mode: "pipeline",
        pipeline_definition_id: f.created.definition.id,
        expected_revision: squad.revision,
      }),
    });
    expect(enabled.ok).toBe(true);
    await page.goto(`/${f.workspace.slug}/issues/${markdown.id}`);
    await expect(
      page.locator(`[data-tab-scroll-root="main:${markdown.id}"]`),
    ).toBeVisible();
    await expect(card).toHaveCount(0);
    expect(f.writes).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
