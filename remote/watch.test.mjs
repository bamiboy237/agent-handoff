// Exercises the real watch server, SSE parser and browser UI without a sandbox.
// Run `npx playwright install chromium` once, then `npm run test:watch`.
// Set WATCH_SCREENSHOT_DIR to also capture the review screenshots.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { chromium, webkit } from "playwright";
import { fixture, message, call, user } from "../scripts/watch-fixture.mjs";

const browserName = process.env.WATCH_BROWSER || "chromium";
assert.ok(["chromium", "webkit"].includes(browserName), "WATCH_BROWSER must be chromium or webkit");

test(`watch viewer: mobile, desktop and live interactions (${browserName})`, { timeout: 120_000 }, async (t) => {
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
    writeFile(join(home, "state"), "warming"),
    writeFile(join(home, "title.txt"), "Keep the mobile viewer in sync"),
  ]);
  const startServer = () => spawn(process.execPath, ["remote/watch.mjs"], {
    env: { ...process.env, HANDOFF_HOME: home, WATCH_HOST: "127.0.0.1", WATCH_PORT: String(port), WATCH_KEY: key, TARGET_AGENT: "claude", WORKDIR: "/workspace" },
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
  const snapshot = async (cursor) => {
    const response = await fetch(`${origin}/_handoff/events`, { headers: { cookie: `handoff_key=${key}`, ...(cursor === undefined ? {} : { "last-event-id": cursor }) } });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let stream = "";
    try {
      while (!stream.includes("event: status\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        stream += decoder.decode(value, { stream: true });
      }
      return stream;
    } finally {
      await reader.cancel();
    }
  };
  const initialBytes = Buffer.byteLength(fixture.join("\n") + "\n");
  assert.match(await snapshot(), new RegExp(`id: ${initialBytes}\\nevent: log`), "cursor counts bytes through the last complete line");
  assert.doesNotMatch(await snapshot(String(initialBytes)), /event: log/, "current cursor gets no replay");
  assert.match(await snapshot("invalid"), /event: log/, "invalid cursor falls back to bounded backlog");
  assert.match(await snapshot(String(initialBytes + 1)), /id: \nevent: reset/, "a cursor past the log explicitly resets");
  const browser = await ({ chromium, webkit }[browserName]).launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    reducedMotion: "reduce", permissions: browserName === "chromium" ? ["clipboard-read", "clipboard-write"] : ["clipboard-read"],
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?key=${key}`);
  await page.waitForFunction(() => document.querySelectorAll(".prose").length === 2);
  await page.evaluate(() => document.fonts.ready);
  assert.equal(new URL(page.url()).search, "", "key is removed from address");
  assert.equal(await page.locator("#title").textContent(), "Keep the mobile viewer in sync");
  await page.waitForFunction(() => document.querySelector("#state").textContent === "Getting ready");
  assert.equal(await page.locator("#header .agent-mark").getAttribute("aria-label"), "Claude Code");
  assert.equal(await page.locator("#header .agent-mark").textContent(), "", "visible header uses the agent mark, not the name");
  assert.ok((await page.locator("#header .agent-mark").boundingBox()).width <= 20);
  assert.equal(await page.locator("#send .agent-label, #send .run-state").count(), 0, "composer has no identity/status row");
  assert.equal(await page.locator("#state").getAttribute("class"), "sr", "run state stays available to screen readers without visible text");
  assert.equal(await page.locator("#go").getAttribute("data-mode"), "send", "idle control shows the paper plane");
  assert.equal(await page.locator(".gtrig").textContent(), "3 tool calls");
  assert.equal(await page.locator(".private, [data-icon='lock'], .agent-label svg").count(), 0, "no decorative lock or agent glyph");
  assert.ok(await page.locator("#go").isDisabled());
  assert.equal(await page.locator("#go").evaluate((node) => getComputedStyle(node).color), "rgb(102, 102, 102)", "disabled send stays dim");
  assert.equal(await page.locator("#title").evaluate((node) => getComputedStyle(node).fontWeight), "500", "task title carries the header hierarchy");
  assert.equal(await page.locator(".gtrig").evaluate((node) => getComputedStyle(node).borderTopWidth), "0px", "tool summary is a plain row, not a card");
  assert.equal(await page.locator(".gtrig").evaluate((node) => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)", "tool summary has no raised fill");
  assert.equal(await page.locator(".tool .sub").first().evaluate((node) => getComputedStyle(node).color), "rgb(160, 160, 160)", "tool paths stay readable as evidence");
  const served = await page.content();
  assert.ok(!served.includes("M2.08334 12.0833") && !served.includes("M6.6665 8.33325"), "unused icon artwork is not shipped");
  assert.ok(served.includes("#D97757"), "Claude mark uses the selected coral concept");
  assert.equal(await page.locator("#feed").getAttribute("aria-live"), null, "transcript is readable without announcing every tool update");
  assert.equal(await page.locator("#scroll").getAttribute("role"), "region");
  assert.match(await page.locator("#activity").textContent(), /2 agent responses/);
  await writeFile(join(home, "state"), "running");
  await page.waitForFunction(() => document.querySelector("#go").dataset.mode === "working");
  assert.equal(await page.locator("#go").getAttribute("aria-label"), "Agent working");
  assert.ok(await page.locator("#go").isDisabled(), "working icon is an indicator, not an unsupported stop button");
  assert.equal(await page.locator("#go svg").count(), 1, "working replaces send; it is not a second icon");
  assert.equal(await page.locator("#go circle").count(), 1);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  assert.deepEqual(await page.locator("#go svg").evaluate((node) => {
    const style = getComputedStyle(node);
    return { name: style.animationName, duration: style.animationDuration, easing: style.animationTimingFunction };
  }), { name: "working", duration: "1s", easing: "linear" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator("#go svg").evaluate((node) => getComputedStyle(node).animationName), "none", "reduced motion keeps a static working icon");
  assert.equal(await page.locator(".gtrig").evaluate((node) => getComputedStyle(node).touchAction), "manipulation");
  assert.equal(await page.locator("html").evaluate((node) => getComputedStyle(node).overscrollBehaviorY), "none");
  assert.equal(await page.locator(".prose").first().evaluate((node) => getComputedStyle(node).userSelect), "auto", "response text stays selectable");

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
      const transcript = document.querySelector("#scroll");
      return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, footerBottom: footer.bottom, footerTop: footer.top, scrollBottom: scroll.bottom, transcriptWidth: transcript.clientWidth, transcriptScrollWidth: transcript.scrollWidth };
    });
    assert.equal(bounds.documentWidth, bounds.width, "no horizontal page overflow");
    assert.equal(bounds.transcriptScrollWidth, bounds.transcriptWidth, "transcript never scrolls sideways");
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
  assert.equal(await page.locator(".shell .res").evaluate((node) => getComputedStyle(node).scrollbarWidth), "thin");
  assert.equal(await page.locator(".tool .sub").first().getAttribute("title"), "remote/watch.mjs");
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
  assert.equal(await page.locator("#go").getAttribute("data-mode"), "send", "typing replaces the working icon with the paper plane");
  assert.equal(await page.locator("#go").getAttribute("aria-label"), "Send message");
  assert.equal(await page.locator("#go circle").count(), 0);
  assert.ok(await page.locator("#go").isEnabled(), "a new message can be sent while the agent works");
  await page.locator("#text").fill("   ");
  assert.equal(await page.locator("#go").getAttribute("data-mode"), "working", "clearing a draft restores the working icon");
  await page.locator("#text").fill("Please also check the narrow layout.");
  assert.match(await page.locator("#send").evaluate((node) => getComputedStyle(node).boxShadow), /rgb\(162, 188, 255\)/, "composer has a contrasting focus bar");
  assert.equal(await page.locator("#go").evaluate((node) => getComputedStyle(node).color), "rgb(204, 204, 204)", "enabled send reads as active");
  await screenshot("watch-zed-draft");
  await page.locator("#expand").click();
  assert.equal(await page.locator("#expand").getAttribute("aria-expanded"), "true");
  assert.ok(!(await page.locator("#scroll").isVisible()));
  await page.locator("#text").press("Escape");
  assert.equal(await page.locator("#text").inputValue(), "Please also check the narrow layout.");

  // Error feedback preserves the draft, then the actual POST reaches the inbox.
  let sendingMode;
  await page.route("**/_handoff/message", async (route) => {
    sendingMode = await page.locator("#go").getAttribute("data-mode");
    await page.locator("#text").dispatchEvent("input");
    assert.ok(await page.locator("#go").isDisabled(), "editing during submission cannot enable a duplicate send");
    await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Try again."}' });
  });
  await page.locator("#go").click();
  await page.waitForFunction(() => document.querySelector("#hint").textContent.includes("Not sent"));
  assert.equal(sendingMode, "sending", "message submission shows progress until the request finishes");
  assert.equal(await page.locator("#go").getAttribute("data-mode"), "send", "failed send restores the paper plane and draft");
  assert.equal(await page.locator("#text").inputValue(), "Please also check the narrow layout.");
  assert.equal(await page.locator(".you.pending").count(), 0);
  await page.unroute("**/_handoff/message");
  await page.locator("#expand").click();
  await page.locator("#go").click();
  await page.waitForFunction(() => document.querySelector("#text").value === "");
  const inbox = await readdir(join(home, "inbox"));
  assert.equal(await readFile(join(home, "inbox", inbox[0]), "utf8"), "Please also check the narrow layout.");
  assert.equal(await page.locator("#expand").getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator("#activity").textContent(), "Message queued for the agent.");
  assert.equal(await page.locator("#go").getAttribute("data-mode"), "working", "sending clears the draft and returns to the agent's working icon");
  await appendFile(join(home, "runner.log"), user("Please also check the narrow layout.") + "\n");
  await page.waitForFunction(() => !document.querySelector(".you.pending"));

  // PR and terminal states still arrive through the server's status events.
  await writeFile(join(home, "pr-url"), "https://github.com/example/project/pull/42");
  await writeFile(join(home, "state"), "completed");
  await page.waitForFunction(() => document.body.dataset.state === "completed");
  assert.equal(await page.locator("#state").textContent(), "Done");
  assert.equal(await page.locator("#pr").getAttribute("href"), "https://github.com/example/project/pull/42");
  assert.equal(await page.locator("#go").getAttribute("data-mode"), "send", "completion returns to the normal paper plane");
  await writeFile(join(home, "state"), "failed:agent");
  await page.waitForFunction(() => document.body.dataset.state === "failed");
  assert.equal(await page.locator("#hint").textContent(), "The agent stopped with an error. Check its latest output.");
  assert.equal(await page.locator("#go").getAttribute("data-mode"), "send");
  await writeFile(join(home, "state"), "completed");
  await page.waitForFunction(() => document.body.dataset.state === "completed");

  for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport);
    await layout();
  }
  await page.locator("#scroll").evaluate((node) => { node.scrollTop = 0; });
  await screenshot("watch-zed-desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".gtrig").click();
  await page.locator("#text").fill("Keep this draft across a reconnect.");
  await page.locator("#scroll").evaluate((node) => { node.scrollTop = 120; });
  await page.waitForFunction(() => document.querySelector("#latest").classList.contains("show"));
  const readPosition = await page.locator("#scroll").evaluate((node) => node.scrollTop);
  const firstResponse = await page.locator(".prose").first().elementHandle();
  await page.evaluate(() => {
    window.removedEntries = 0;
    new MutationObserver((changes) => {
      window.removedEntries += changes.reduce((sum, change) => sum + change.removedNodes.length, 0);
    }).observe(document.querySelector("#feed"), { childList: true });
  });

  // The real EventSource reconnects with Last-Event-ID, preserving DOM and UI.
  let resumeRequest;
  page.on("request", (request) => {
    if (request.url().endsWith("/_handoff/events")) resumeRequest = request;
  });
  server.kill();
  await once(server, "exit");
  await page.waitForFunction(() => document.body.classList.contains("offline"));
  assert.equal(await page.locator("#hint").textContent(), "Reconnecting…");
  assert.equal(await page.locator(".prose").count(), 3, "history stays visible while offline");
  await appendFile(join(home, "runner.log"), message("Reconnected without losing your place. ✓") + "\n");
  server = startServer();
  server.stderr.on("data", (data) => { serverErrors += data; });
  await page.waitForFunction(() => !document.body.classList.contains("offline"));
  await page.waitForFunction(() => document.querySelectorAll(".prose").length === 4);
  assert.match((await resumeRequest.allHeaders())["last-event-id"], /^\d+$/, "browser sends its log byte cursor");
  assert.ok(await firstResponse.evaluate((node) => node.isConnected), "old response nodes are retained, not rebuilt");
  assert.equal(await page.evaluate(() => window.removedEntries), 0);
  assert.ok(Math.abs(await page.locator("#scroll").evaluate((node) => node.scrollTop) - readPosition) <= 1, "reading position survives reconnect");
  assert.equal(await page.locator(".gtrig").getAttribute("aria-expanded"), "true");
  assert.ok(await page.locator(".diff").isVisible(), "expanded tool detail survives reconnect");
  assert.equal(await page.locator("#text").inputValue(), "Keep this draft across a reconnect.");
  assert.equal(await page.locator("#text").evaluate((node) => node === document.activeElement), true, "reconnect does not move focus");
  assert.equal(await page.locator(".you").count(), 2, "no duplicate user messages");

  await page.locator("#latest").click();
  server.kill();
  await once(server, "exit");
  await page.waitForFunction(() => document.body.classList.contains("offline"));
  server = startServer();
  server.stderr.on("data", (data) => { serverErrors += data; });
  await page.waitForFunction(() => !document.body.classList.contains("offline"));
  assert.equal(await page.locator(".prose").count(), 4, "a quiet reconnect keeps history without needing a log event");
  await appendFile(join(home, "runner.log"), message("A second reconnect still follows when pinned.") + "\n");
  await page.waitForFunction(() => document.querySelectorAll(".prose").length === 5);
  await page.waitForFunction(() => {
    const node = document.querySelector("#scroll");
    return node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
  });
  assert.ok(await firstResponse.evaluate((node) => node.isConnected));

  // Truncation, unlike reconnect, explicitly resets history and its cursor.
  await writeFile(join(home, "runner.log"), message("A new log replaces the old transcript.") + "\n");
  await page.waitForFunction(() => document.querySelectorAll(".prose").length === 1);
  assert.match(await page.locator(".prose").textContent(), /A new log replaces/);
  assert.equal(await page.locator(".group").count(), 0);
  assert.equal(await page.locator("#text").inputValue(), "Keep this draft across a reconnect.");

  // Long content and every tool kind must still fit a narrow screen.
  const longPath = "src/" + "long-path-".repeat(24) + "日本語.ts";
  const tools = [
    ["Read", { file_path: longPath }], ["Edit", { file_path: longPath, old_string: "before", new_string: "after" }],
    ["Bash", { command: "npm run typecheck" }], ["Grep", { pattern: "long-pattern-".repeat(30) }],
    ["WebFetch", { url: "https://example.com/" + "path/".repeat(40) }], ["Task", { description: "Check the mobile layout" }],
    ["TodoWrite", { todos: [{ content: "Check the narrow layout", status: "in_progress" }] }], ["custom_tool", {}],
  ];
  await appendFile(join(home, "runner.log"), [
    message("A long token: " + "x".repeat(300)),
    ...tools.map(([name, input], index) => call("long-" + index, name, input)),
    "",
  ].join("\n"));
  await page.waitForFunction(() => document.querySelectorAll(".tool").length === 8);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.locator(".gtrig").click();
  await layout();
  assert.equal(await page.locator(".tool").count(), 8);
  assert.equal(await page.locator(".gtrig").textContent(), "8 tool calls", "summary stays compact while its count includes every tool");
  assert.equal(await page.locator(".gtrig svg").count(), 1, "only the disclosure chevron appears in the tool summary");
  assert.equal(await page.locator(".tool .sub").first().getAttribute("title"), longPath);
  assert.equal(await page.locator(".tool .label").first().evaluate((node) => getComputedStyle(node.querySelector("svg")).animationName), "none");
  assert.deepEqual(errors, []);
  assert.equal(serverErrors, "");
});
