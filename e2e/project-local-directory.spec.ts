import { test, expect } from "@playwright/test";
import { TestApiClient } from "./fixtures";

test("web picks a target-machine directory, edits its path, and unlinks after confirmation", async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const api = new TestApiClient();
  const run = `${Date.now()}-${process.pid}`;
  await api.login(`directory-${run}@localhost`, "Directory Owner");
  const workspace = await api.ensureWorkspace(
    "Multica Development",
    `directories-${run}`,
  );
  await api.markUserOnboarded();
  try {
    const runtimeId = await api.seedRuntime("Claude (Dev-Mac-Studio)", {
      daemonId: "directory-e2e-machine",
      capabilities: ["directory-browse-v1", "local-worktree-v1"],
    });
    await api.createTestAgent("Development Agent", runtimeId);
    const project = await api.createProject("Multica Web");
    // The browser/UI and resource writes use the real backend. This fixture
    // simulates only the target machine's directory replies; no real agent CLI
    // or host filesystem is accessed by this test.
    await page.route(
      `**/api/runtimes/${runtimeId}/directories`,
      async (route) => {
        const { operation, path } = route.request().postDataJSON();
        const response = await route.fetch();
        expect(response.status()).toBe(202);
        const request = await response.json();
        const entries =
          operation === "roots"
            ? [{ name: "workspace", path: "/Users/dev/workspace" }]
            : path === "/Users/dev/workspace"
              ? [
                  {
                    name: "multica-web",
                    path: "/Users/dev/workspace/multica-web",
                  },
                  {
                    name: "design-assets",
                    path: "/Users/dev/workspace/design-assets",
                  },
                ]
              : [];
        await api.completeDirectoryBrowse(runtimeId, request.id, {
          path: path ?? "",
          parent: path ? "/Users/dev/workspace" : "",
          entries,
          is_git_repo: true,
        });
        await route.fulfill({ response });
      },
    );
    await page.addInitScript((token) => {
      localStorage.setItem("multica_token", token!);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, api.getToken());
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/${workspace.slug}/projects/${project.id}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("button", { name: "Add local directory", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Add folder", exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      path: testInfo.outputPath("01-add-directory.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page
      .getByRole("button", { name: "Choose folder", exact: true })
      .click();
    await page.getByRole("button", { name: "workspace", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "multica-web", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("02-directory-picker.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page
      .getByRole("button", { name: "multica-web", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Use this folder", exact: true })
      .click();
    await expect(
      page.getByText("/Users/dev/workspace/multica-web", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("03-confirm-directory.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Add folder", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByText("/Users/dev/workspace/multica-web", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("/Users/dev/workspace/multica-web", { exact: true }).locator("..").getByText("Development Agent", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("04-project-page.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByText("/Users/dev/workspace/multica-web", { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await page
      .getByRole("button", { name: "Edit local directory", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Enter path manually", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Directory path", exact: true })
      .fill("./relative");
    await expect(
      page.getByRole("button", { name: "Save", exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      path: testInfo.outputPath("05-invalid-path.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page
      .getByRole("textbox", { name: "Directory path", exact: true })
      .fill("/Users/dev/workspace/design-assets");
    await expect(page.getByRole("textbox", { name: "Directory path", exact: true })).toHaveAttribute("aria-invalid", "false");
    await page.screenshot({
      path: testInfo.outputPath("06-edit-directory.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByText("/Users/dev/workspace/design-assets", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("07-unlink-directory.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(
      page.getByText("/Users/dev/workspace/design-assets", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Add local directory", exact: true }),
    ).toBeEnabled();
  } finally {
    await api.cleanup();
    await api.deleteWorkspace();
  }
});
