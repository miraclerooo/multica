import { test, expect, type Page } from "@playwright/test";
import { createTestApi } from "./helpers";
import { TestApiClient } from "./fixtures";

test.use({ actionTimeout: 15000 });

const guideline =
  "> 项目成员共同维护的研发规范。\n\n## 1. 研发协作流程\n\n先明确验收标准，再开展实现与评审。\n\n| 阶段 | 交付物 |\n| --- | --- |\n| 设计 | 原型与交互说明 |\n| 实现 | 代码与测试结果 |\n\n### 1.1 提交前检查\n\n- [ ] 核对需求与验收标准\n- [ ] 完成针对性验证\n\n## 2. Git 分支与提交规范\n\n使用清晰的提交说明，保持每次改动聚焦。\n\n```ts\nconst document = { title: '项目规范', revision: 1 };\n```";
async function signIn(page: Page, api: TestApiClient) {
  await page.addInitScript((token) => {
    localStorage.setItem("multica_token", token!);
    localStorage.setItem("multica:chat:isOpen", "false");
    localStorage.setItem("multica_locale", "en");
  }, api.getToken());
  await page.setViewportSize({ width: 1920, height: 1080 });
}

test("project document board, rich/source editing, navigation flush and deletion", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const api = await createTestApi();
  const ws = (await api.getWorkspaces())[0]!;
  const project = await api.createProject("Multica", {
    status: "in_progress",
    description: "团队成员共享项目规范，清晰地推进协作。",
  });
  try {
    const first = await api.createProjectDocument(project.id, {
      title: "项目协作与研发规范",
      content: guideline,
      is_pinned: true,
    });
    const second = await api.createProjectDocument(project.id, {
      title: "UI 视觉与设计系统准则",
      content: "## 设计变量\n\n沿用项目的字体、间距、颜色和圆角。",
      is_pinned: true,
      position: 1,
    });
    for (const [position, title] of [
      "项目文档 API 与并发冲突契约",
      "Workspace 与智能体架构概览",
      "前端组件分层与国际化规范",
      "发布检查清单",
    ].entries())
      await api.createProjectDocument(project.id, {
        title,
        content: "## 项目约定\n\n记录并共享项目开发规范，让团队成员保持一致。",
        position,
      });
    await signIn(page, api);
    await page.goto(`/${ws.slug}/projects/${project.id}?tab=docs`);
    await expect(
      page.getByRole("button", { name: "New document", exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: testInfo.outputPath("docs-board.png") });
    await page.getByPlaceholder("Search titles or excerpts...").fill("API");
    await expect(page.getByRole("link", { name: /项目文档 API/ })).toHaveCount(
      1,
    );
    await expect(
      page.getByRole("link", { name: /项目协作与研发规范/ }),
    ).toHaveCount(0);
    await page.getByPlaceholder("Search titles or excerpts...").fill("");
    await page
      .getByRole("button", { name: "Compact list", exact: true })
      .click();
    await expect(
      page.getByRole("columnheader", { name: "Revision" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cards", exact: true }).click();
    await page.getByRole("link", { name: /项目协作与研发规范/ }).click();
    await expect(
      page.getByRole("heading", { name: "1. 研发协作流程", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("docs-reader.png") });
    const handle = page.getByRole("button", {
      name: "Reorder 项目协作与研发规范",
      exact: true,
    });
    await expect(handle).toBeEnabled();
    await handle.focus();
    await page.keyboard.press("Space");
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("ArrowDown");
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: `was moved over droppable area ${second.id}` }),
    ).toBeAttached();
    await page.keyboard.press("Space");
    await expect
      .poll(
        async () =>
          (await api.getProjectDocument(project.id, first.id)).position,
      )
      .toBe(1);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(
      page.getByRole("toolbar", { name: "Document formatting" }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("docs-editor.png") });
    const rich = page
      .getByRole("toolbar", { name: "Document formatting" })
      .locator("..")
      .locator('.ProseMirror[contenteditable="true"]');
    await rich.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Rich editor verification");
    await page.getByRole("button", { name: "Source", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Markdown source" }),
    ).toHaveValue(/Rich editor verification/);
    const source = page.getByRole("textbox", { name: "Markdown source" });
    await source.fill(
      guideline + "\n\n## Navigation flush\n\nSaved before the debounce.",
    );
    await page
      .getByRole("button", { name: "Document board", exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await expect
      .poll(
        async () =>
          (await api.getProjectDocument(project.id, first.id)).content,
      )
      .toContain("Navigation flush");
    await page.getByRole("link", { name: /项目协作与研发规范/ }).click();
    await page.getByRole("button", { name: "Source", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Markdown source" })
      .fill(guideline + "\n\nUnmount save verification");
    await page
      .getByRole("link", { name: "Projects", exact: true })
      .first()
      .click();
    await expect
      .poll(
        async () =>
          (await api.getProjectDocument(project.id, first.id)).content,
      )
      .toContain("Unmount save verification");
    await page.goto(`/${ws.slug}/projects/${project.id}?tab=docs`);
    await page
      .getByRole("button", { name: "New document", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("textbox", { name: "Document title" })
      .fill("New acceptance guideline");
    await dialog
      .getByRole("button", { name: "New document", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Document title" }),
    ).toHaveValue("New acceptance guideline");
    const newEditor = page
      .getByRole("toolbar", { name: "Document formatting" })
      .locator("..")
      .locator('.ProseMirror[contenteditable="true"]');
    await newEditor.click();
    await page.keyboard.type("/h2");
    await page.getByRole("button", { name: /^\/h2/ }).click();
    await page.keyboard.type("Acceptance");
    await page.getByRole("button", { name: "Source", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Markdown source" }),
    ).toHaveValue(/## Acceptance/);
    await page
      .getByRole("textbox", { name: "Markdown source" })
      .fill("## Acceptance\n\nA complete document.");
    await page
      .getByRole("navigation", { name: "Project views" })
      .getByRole("button", { name: /Issues/ })
      .click();
    await expect(page).not.toHaveURL(/tab=docs/);
    await page.goBack();
    await expect(
      page.getByRole("textbox", { name: "Document title" }),
    ).toHaveValue("New acceptance guideline");
    await page.getByRole("button", { name: "More document actions" }).click();
    await page.getByRole("menuitem", { name: "Delete document" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    const createdId = new URL(page.url()).searchParams.get("doc")!;
    const beforeDelete = await api.getProjectDocument(project.id, createdId);
    await api.updateProjectDocument(project.id, createdId, {
      revision: beforeDelete.revision,
      content: "Changed during delete confirmation",
    });
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete document", exact: true })
      .click();
    await expect(page.getByRole("alertdialog")).toContainText(
      "Deletion failed",
    );
    expect((await api.getProjectDocument(project.id, createdId)).content).toBe(
      "Changed during delete confirmation",
    );
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await page.getByRole("button", { name: "More document actions" }).click();
    await page.getByRole("menuitem", { name: "Delete document" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete document", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "New document", exact: true }),
    ).toBeVisible();
  } finally {
    await api.cleanup();
  }
});

test("Chinese document views remain usable on narrow screens and in dark mode", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(120_000);
  const api = await createTestApi();
  const ws = (await api.getWorkspaces())[0]!;
  const project = await api.createProject("Multica", {
    status: "in_progress",
    description: "团队成员在同一工作区共享项目规范与任务。",
  });
  try {
    await api.setLanguage("zh-Hans");
    const first = await api.createProjectDocument(project.id, {
      title: "项目协作与研发规范",
      content: guideline,
      is_pinned: true,
    });
    await api.createProjectDocument(project.id, {
      title: "UI 视觉与设计系统准则",
      content:
        "统一 Web 与桌面端的颜色、字体、圆角和交互反馈，保持清晰一致的界面体验。",
      is_pinned: true,
      position: 1,
    });
    for (const [position, title] of [
      "项目文档 API 与并发冲突契约",
      "Workspace 与智能体架构概览",
      "前端组件分层与国际化规范",
      "发布检查清单",
    ].entries())
      await api.createProjectDocument(project.id, {
        title,
        content: "记录项目开发中的关键约定，明确实施方式、验证方法与协作边界。",
        position,
      });
    await signIn(page, api);
    await context.addCookies([
      {
        name: "multica-locale",
        value: "zh-Hans",
        url: testInfo.project.use.baseURL!,
      },
    ]);
    await page.goto(`/${ws.slug}/projects/${project.id}?tab=docs`);
    await expect(
      page.getByRole("button", { name: "新建规范文档", exact: true }),
    ).toBeVisible();
    await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
    await page.screenshot({ path: testInfo.outputPath("docs-board-zh.png") });
    await page.getByRole("button", { name: "紧凑列表", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("docs-list-zh.png") });
    await page
      .getByRole("link", { name: "项目协作与研发规范", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "1. 研发协作流程", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("docs-reader-zh.png") });
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(page.getByRole("toolbar", { name: "文档排版" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("docs-editor-zh.png") });
    await page.getByRole("button", { name: "/ 快捷插入", exact: true }).click();
    await page.getByRole("menuitem", { name: "三级标题", exact: true }).click();
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
      document.documentElement.style.colorScheme = "dark";
    });
    await page.screenshot({
      path: testInfo.outputPath("docs-reader-dark.png"),
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("button", { name: "文档目录", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "返回文档看板", exact: true })
      .filter({ visible: true })
      .click();
    await page.getByRole("button", { name: "紧凑列表", exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (await api.getProjectDocument(project.id, first.id)).content,
    ).toBeTruthy();
  } finally {
    await api.setLanguage("en");
    await api.cleanup();
  }
});

test("a real 409 retains the local draft across reload and requires explicit remote adoption", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const api = await createTestApi();
  const ws = (await api.getWorkspaces())[0]!;
  const project = await api.createProject("Conflict verification");
  try {
    const doc = await api.createProjectDocument(project.id, {
      title: "Concurrent guideline",
      content: guideline,
    });
    await signIn(page, api);
    await page.goto(
      `/${ws.slug}/projects/${project.id}?tab=docs&doc=${doc.id}`,
    );
    await page.getByRole("button", { name: "Source", exact: true }).click();
    let sent = false;
    await page.route(
      `**/api/projects/${project.id}/documents/${doc.id}`,
      async (route) => {
        if (route.request().method() === "PATCH" && !sent) {
          sent = true;
          expect(route.request().postDataJSON()).toHaveProperty("revision", 1);
          expect(route.request().postDataJSON()).not.toHaveProperty(
            "expected_revision",
          );
          await api.updateProjectDocument(project.id, doc.id, {
            revision: 1,
            content: "## Remote revision\n\nKeep this remote change.",
          });
        }
        await route.continue();
      },
    );
    const conflict = page.waitForResponse(
      (r) => r.url().endsWith(`/documents/${doc.id}`) && r.status() === 409,
    );
    await page
      .getByRole("textbox", { name: "Markdown source" })
      .fill("## Local draft\n\nDo not lose this text.");
    await page.keyboard.press("ControlOrMeta+s");
    await conflict;
    await expect(
      page.getByRole("alert", { name: "Local draft retained" }),
    ).toContainText("newer revision (v2)");
    await expect(
      page.getByRole("textbox", { name: "Markdown source" }),
    ).toHaveValue("## Local draft\n\nDo not lose this text.");
    await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
    await page.screenshot({ path: testInfo.outputPath("docs-conflict.png") });
    page.once("dialog", (dialog) => void dialog.accept());
    await page.reload();
    await page.getByRole("button", { name: "Source", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Markdown source" }),
    ).toHaveValue("## Local draft\n\nDo not lose this text.");
    expect(
      (await api.getProjectDocument(project.id, doc.id)).content,
    ).toContain("Keep this remote change.");
    await page
      .getByRole("button", { name: "Load latest version", exact: true })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Load latest version", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Remote revision", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("alert", { name: "Local draft retained" }),
    ).toHaveCount(0);
  } finally {
    await api.cleanup();
  }
});

test("ordinary members can edit but cannot delete another member's document; denied saves retain drafts", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const owner = await createTestApi();
  const ws = (await owner.getWorkspaces())[0]!;
  const member = new TestApiClient();
  const email = `docs-member-${Date.now()}@multica.ai`;
  await member.login(email, "Document member");
  await member.markUserOnboarded();
  const memberId = await owner.addMemberByEmail(email);
  member.setWorkspaceSlug(ws.slug);
  member.setWorkspaceId(ws.id);
  const project = await owner.createProject("Permission verification");
  try {
    const doc = await owner.createProjectDocument(project.id, {
      title: "Shared guideline",
      content: "Members can edit.",
    });
    await signIn(page, member);
    await page.goto(
      `/${ws.slug}/projects/${project.id}?tab=docs&doc=${doc.id}`,
    );
    await page.getByRole("button", { name: "More document actions" }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Delete document" }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    await page.getByRole("button", { name: "Source", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Markdown source" })
      .fill("A member's edit");
    await page.keyboard.press("ControlOrMeta+s");
    await expect
      .poll(
        async () =>
          (await owner.getProjectDocument(project.id, doc.id)).content,
      )
      .toBe("A member's edit");
    await page.route(
      `**/api/projects/${project.id}/documents/${doc.id}`,
      async (route) => {
        if (route.request().method() === "PATCH")
          await route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({ error: "Forbidden" }),
          });
        else await route.continue();
      },
    );
    await page
      .getByRole("textbox", { name: "Markdown source" })
      .fill("Keep my denied draft");
    await page.keyboard.press("ControlOrMeta+s");
    await expect(
      page.getByRole("alert", { name: "Local draft retained" }),
    ).toContainText("permission to save");
    await expect(
      page.getByRole("textbox", { name: "Markdown source" }),
    ).toHaveValue("Keep my denied draft");
  } finally {
    await owner.cleanup();
    await owner.removeMember(memberId);
  }
});
