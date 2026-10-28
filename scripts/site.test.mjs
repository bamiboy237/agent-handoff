import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { renderWatchPage } from "../remote/watch-page.mjs";
import { buildSite } from "./build-site.mjs";
import { serveSite } from "./site-preview.mjs";
import { session } from "./site-session.mjs";

const browserName = process.env.WATCH_BROWSER || "chromium";
const screenshotDir = process.env.SITE_SCREENSHOT_DIR;

async function setup(t) {
  await buildSite();
  const server = serveSite({ base: "/agent-handoff/" });
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.ok(["chromium", "webkit"].includes(browserName));
  const browser = await ({ chromium, webkit })[browserName].launch();
  t.after(() => browser.close());
  return { browser, url: `http://127.0.0.1:${server.address().port}/agent-handoff/` };
}

async function freeze(page) {
  await page.clock.install({ time: new Date("2026-06-01T10:00:00Z") });
  await page.clock.pauseAt(new Date("2026-06-01T10:00:01Z"));
}

async function capture(page, name, options = {}) {
  if (!screenshotDir) return;
  await mkdir(screenshotDir, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(screenshotDir, name + ".png"), ...options });
}

test("site build shares the viewer and escapes embedded session data", async () => {
  await buildSite();
  const built = await readFile(new URL("../site/preview.html", import.meta.url), "utf8");
  const live = renderWatchPage({ agent: "claude" });
  assert.equal(built.match(/<style>([\s\S]*?)<\/style>/)[1], live.match(/<style>([\s\S]*?)<\/style>/)[1]);
  assert.ok(live.includes('new EventSource("/_handoff/events")'));
  assert.ok(!built.includes('new EventSource("/_handoff/events")'));
  const escaped = renderWatchPage({ agent: "agent <img src=x>", data: { text: "</script><script>alert(1)</script>" } });
  assert.equal(escaped.match(/<\/script>/g).length, 1);
  assert.ok(escaped.includes("\\u003c/script>"));
  assert.ok(!escaped.includes("<img src=x"));
  const tools = session.timeline.flatMap((step) => step.entries).filter((item) => item.kind === "tool");
  const states = new Map(tools.map((item) => [item.id, item.state]));
  assert.equal(states.size, 9);
  assert.deepEqual([...states].filter(([, state]) => state === "error").map(([id]) => id), ["reproduce", "rollback-check"]);
  assert.ok(![...states.values()].includes("running"), "every started tool receives a result");
  assert.ok(session.timeline.reduce((sum, step) => sum + step.after, 0) > 30_000, "the session unfolds over time");
  const html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
  assert.ok(!/class="steps"|class="questions"|aria-hidden="true">0[123]/.test(html), "no numbered walkthrough");
  assert.ok(!/synthetic|simulation|not a live|demo only/i.test(html), "page copy stays focused on the product");
});

