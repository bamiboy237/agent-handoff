// Exercises the real watch server, SSE parser and browser UI without a sandbox.
// Run `npx playwright install chromium` once, then `npm run test:watch`.
// Set WATCH_SCREENSHOT_DIR to also capture the three review screenshots.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { chromium } from "playwright";

const message = (text) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
const call = (id, name, input) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id, content) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
const user = (text) => `2026-06-01T10:00:00Z [run] message: ${text}`;
const answer = [
  "The viewer now keeps your place when new output arrives. It only follows the agent when you're already at the bottom.",
  "## Keep the conversation in view",
  "The transcript and composer have separate space, so longer messages don't cover the agent's response.",
  "- **Read at your own pace.** Scroll back without being pulled to the latest output.\n- **Pick up where you left off.** Tap the down arrow to follow the agent again.",
  "```js\nconst follow = () => {\n  if (pinned) scrollToLatest();\n};\n```",
  "The same behavior applies to **Claude Code**, **Codex**, and **Pi**. OpenCode still opens its own app.",
].join("\n\n");
const fixture = [
  user("Keep the mobile viewer easy to follow while the agent is working."),
  message("I'll separate the transcript from the composer and keep the controls out of the way."),
  call("read-1", "Read", { file_path: "/workspace/remote/watch.mjs" }),
  result("read-1", "The transcript scrolls inside the session panel."),
  call("edit-1", "Edit", { file_path: "/workspace/remote/watch.mjs", old_string: "scrollToLatest();", new_string: "if (pinned) scrollToLatest();" }),
  result("edit-1", "Updated remote/watch.mjs"),
  call("run-1", "Bash", { command: "npm run typecheck" }),
  result("run-1", "> agent-handoff@0.2.0 typecheck\n> tsc -p tsconfig.json --noEmit\n\nNo type errors."),
  message(answer),
];

