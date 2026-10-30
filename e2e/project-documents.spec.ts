import { test, expect, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { createTestApi } from "./helpers";
import { TestApiClient } from "./fixtures";

interface Document {
  id: string;
  title: string;
  body: string;
  version: number;
  resource_uri: string;
  author_type: string;
  author_id: string;
}
const execute = promisify(execFile);
const specBody = `## 1. Context & Goals

People and agents maintain one living specification for the project.

## 2. Requirements

### REQ-DOC-01: Preserve local work

Keep unsaved titles and Markdown content when navigating or refreshing.

### REQ-DOC-02: Save immutable revisions

Every successful save records its author and the version it was based on.

## 3. Scenarios — WHEN / THEN

### Scenario: Another author saves first

**WHEN** two editors save the same base version

**THEN** one succeeds and the other can compare, keep or copy their draft.

## 4. Acceptance Criteria

- [ ] Preserve the draft
- [x] Reject stale saves
- [x] Resolve the latest resource
`;

async function setup(page: Page) {
  const api = await createTestApi();
  const workspace = (await api.getWorkspaces())[0]!;
  await page.addInitScript((token) => {
    localStorage.setItem("multica_token", token!);
    localStorage.setItem("multica:chat:isOpen", "false");
  }, api.getToken());
  page.on("dialog", (dialog) => void dialog.accept());
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1680, height: 1050 });
  const project = await api.createProject("Living project specifications");
  const path = `/${workspace.slug}/projects/${project.id}`;
  const create = async (
    title: string,
    kind = "document",
    body?: string,
  ): Promise<Document> => {
    const res = await api.request(`/api/projects/${project.id}/documents`, {
      method: "POST",
      body: JSON.stringify({
        title,
        kind,
        ...(body === undefined ? {} : { body }),
      }),
    });
    expect(res.status).toBe(201);
    return res.json();
  };
  return { api, workspace, project, path, create };
}

async function openSource(page: Page) {
  await page.getByRole("button", { name: "Source", exact: true }).click();
  return page.getByRole("textbox", { name: "Markdown source" });
}