test(`engineering session streams, pauses and answers follow-ups (${browserName})`, { timeout: 60_000 }, async (t) => {
  const { browser, url } = await setup(t);
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await freeze(page);
  await page.goto(url + "preview.html");
  await page.clock.runFor(20);
  assert.equal(await page.locator("body").getAttribute("data-state"), "running");
  assert.equal(await page.locator(".tool").count(), 1, "the transcript is not dumped in one batch");
  assert.equal(await page.locator("#go").getAttribute("data-mode"), "working");
  await capture(page, "landing-live-start");
  await page.locator("#text").fill("Check rollback and signature validation.");
  assert.equal(await page.locator("#go").getAttribute("data-mode"), "send");
  await page.clock.runFor(10_000);
  assert.equal(await page.locator('.tool[data-id="reproduce"]').getAttribute("data-state"), "error");
  assert.match(await page.locator('.tool[data-id="reproduce"] .res').textContent(), /Received invoice count: 2/);
  assert.equal(await page.locator("#text").inputValue(), "Check rollback and signature validation.");
  await capture(page, "landing-live-failure");
  await page.locator("#text").fill("Check the signature before writing.");
  await page.getByRole("button", { name: "Send message", exact: true }).tap();
  assert.equal(await page.locator(".you").count(), 2);
  assert.equal(await page.locator(".you.pending").count(), 0);
  assert.equal(await page.locator('[data-id="reply-1-follow-signature"]').count(), 0, "a follow-up waits for the current task");

  await page.evaluate(() => window.postMessage({ type: "handoff-preview-active", active: false }, location.origin));
  await page.waitForFunction(() => document.body.dataset.previewActive === "false");
  const paused = await page.locator("#feed").textContent();
  await page.clock.runFor(20_000);
  assert.equal(await page.locator("#feed").textContent(), paused, "offscreen playback does no work");
  await page.evaluate(() => window.postMessage({ type: "handoff-preview-active", active: true }, location.origin));
  await page.waitForFunction(() => document.body.dataset.previewActive === "true");
  await page.clock.runFor(60_000);
  assert.equal(await page.locator("body").getAttribute("data-state"), "completed");
  assert.equal(await page.locator(".tool").count(), 10);
  assert.equal(await page.locator('.tool[data-state="running"]').count(), 0);
  assert.match(await page.locator('.tool[data-id="rollback-check"] .res').textContent(), /5 passed \| 2 failed/);
  assert.match(await page.locator('.tool[data-id="atomic-write"] .diff').textContent(), /db.transaction/);
  assert.match(await page.locator('.tool[data-id="integration-green"] .res').textContent(), /7 passed/);
  assert.match(await page.locator("#feed").textContent(), /Typecheck and lint pass/);
  assert.match(await page.locator('[data-id="reply-1-follow-signature"] .res').textContent(), /HTTP 400/);
  await page.locator("#text").fill("");
  await capture(page, "landing-live-completed");

  const prompt = "Check rollback again.\nKeep the outbox write in the transaction.";
  await page.locator("#text").fill(prompt);
  await page.getByRole("button", { name: "Send message", exact: true }).tap();
  assert.equal(await page.locator(".you").last().textContent(), prompt);
  assert.equal(await page.locator(".you.pending").count(), 0);
  assert.equal(await page.locator("#go").getAttribute("data-mode"), "working");
  await page.clock.runFor(6000);
  assert.match(await page.locator('.tool[data-id="reply-2-follow-retry"] .res').textContent(), /After rollback: 0 receipts, 0 invoices, 0 outbox entries/);
  assert.match(await page.locator(".prose").last().textContent(), /one invoice and one outbox entry/);
  assert.equal(await page.locator("body").getAttribute("data-state"), "completed");
  await page.locator("#text").fill("What happens with an invalid signature?");
  await page.getByRole("button", { name: "Send message", exact: true }).tap();
  await page.clock.runFor(6000);
  assert.match(await page.locator('.tool[data-id="reply-3-follow-signature"] .res').textContent(), /HTTP 400\nDatabase writes: 0/);
  assert.equal(await page.locator(".you").count(), 4);
  await page.locator("#text").fill("x".repeat(16_001));
  await page.getByRole("button", { name: "Send message", exact: true }).tap();
  assert.equal(await page.locator("#hint").textContent(), "Not sent: The message is too long.");
  assert.equal(await page.locator(".you").count(), 4);
  assert.equal(await page.locator(".you.pending").count(), 0);
  assert.deepEqual(errors, []);
});