test("watch viewer: mobile, desktop and live interactions", { timeout: 120_000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "watch-ui-"));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const origin = `http://localhost:${port}`;
  // A test-only value, not a real watch credential.
  const key = "watch-ui-test";
  await Promise.all([
    writeFile(join(home, "runner.log"), fixture.join("\n") + "\n"),
    writeFile(join(home, "state"), "running"),
    writeFile(join(home, "title.txt"), "Keep the mobile viewer in sync"),
  ]);
  const startServer = () => spawn(process.execPath, ["remote/watch.mjs"], {
    env: { ...process.env, HANDOFF_HOME: home, WATCH_PORT: String(port), WATCH_KEY: key, TARGET_AGENT: "claude", WORKDIR: "/workspace" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let server = startServer();
  let serverErrors = "";
  server.stderr.on("data", (data) => { serverErrors += data; });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill();
      await once(server, "exit");
    }
    await rm(home, { recursive: true, force: true });
  });
  for (let tries = 0; ; tries++) {
    try { if ((await fetch(`${origin}/health`)).ok) break; } catch {}
    assert.ok(tries < 100, `Watch server did not start: ${serverErrors}`);
    await delay(50);
  }
  assert.equal((await fetch(origin)).status, 403);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?key=${key}`);
  await page.waitForFunction(() => document.querySelectorAll(".prose").length === 2);
  await page.evaluate(() => document.fonts.ready);
  assert.equal(new URL(page.url()).search, "", "key is removed from address");
  assert.equal(await page.locator("#title").textContent(), "Keep the mobile viewer in sync");
  assert.equal(await page.locator("#state").textContent(), "Working");
  assert.equal(await page.locator(".gtrig").textContent(), "Used 3 tools");
  assert.ok(await page.locator("#go").isDisabled());

  const screenshot = async (name) => {
    if (!process.env.WATCH_SCREENSHOT_DIR) return;
    const directory = resolve(process.env.WATCH_SCREENSHOT_DIR);
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: join(directory, `${name}.png`) });
  };
  const layout = async () => {
    const bounds = await page.evaluate(() => {
      const footer = document.querySelector("footer").getBoundingClientRect();
      const scroll = document.querySelector(".scroll").getBoundingClientRect();
      return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, footerBottom: footer.bottom, footerTop: footer.top, scrollBottom: scroll.bottom };
    });
    assert.equal(bounds.documentWidth, bounds.width, "no horizontal page overflow");
    assert.ok(bounds.footerBottom <= bounds.height + 1, "composer fits viewport");
    assert.ok(bounds.scrollBottom <= bounds.footerTop + 1, "composer never covers transcript");
  };
  await layout();
  await page.locator("#scroll").evaluate((node) => { node.scrollTop = 0; });
  await page.waitForFunction(() => document.querySelector("#latest").classList.contains("show"));
  await screenshot("watch-zed-mobile");

  await page.locator(".gtrig").click();
  assert.equal(await page.locator(".gtrig").getAttribute("aria-expanded"), "true");
  await page.locator(".tool").nth(1).locator(".trig").click();
  assert.ok(await page.locator(".diff").isVisible());
  await page.locator(".tool").nth(2).locator(".trig").click();
  assert.ok(await page.locator(".shell .res").isVisible());
  await screenshot("watch-zed-tools");
  await page.locator(".gtrig").click();

  // New SSE content must not pull a reader away from older output.
  await page.locator("#scroll").evaluate((node) => { node.scrollTop = 0; });
  await appendFile(join(home, "runner.log"), message("The latest changes are ready for review.") + "\n");
  await page.waitForFunction(() => document.querySelectorAll(".prose").length === 3);
  assert.equal(await page.locator("#scroll").evaluate((node) => node.scrollTop), 0);
  await page.locator("#latest").click();
  await page.waitForFunction(() => {
    const node = document.querySelector("#scroll");
    return node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
  });
  await page.locator(".copy").last().click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "The latest changes are ready for review.");
  await page.locator("#text").fill("Please also check the narrow layout.");
  await page.locator("#expand").click();
  assert.equal(await page.locator("#expand").getAttribute("aria-expanded"), "true");
  assert.ok(!(await page.locator("#scroll").isVisible()));
  await page.locator("#text").press("Escape");
  assert.equal(await page.locator("#text").inputValue(), "Please also check the narrow layout.");

  // Error feedback preserves the draft, then the actual POST reaches the inbox.
  await page.route("**/_handoff/message", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Try again."}' }));
  await page.locator("#go").click();
  await page.waitForFunction(() => document.querySelector("#hint").textContent.includes("Not sent"));
  assert.equal(await page.locator("#text").inputValue(), "Please also check the narrow layout.");
  assert.equal(await page.locator(".you.pending").count(), 0);
  await page.unroute("**/_handoff/message");
  await page.locator("#expand").click();
  await page.locator("#go").click();
  await page.waitForFunction(() => document.querySelector("#text").value === "");
  const inbox = await readdir(join(home, "inbox"));
  assert.equal(await readFile(join(home, "inbox", inbox[0]), "utf8"), "Please also check the narrow layout.");
  assert.equal(await page.locator("#expand").getAttribute("aria-expanded"), "false");

  // PR and terminal states still arrive through the server's status events.
  await writeFile(join(home, "pr-url"), "https://github.com/example/project/pull/42");
  await writeFile(join(home, "state"), "completed");
  await page.waitForFunction(() => document.body.dataset.state === "completed");
  assert.equal(await page.locator("#state").textContent(), "Done");
  assert.equal(await page.locator("#pr").getAttribute("href"), "https://github.com/example/project/pull/42");
  assert.ok(await page.locator("#indicator .ok").isVisible());
  await writeFile(join(home, "state"), "failed:agent");
  await page.waitForFunction(() => document.body.dataset.state === "failed");
  assert.ok(await page.locator("#indicator .bad").isVisible());
  await writeFile(join(home, "state"), "completed");
  await page.waitForFunction(() => document.body.dataset.state === "completed");

  for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport);
    await layout();
  }
  await page.locator("#scroll").evaluate((node) => { node.scrollTop = 0; });
  await screenshot("watch-zed-desktop");

  // Close the real SSE connection; browser offline emulation doesn't reliably
  // close already-established event streams.
  server.kill();
  await once(server, "exit");
  await page.waitForFunction(() => document.body.classList.contains("offline"));
  assert.equal(await page.locator("#hint").textContent(), "Reconnecting…");
  server = startServer();
  server.stderr.on("data", (data) => { serverErrors += data; });
  await page.waitForFunction(() => !document.body.classList.contains("offline"));
  await page.waitForFunction(() => document.querySelectorAll(".prose").length === 3);
  assert.equal(await page.locator(".you.pending").count(), 0, "reconnect replays without duplicate messages");
  assert.deepEqual(errors, []);
  assert.equal(serverErrors, "");
});
