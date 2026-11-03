import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { createTestApi } from "./helpers";

test("opens an actual long virtualized issue at its latest content", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const api = await createTestApi(),
    workspace = (await api.getWorkspaces())[0]!;
  try {
    const issue = await api.createIssue("Latest landing canonical issue");
    for (let start = 0; start < 80; start += 8)
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          api.createComment(
            issue.id,
            `Timeline entry ${start + i + 1}\n\n${"Complete task context and evidence. ".repeat(25)}`,
          ),
        ),
      );
    const latest = await api.createComment(
      issue.id,
      "Latest stable sentinel: complete task context.",
    );
    await page.addInitScript((token) => {
      localStorage.setItem("multica_token", token!);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, api.getToken());
    await page.goto(`/${workspace.slug}/issues/${issue.id}`);
    const scroller = page.locator(`[data-tab-scroll-root="main:${issue.id}"]`);
    await expect(scroller).toBeVisible();
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeGreaterThan(1000);
    await expect
      .poll(
        () =>
          scroller.evaluate(
            (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
          ),
        { timeout: 8000 },
      )
      .toBeLessThan(40);
    const lastComment = page.locator(`#comment-${latest.id}`);
    await expect(lastComment).toContainText(
      "Latest stable sentinel: complete task context.",
    );
    await expect(lastComment).toBeInViewport();
    const firstVisible = Date.now();
    let previousHeight = 0,
      stableSamples = 0;
    await expect
      .poll(
        async () => {
          const metrics = await scroller.evaluate((el) => ({
            height: el.scrollHeight,
            distance: el.scrollHeight - el.clientHeight - el.scrollTop,
          }));
          stableSamples =
            metrics.height === previousHeight && metrics.distance < 40
              ? stableSamples + 1
              : 0;
          previousHeight = metrics.height;
          return Date.now() - firstVisible >= 2500 && stableSamples >= 3;
        },
        { timeout: 15000, intervals: [250] },
      )
      .toBe(true);
    await expect(lastComment).toBeInViewport();
    await page.screenshot({
      path: info.outputPath("issue-latest.png"),
      animations: "disabled",
      style: "nextjs-portal {display:none!important}",
    });
    await writeFile(
      info.outputPath("issue-latest-metrics.json"),
      JSON.stringify(
        await scroller.evaluate((el) => ({
          top: el.scrollTop,
          height: el.scrollHeight,
          viewport: el.clientHeight,
          windowTop: window.scrollY,
        })),
        null,
        2,
      ),
    );
  } finally {
    await api.cleanup();
  }
});

test("keeps explicit comment targets and reader scroll while late images and new comments arrive", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const api = await createTestApi(),
    workspace = (await api.getWorkspaces())[0]!;
  try {
    const issue = await api.createIssue("Late image and anchor canonical");
    const comments = [];
    for (let i = 0; i < 18; i++)
      comments.push(
        await api.createComment(
          issue.id,
          `Readable context ${i}\n\n${"Keep this paragraph visible when reading. ".repeat(20)}`,
        ),
      );
    await api.createComment(
      issue.id,
      "![Delayed initial evidence](https://example.test/initial-late-evidence.svg)",
    );
    await api.createComment(
      issue.id,
      "Latest after the delayed initial image.",
    );
    await page.route(
      "https://example.test/initial-late-evidence.svg",
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 3500));
        await route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1600"><rect width="600" height="1600" fill="#aaccff"/></svg>',
        });
      },
    );
    await page.addInitScript((token) => {
      localStorage.setItem("multica_token", token!);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, api.getToken());
    const url = `/${workspace.slug}/issues/${issue.id}`;
    await page.goto(url);
    const scroller = page.locator(`[data-tab-scroll-root="main:${issue.id}"]`);
    await expect(scroller).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByRole("img", { name: "Delayed initial evidence" }),
    ).toBeVisible({ timeout: 15000 });
    await expect
      .poll(() =>
        page
          .getByRole("img", { name: "Delayed initial evidence" })
          .evaluate(
            (img: HTMLImageElement) => img.complete && img.naturalHeight > 1000,
          ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        scroller.evaluate(
          (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
        ),
      )
      .toBeLessThan(40);
    await page.goto(`${url}#comment-${comments[2]!.id}`);
    await expect(page.locator(`#comment-${comments[2]!.id}`)).toBeInViewport();
    expect(
      await scroller.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      ),
    ).toBeGreaterThan(1000);
    await page.goto(url);
    await expect
      .poll(() =>
        scroller.evaluate(
          (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
        ),
      )
      .toBeLessThan(40);
    await scroller.hover();
    await page.mouse.wheel(0, -650);
    await expect
      .poll(() =>
        scroller.evaluate(
          (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
        ),
      )
      .toBeGreaterThan(250);
    const before = await scroller.evaluate((el) => ({
      top: el.scrollTop,
      height: el.scrollHeight,
    }));
    await api.createComment(
      issue.id,
      "New update while the reader is above the latest.\n\n" +
        "New evidence. ".repeat(80),
    );
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight))
      .toBeGreaterThan(before.height);
    expect(
      await scroller.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      ),
    ).toBeGreaterThan(250);
    expect(
      Math.abs((await scroller.evaluate((el) => el.scrollTop)) - before.top),
    ).toBeLessThan(100);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({ path: info.outputPath("issue-reader-kept.png") });
  } finally {
    await api.cleanup();
  }
});

test("initializes a different issue reached through a real in-app content link", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const api = await createTestApi(),
    workspace = (await api.getWorkspaces())[0]!;
  try {
    const second = await api.createIssue("Second ordinary reading issue");
    const first = await api.createIssue("First ordinary reading issue", {
      description: `[Open the next reading issue](/${workspace.slug}/issues/${second.id})`,
    });
    for (const issue of [first, second])
      for (let i = 0; i < 16; i++)
        await api.createComment(
          issue.id,
          `${issue.title} · ${i}\n\n${"Detailed ordinary task context. ".repeat(30)}`,
        );
    await page.addInitScript((token) => {
      localStorage.setItem("multica_token", token!);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, api.getToken());
    await page.goto(`/${workspace.slug}/issues/${first.id}`);
    const initial = page.locator(`[data-tab-scroll-root="main:${first.id}"]`);
    await expect
      .poll(() =>
        initial.evaluate(
          (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
        ),
      )
      .toBeLessThan(40);
    await page
      .getByRole("link", { name: "Open the next reading issue", exact: true })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/issues/(${second.id}|${second.identifier})`),
    );
    const next = page.locator(`[data-tab-scroll-root="main:${second.id}"]`);
    await expect(next).toBeVisible();
    await expect
      .poll(() =>
        next.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
      )
      .toBeLessThan(40);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  } finally {
    await api.cleanup();
  }
});