test("creates both document kinds, edits all modes and saves Markdown checkboxes", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const { api, path } = await setup(page);
  try {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: "Specs & Docs" }).click();
    await page
      .getByRole("button", { name: "New document", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Document title")
      .fill("Project Spec & Docs workspace");
    await dialog
      .getByRole("button", { name: "Create document", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Document title" }),
    ).toHaveValue("Project Spec & Docs workspace");
    await page.getByRole("button", { name: "Split view", exact: true }).click();
    await page.getByRole("textbox", { name: "Markdown source" }).fill(specBody);
    await expect(page.locator(".document-preview")).toContainText("REQ-DOC-02");
    await page.locator(".document-canvas-scroll").evaluate((node) => {
      node.scrollTo({ top: 0, behavior: "instant" });
    });
    await page
      .getByRole("textbox", { name: "Markdown source" })
      .evaluate((node) => {
        node.scrollTo({ top: 0, behavior: "instant" });
      });
    await page.screenshot({ path: info.outputPath("spec-editor-split.png") });
    await page
      .getByRole("button", { name: "Read / edit", exact: true })
      .click();
    const rich = page.locator(".document-rich-editor");
    await expect(rich).toContainText("Preserve local work");
    await rich.locator('input[type="checkbox"]').first().check();
    await page.getByRole("button", { name: "REQ-DOC-02", exact: true }).click();
    await expect(page).toHaveURL(/#REQ-DOC-02$/);
    const source = await openSource(page);
    await expect(source).toHaveValue(/- \[x\] Preserve the draft/);
    await page
      .getByRole("button", { name: "Save revision", exact: true })
      .click();
    await expect(page.getByTestId("document-save-status")).toHaveText(
      "Saved v2",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("project-document-workspace")).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByTestId("document-save-status")).toHaveText(
      "Saved v2",
    );
    await expect(page.locator(".document-rich-editor")).toContainText(
      "Reject stale saves",
    );
    await expect(
      page.locator('.document-rich-editor input[type="checkbox"]').first(),
    ).toBeChecked();
    await page
      .locator(".document-canvas-scroll")
      .evaluate((node) => node.scrollTo({ top: 0, behavior: "instant" }));
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.screenshot({
      path: info.outputPath("spec-workspace-light.png"),
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    await page.screenshot({ path: info.outputPath("spec-workspace-dark.png") });
    await page
      .getByRole("button", { name: "New document", exact: true })
      .click();
    await dialog.getByRole("button", { name: "Document", exact: true }).click();
    await dialog.getByLabel("Document title").fill("Team guide");
    await dialog
      .getByRole("button", { name: "Create document", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Document title" }),
    ).toHaveValue("Team guide");
    const blank = await openSource(page);
    await expect(blank).toHaveValue("");
    await blank.fill("Discard this unsaved guide");
    await page
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await expect(blank).toHaveValue("");
    await expect(page.getByTestId("document-save-status")).toHaveText(
      "Saved v1",
    );
    await page.setViewportSize({ width: 720, height: 900 });
    await page
      .getByRole("button", { name: "Document details", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText("Revision history");
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Project documents", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(
      "Project Spec & Docs workspace",
    );
    await page.keyboard.press("Escape");
  } finally {
    await api.cleanup();
  }
});

test("retains failed drafts through navigation and reload, and scopes late save callbacks", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { api, path, project, create } = await setup(page);
  try {
    const a = await create("Document A", "document", "Saved A");
    const b = await create("Document B", "document", "Saved B");
    await page.goto(`${path}?view=docs&document=${a.id}`, {
      waitUntil: "domcontentloaded",
    });
    const source = await openSource(page);
    await source.fill("Local A body — still recoverable");
    await page
      .getByRole("textbox", { name: "Document title" })
      .fill("Local A title");
    await page.getByRole("link", { name: /Document B/ }).click();
    await page.getByRole("link", { name: /Local A title/ }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("project-document-workspace")).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByTestId("document-save-status")).toHaveText(
      "Unsaved draft",
    );
    await expect(await openSource(page)).toHaveValue(
      "Local A body — still recoverable",
    );
    const endpoint = `**/api/projects/${project.id}/documents/${a.id}`;
    await page.route(endpoint, async (route) => {
      if (route.request().method() === "PUT")
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"error":"offline fixture"}',
        });
      else await route.continue();
    });
    await page
      .getByRole("button", { name: "Save revision", exact: true })
      .click();
    await expect(page.getByTestId("document-save-status")).toHaveText(
      "Could not save",
    );
    await expect(
      page.getByTestId("project-document-workspace").getByRole("alert"),
    ).toContainText("offline fixture");
    await page.getByRole("link", { name: /Document B/ }).click();
    await expect(
      page.getByRole("textbox", { name: "Document title" }),
    ).toHaveValue("Document B");
    await page.getByRole("link", { name: /Local A title/ }).click();
    await expect(page.getByTestId("document-save-status")).toHaveText(
      "Could not save",
    );
    await page
      .getByTestId("project-document-workspace")
      .getByRole("link", { name: "Issues", exact: true })
      .click();
    await page.getByRole("link", { name: "Specs & Docs", exact: true }).click();
    await page.getByRole("link", { name: /Local A title/ }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("project-document-workspace")).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByTestId("document-save-status")).toHaveText(
      "Could not save",
    );
    await expect(await openSource(page)).toHaveValue(
      "Local A body — still recoverable",
    );
    await page
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Keep draft" })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Document title" }),
    ).toHaveValue("Local A title");
    await page.unroute(endpoint);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await page.route(endpoint, async (route) => {
      if (route.request().method() === "PUT") {
        entered();
        await gate;
      }
      await route.continue();
    });
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/documents/${a.id}`) &&
        r.request().method() === "PUT" &&
        r.status() === 200,
    );
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await requestStarted;
    await page.getByRole("link", { name: /Document B/ }).click();
    release();
    await response;
    await expect(
      page.getByRole("textbox", { name: "Document title" }),
    ).toHaveValue("Document B");
    await expect(page.getByTestId("document-save-status")).toHaveText(
      "Saved v1",
    );
    const savedB = (await (
      await api.request(`/api/projects/${project.id}/documents/${b.id}`)
    ).json()) as Document;
    expect(savedB.version).toBe(1);
    expect(savedB.body).toBe("Saved B");
    await page.getByRole("link", { name: /Local A title/ }).click();
    await expect(page.getByTestId("document-save-status")).toHaveText(
      "Saved v2",
    );
    await expect(await openSource(page)).toHaveValue(
      "Local A body — still recoverable",
    );
  } finally {
    await api.cleanup();
  }
});

test("compares real conflicts, rejects a newly stale confirmation, and preserves both fields in a copy", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const { api, project, path, create } = await setup(page);
  try {
    const doc = await create("Initial title", "spec", specBody);
    const endpoint = `/api/projects/${project.id}/documents/${doc.id}`;
    const update = (version: number, title: string, body: string) =>
      api.request(endpoint, {
        method: "PUT",
        body: JSON.stringify({ base_version: version, title, body }),
      });
    await page.goto(`${path}?view=docs&document=${doc.id}`, {
      waitUntil: "domcontentloaded",
    });
    await (await openSource(page)).fill("Local body unique marker");
    await page
      .getByRole("textbox", { name: "Document title" })
      .fill("Local renamed title");
    expect((await update(1, "Remote title v2", "Remote body v2")).status).toBe(
      200,
    );
    await page
      .getByRole("button", { name: "Compare revisions", exact: true })
      .click();
    const diff = page.getByRole("dialog");
    await expect(diff).toContainText("Local renamed title");
    await expect(diff).toContainText("Local body unique marker");
    await expect(diff).toContainText("Remote title v2");
    await expect(diff).toContainText("Remote body v2");
    await diff.getByText("Original base", { exact: false }).click();
    await expect(diff).toContainText("Initial title");
    expect((await update(2, "Remote title v3", "Remote body v3")).status).toBe(
      200,
    );
    const rejected = page.waitForResponse(
      (r) =>
        r.url().endsWith(endpoint) &&
        r.request().method() === "PUT" &&
        r.status() === 409,
    );
    await diff
      .getByRole("button", { name: "Save local as new revision", exact: true })
      .click();
    await expect(page.getByRole("alertdialog")).toContainText("v2");
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Save local as new revision" })
      .click();
    await rejected;
    await expect(page.getByRole("dialog")).toContainText("Remote title v3");
    await expect(page.getByRole("dialog")).toContainText("Local renamed title");
    await expect(page.locator('[role="alertdialog"]')).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: info.outputPath("spec-revision-diff.png") });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Keep draft", exact: true })
      .click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("project-document-workspace")).toBeVisible({
      timeout: 30000,
    });
    await expect(
      page.getByRole("textbox", { name: "Document title" }),
    ).toHaveValue("Local renamed title");
    await expect(page.getByTestId("document-save-status")).toHaveText(
      "Newer revision available",
    );
    await page
      .getByRole("button", { name: "Compare revisions", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Save local copy", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Document title" }),
    ).toHaveValue("Local renamed title (local copy)");
    await expect(await openSource(page)).toHaveValue(
      "Local body unique marker",
    );
    const original = (await (await api.request(endpoint)).json()) as Document;
    expect(original).toMatchObject({
      title: "Remote title v3",
      body: "Remote body v3",
      version: 3,
    });
  } finally {
    await api.cleanup();
  }
});

test("agent CLI revisions resolve through project resources and appear in the browser with authenticated authors", async ({
  page,
}, info) => {
  test.skip(
    !process.env.MULTICA_E2E_CLI,
    "Build the source CLI and set MULTICA_E2E_CLI to exercise the actual binary",
  );
  test.setTimeout(120_000);
  const { api, workspace, project, path, create } = await setup(page);
  const outsider = new TestApiClient();
  try {
    const doc = await create("Agent maintained Spec", "spec", specBody);
    const issue = await api.createIssue("Read the project Spec", {
      project_id: project.id,
    });
    const identity = await api.seedDocumentAgent(issue.id);
    const serverURL =
      process.env.NEXT_PUBLIC_API_URL ||
      `http://localhost:${process.env.PORT || "8080"}`;
    const run = async (args: string[]) => {
      const { stdout } = await execute(process.env.MULTICA_E2E_CLI!, args, {
        env: {
          ...process.env,
          MULTICA_SERVER_URL: serverURL,
          MULTICA_TOKEN: identity.token,
          MULTICA_WORKSPACE_ID: identity.workspaceId,
          MULTICA_AGENT_ID: identity.agentId,
          MULTICA_TASK_ID: identity.taskId,
        },
      });
      return JSON.parse(stdout);
    };
    await page.goto(`${path}?view=docs&document=${doc.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("document-save-status")).toHaveText(
      "Saved v1",
    );
    const listed = await run([
      "project",
      "document",
      "list",
      project.id,
      "--output",
      "json",
    ]);
    expect(listed.documents.map((d: Document) => d.id)).toContain(doc.id);
    const read = await run([
      "project",
      "document",
      "get",
      project.id,
      doc.resource_uri,
      "--output",
      "json",
    ]);
    expect(read.version).toBe(1);
    const bodyFile = info.outputPath("agent-revision.md");
    await writeFile(
      bodyFile,
      "## REQ-CLI-01: Agent submitted revision\n\n- [x] CLI and resource read verified\n",
      "utf8",
    );
    const saved = await run([
      "project",
      "document",
      "update",
      project.id,
      doc.id,
      "--base-version",
      "1",
      "--title",
      "Agent updated title",
      "--body-file",
      bodyFile,
      "--output",
      "json",
    ]);
    expect(saved).toMatchObject({
      version: 2,
      author_type: "agent",
      author_id: identity.agentId,
      author_name: "Spec maintainer",
    });
    await expect(
      page.getByRole("textbox", { name: "Document title" }),
    ).toHaveValue("Agent updated title", { timeout: 15_000 });
    await expect(page.getByTestId("document-save-status")).toHaveText(
      "Saved v2",
    );
    await expect(page.locator(".document-rich-editor")).toContainText(
      "CLI and resource read verified",
    );
    await expect(page.locator(".document-inspector")).toContainText(
      "Spec maintainer",
    );
    const resources = await run([
      "project",
      "resource",
      "list",
      project.id,
      "--output",
      "json",
    ]);
    const resource = resources.find(
      (r: { resource_type: string; resource_ref: { document_id: string } }) =>
        r.resource_type === "project_document" &&
        r.resource_ref.document_id === doc.id,
    );
    expect(resource).toBeTruthy();
    expect(
      await (
        await api.request(
          `/api/projects/${project.id}/resources/${resource.id}/content`,
        )
      ).json(),
    ).toMatchObject({
      title: "Agent updated title",
      version: 2,
      author_type: "agent",
    });
    const history = await run([
      "project",
      "document",
      "history",
      project.id,
      doc.id,
      "--output",
      "json",
    ]);
    expect(
      history.revisions.map((r: { author_type: string }) => r.author_type),
    ).toEqual(["agent", "member"]);
    const otherProject = await api.createProject("Other document scope");
    expect(
      (
        await api.request(
          `/api/projects/${otherProject.id}/documents/${doc.id}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await api.request(
          `/api/projects/${otherProject.id}/resources/${resource.id}/content`,
        )
      ).status,
    ).toBe(404);
    await outsider.login(
      `document-outsider-${Date.now()}@multica.ai`,
      "Outsider",
    );
    outsider.setWorkspaceSlug(workspace.slug);
    expect(
      (
        await outsider.request(
          `/api/projects/${project.id}/documents/${doc.id}`,
        )
      ).status,
    ).toBe(404);
    const forged = await api.request(
      `/api/projects/${project.id}/documents/${doc.id}`,
      {
        method: "PUT",
        headers: {
          "X-Agent-ID": identity.agentId,
          "X-Task-ID": identity.taskId,
          "X-Actor-Source": "task_token",
        },
        body: JSON.stringify({
          base_version: 2,
          title: "Member revision",
          body: "Member authored",
        }),
      },
    );
    expect(forged.status).toBe(200);
    expect((await forged.json()).author_type).toBe("member");
  } finally {
    await api.cleanup();
    await outsider.cleanup();
  }
});