test(`landing page, controls and mobile layout (${browserName})`, { timeout: 90_000 }, async (t) => {
  const { browser, url } = await setup(t);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1280 }, deviceScaleFactor: 1, reducedMotion: "reduce",
    ...(browserName === "chromium" ? { permissions: ["clipboard-read", "clipboard-write"] } : {}),
  });
  const page = await context.newPage();
  const errors = [], failures = [], requests = [];
  const track = (page) => {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => { if (response.status() >= 400) failures.push(response.url()); });
    page.on("request", (request) => requests.push(request.url()));
  };
  track(page);
  await freeze(page);
  await page.goto(url);
  await page.clock.runFor(100);
  const app = page.frameLocator("#app-preview");
  assert.equal(await app.locator("#title").textContent(), session.title);
  assert.equal(await app.locator(".tool").count(), 1);
  await page.getByRole("button", { name: "Checks", exact: true }).click();
  await app.locator('body[data-state="completed"]').waitFor();
  assert.match(await app.locator('.tool[data-id="integration-green"] .res').textContent(), /7 passed/);
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await app.locator('.tool[data-id="atomic-write"] .diff').waitFor({ state: "visible" });
  assert.ok(await app.locator('.tool[data-id="atomic-write"] .dl.add').first().evaluate((line) => {
    const diff = line.closest(".diff").getBoundingClientRect();
    const rect = line.getBoundingClientRect();
    return rect.top >= diff.top && rect.bottom <= diff.bottom;
  }), "the change view opens on the new code");
  assert.equal(await page.getByRole("button", { name: "Changes", exact: true }).getAttribute("aria-pressed"), "true");
  await app.locator("#text").fill("Keep this draft.");
  await app.getByRole("button", { name: "Expand composer" }).click();
  assert.equal(await app.locator("#expand").getAttribute("aria-expanded"), "true");
  await app.locator("#text").press("Escape");
  assert.equal(await app.locator("#text").inputValue(), "Keep this draft.");
  const reset = page.waitForEvent("framenavigated", (frame) => frame.url().includes("/preview.html"));
  await page.getByRole("button", { name: "Reset viewer" }).click();
  await (await reset).waitForLoadState("load");
  await page.clock.runFor(100);
  assert.equal(await app.locator("body").getAttribute("data-state"), "running");
  assert.equal(await app.locator(".you").count(), 1);
  assert.equal(await app.locator(".tool").count(), 1);
  assert.equal(await app.locator("#text").inputValue(), "");
  await page.getByRole("heading", { name: "Install", exact: true }).scrollIntoViewIfNeeded();
  await page.clock.runFor(100);
  await app.locator('body[data-preview-active="false"]').waitFor();
  const paused = await app.locator("#feed").textContent();
  await page.clock.runFor(10_000);
  assert.equal(await app.locator("#feed").textContent(), paused);
  await page.locator("#app-preview").scrollIntoViewIfNeeded();
  await page.clock.runFor(100);
  await app.locator('body[data-preview-active="true"]').waitFor();
  await page.clock.runFor(5000);
  assert.notEqual(await app.locator("#feed").textContent(), paused);

  await page.getByRole("button", { name: "Copy install command" }).click();
  await page.waitForFunction(() => document.querySelector("[data-copy-status]").textContent !== "");
  if (browserName === "chromium") assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "npx github:bamiboy237/agent-handoff setup");
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("Clipboard blocked"); }; });
  await page.getByRole("button", { name: "Copy install command" }).click();
  await page.waitForFunction(() => document.querySelector("[data-copy-status]").textContent.startsWith("Command selected"));
  assert.equal(await page.evaluate(() => getSelection().toString()), "npx github:bamiboy237/agent-handoff setup");
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Skip to content" }).focus();
  assert.equal(await page.locator(".skip-link").evaluate((node) => getComputedStyle(node).outlineStyle), "solid");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement.id), "main");

  for (const viewport of [
    { width: 320, height: 568 }, { width: 390, height: 844 }, { width: 768, height: 1024 },
    { width: 844, height: 390 }, { width: 1440, height: 1280 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(url);
    await page.clock.runFor(100);
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await app.locator('.tool[data-id="atomic-write"] .diff').waitFor({ state: "visible" });
    await page.evaluate(() => document.fonts.ready);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `page fits ${viewport.width}px`);
    assert.ok(await app.locator("body").evaluate(() => document.documentElement.scrollWidth <= innerWidth), `viewer fits ${viewport.width}px`);
    assert.equal(await app.locator("#text").evaluate((node) => getComputedStyle(node).fontSize), "16px");
    const small = await page.locator("a, button").evaluateAll((nodes) => nodes.filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width && rect.height && (rect.width < 44 || rect.height < 44);
    }).map((node) => node.textContent.trim()));
    assert.deepEqual(small, []);
    await page.locator(".phone-shot img").scrollIntoViewIfNeeded();
    await page.locator(".phone-shot img").evaluate((image) => image.decode());
  }

  const mobilePage = await browser.newPage({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, reducedMotion: "reduce",
  });
  track(mobilePage);
  await freeze(mobilePage);
  await mobilePage.goto(url);
  await mobilePage.clock.runFor(100);
  const mobileApp = mobilePage.frameLocator("#app-preview");
  await mobilePage.getByRole("button", { name: "Checks", exact: true }).tap();
  await mobileApp.locator('body[data-state="completed"]').waitFor();
  assert.equal(await mobilePage.evaluate(() => matchMedia("(pointer: coarse)").matches), true);
  await mobileApp.locator("#text").fill("Check retry rollback.");
  await mobileApp.locator("#text").press("Enter");
  assert.match(await mobileApp.locator("#text").inputValue(), /\n$/);
  await mobileApp.getByRole("button", { name: "Send message", exact: true }).tap();
  await mobilePage.clock.runFor(6000);
  assert.match(await mobileApp.locator(".prose").last().textContent(), /one invoice and one outbox entry/);
  assert.equal(await mobileApp.locator(".you.pending").count(), 0);
  assert.ok(!requests.some((request) => request.includes("/_handoff/")));
  assert.ok(!requests.some((request) => /sounds\/|demo\.js/.test(request)));
  assert.deepEqual(failures, []);
  assert.deepEqual(errors, []);

  if (screenshotDir) {
    await mobilePage.goto(url + "preview.html?view=changes");
    await mobilePage.clock.runFor(100);
    await mobilePage.locator('.tool[data-id="atomic-write"] .diff').waitFor({ state: "visible" });
    await mobilePage.screenshot({ path: fileURLToPath(new URL("../site/assets/viewer-mobile.png", import.meta.url)) });
    await capture(mobilePage, "landing-app-mobile");
    await page.goto(url);
    await page.clock.runFor(100);
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await app.locator('.tool[data-id="atomic-write"] .diff').waitFor({ state: "visible" });
    await page.evaluate(() => scrollTo(0, 0));
    await capture(page, "landing-desktop", { fullPage: true });
    await capture(page, "landing-desktop-preview");
    await mobilePage.goto(url);
    await mobilePage.clock.runFor(100);
    await mobilePage.getByRole("button", { name: "Changes", exact: true }).tap();
    await mobileApp.locator('.tool[data-id="atomic-write"] .diff').waitFor({ state: "visible" });
    await mobilePage.evaluate(() => scrollTo(0, 0));
    await capture(mobilePage, "landing-mobile", { fullPage: true });
    await capture(mobilePage, "landing-mobile-first");
    const feature = mobilePage.locator(".mobile-feature");
    const height = await feature.evaluate((node) => Math.ceil(node.getBoundingClientRect().height));
    await mobilePage.setViewportSize({ width: 390, height: height + 160 });
    await feature.evaluate((node) => window.scrollTo(0, node.getBoundingClientRect().top + scrollY - 80));
    await feature.screenshot({ path: join(screenshotDir, "landing-mobile-viewer.png") });
  }
});

test(`preview progresses with the real browser clock (${browserName})`, { timeout: 30_000 }, async (t) => {
  const { browser, url } = await setup(t);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1280 }, reducedMotion: "reduce" });
  await page.goto(url);
  const app = page.frameLocator("#app-preview");
  await app.locator('body[data-state="running"]').waitFor();
  await page.locator("#app-preview").scrollIntoViewIfNeeded();
  assert.equal(await app.locator(".tool").count(), 1);
  await app.locator('.tool[data-id="reproduce"][data-state="error"]').waitFor({ timeout: 20_000 });
  await app.locator('.tool[data-id="migration"] .diff').waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await app.locator(".tool").count(), 3);
  assert.equal(await app.locator("body").getAttribute("data-state"), "running");
  if (screenshotDir) await page.locator(".workspace").screenshot({ path: join(screenshotDir, "landing-live-running.png") });
});
