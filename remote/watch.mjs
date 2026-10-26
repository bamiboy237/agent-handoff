// The handoff's watch link, served from inside the sandbox. One stable URL:
//   OpenCode  each visit makes a fresh one-time pairing link, and every request
//             outside /_handoff/ is passed to OpenCode's server, so its own web
//             UI runs on this same address.
//   others    a live page of the agent's work, with a box for messages.
// runner.sh starts it. Every request needs the handoff's key: from ?key= on the
// first visit, then from a cookie. No dependencies, so any Node works.
import { execFile, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseLine } from "./transcript.mjs";

const HOME = process.env.HANDOFF_HOME;
const PORT = Number(process.env.WATCH_PORT);
const KEY = process.env.WATCH_KEY ?? "";
const AGENT = process.env.TARGET_AGENT ?? "";
const WORKDIR = process.env.WORKDIR ?? "";
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT || 49374);
const LOG = join(HOME, "runner.log");
const COOKIE = "handoff_key";
const BACKLOG_BYTES = 4_000_000; // how much earlier output a new viewer gets; agent events are verbose JSON
const LABELS = { opencode: "OpenCode", claude: "Claude Code", codex: "Codex", pi: "Pi" };
const label = LABELS[AGENT] ?? AGENT;

const read = (name) => {
  try {
    return readFileSync(join(HOME, name), "utf8").trim();
  } catch {
    return "";
  }
};

const size = (path) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

function readRange(path, start, end) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer;
  } finally {
    closeSync(fd);
  }
}

function authorized(req, url) {
  const cookies = Object.fromEntries(
    (req.headers.cookie ?? "").split(";").map((part) => part.trim().split("=").map(decodeURIComponent)),
  );
  const given = Buffer.from(url.searchParams.get("key") ?? cookies[COOKIE] ?? "");
  const expected = Buffer.from(KEY);
  return KEY.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
}

// OpenCode pairing links work once and expire in 5 minutes, so each visit makes
// one. The link points at this page's own public address.
function pairingLink() {
  const base = read("watch-url");
  if (!base) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      join(homedir(), ".opencode", "bin", "opencode"),
      ["pair", "--url", base],
      { timeout: 20_000, env: { ...process.env, NO_COLOR: "1" } },
      (_error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
        resolve(/https?:\/\/\S+\/auth\/connect\/\S+/.exec(output)?.[0]);
      },
    );
  });
}

// Sends the log in whole lines. The agent's JSON events go out as transcript
// items; any other line goes out as text for the page to sort.
function streamEvents(req, res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  const send = (event, data, id) => res.write(`${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // Byte offsets resume on whole-line boundaries, even after the server restarts.
  const cursor = req.headers["last-event-id"];
  const resume = /^\d+$/.test(cursor ?? "") && Number.isSafeInteger(Number(cursor));
  let offset = resume ? Number(cursor) : Math.max(0, size(LOG) - BACKLOG_BYTES);
  let midLine = !resume && offset > 0;
  let lastStatus = "";
  const tick = () => {
    const end = size(LOG);
    if (end < offset) {
      offset = 0;
      midLine = false;
      send("reset", null, "");
    }
    const chunk = end > offset ? readRange(LOG, offset, end) : Buffer.alloc(0);
    const cut = chunk.lastIndexOf(10);
    if (cut >= 0) {
      offset += cut + 1;
      const lines = chunk.subarray(0, cut).toString("utf8").split("\n");
      if (midLine) lines.shift();
      midLine = false;
      const entries = lines.flatMap((line) => parseLine(AGENT, line, WORKDIR) ?? [line]);
      send("log", entries, offset);
    }
    const status = JSON.stringify({
      state: read("state") || "warming",
      pr: read("pr-url"),
      title: read("title.txt").split("\n")[0],
    });
    if (status !== lastStatus) {
      lastStatus = status;
      res.write(`event: status\ndata: ${status}\n\n`);
    }
  };
  tick();
  const timer = setInterval(tick, 1000);
  // Proxies close quiet streams, so a comment goes out every 15 seconds.
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(timer);
    clearInterval(keepAlive);
  });
}

async function receiveMessage(req, res) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 16_000) return reply(res, 413, { error: "The message is too long." });
  }
  text = text.trim();
  if (!text) return reply(res, 400, { error: "The message is empty." });
  mkdirSync(join(HOME, "inbox"), { recursive: true });
  writeFileSync(join(HOME, "inbox", `${new Date().toISOString().replace(/[:.]/g, "-")}.md`), text);
  const state = read("state");
  // A finished run resumes to answer. Marking it running first stops a second
  // quick message from starting a second resume.
  const resume = state === "completed" || state === "failed:agent";
  if (resume) {
    writeFileSync(join(HOME, "state"), "running\n");
    spawn("bash", [join(HOME, "runner.sh"), "resume"], {
      env: { ...process.env, HANDOFF_HOME: HOME },
      cwd: HOME,
      detached: true,
      stdio: "ignore",
    }).unref();
  }
  reply(res, 200, { resumed: resume });
}

// Passes a request to OpenCode's server unchanged and streams the answer back,
// which keeps its live event streams working.
function proxy(req, res) {
  const upstream = request(
    { host: "127.0.0.1", port: OPENCODE_PORT, method: req.method, path: req.url, headers: req.headers },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("OpenCode is not running yet. Reload in a moment.");
  });
  req.pipe(upstream);
}

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://sandbox");
  if (url.pathname === "/health") return reply(res, 200, { ok: true });
  if (!authorized(req, url)) {
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("This link needs its key. Open the full link from your agent.");
  }
  // The first visit trades the key in the URL for a cookie, then drops it from the address.
  if (url.searchParams.has("key")) {
    url.searchParams.delete("key");
    res.writeHead(303, {
      "set-cookie": `${COOKIE}=${encodeURIComponent(KEY)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
      location: `${url.pathname}${url.search}`,
    });
    return res.end();
  }
  if (url.pathname === "/_handoff/events") return streamEvents(req, res);
  if (url.pathname === "/_handoff/message" && req.method === "POST") return receiveMessage(req, res);
  const showPage = () => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page());
  };
  if (url.pathname === "/_handoff/watch") return showPage();
  if (AGENT !== "opencode") return url.pathname === "/" ? showPage() : (res.writeHead(404), res.end());
  // A fresh visit to the link pairs this browser with OpenCode. A browser that is
  // already signed in goes straight to the app.
  if (url.pathname === "/" && !/opencode/i.test(req.headers.cookie ?? "")) {
    const link = await pairingLink();
    if (!link) return showPage();
    res.writeHead(302, { location: link, "cache-control": "no-store" });
    return res.end();
  }
  proxy(req, res);
});

// Live connections (WebSockets) to OpenCode pass through as raw sockets.
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://sandbox");
  if (AGENT !== "opencode" || !authorized(req, url)) return socket.destroy();
  const upstream = connect(OPENCODE_PORT, "127.0.0.1", () => {
    const headers = Object.entries(req.headers).map(([name, value]) => `${name}: ${value}`).join("\r\n");
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(PORT, process.env.WATCH_HOST || "0.0.0.0");

function page() {
  const name = escapeHtml(label);
  const opencodeNote =
    AGENT === "opencode"
      ? `<p class="note">OpenCode's full app opens here once the agent starts. Reload in a moment.</p>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#000000">
<title>${name} handoff</title>
<style>
/* Zed-inspired agent panel: black transcript, neutral message blocks, hairline
   chrome and a flush composer. Fonts stay inlined so sandbox pages work offline. */
@font-face { font-family: "Inter"; src: url(data:font/woff2;base64,${INTER_WOFF2}) format("woff2"); font-weight: 400 670; font-display: swap; }
@font-face { font-family: "IBM Plex Mono"; src: url(data:font/woff2;base64,${PLEX_WOFF2}) format("woff2"); font-weight: 400 500; font-display: swap; }
:root {
  --deep: #000000; --base: #191919; --raised: #242424;
  --text: #cccccc; --muted: #a0a0a0; --faint: #858585; --icon: #a0a0a0;
  --border: #292929; --border-strong: #373737;
  --hover: #242424; --pressed: #303030;
  --accent: #a2bcff; --success: #78c78b; --danger: #ef9292; --focus: #a2bcff;
  --sans: "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  --session: 820px;
  --pad: 16px;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
}
@media (min-width: 768px) { :root { --pad: 24px; } }
* { box-sizing: border-box; }
html { height: 100%; background: var(--deep); color-scheme: dark; overscroll-behavior: none; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { height: 100vh; height: 100dvh; margin: 0; display: flex; flex-direction: column; overflow: hidden; overscroll-behavior: none; background: var(--deep); color: var(--text); font: 400 14px/22px var(--sans); -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; -webkit-tap-highlight-color: transparent; }
::selection { background: rgba(162, 188, 255, 0.3); }
svg { flex: none; }
button { font: inherit; color: inherit; }
button, .icon-button { touch-action: manipulation; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

/* A single hairline, not a floating session card. Controls have 44px tap areas. */
header { flex: none; padding: env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left); border-bottom: 1px solid var(--border); }
.bar { display: flex; align-items: center; gap: 4px; min-height: 44px; padding: 0 6px 0 16px; }
.bar h1 { flex: 1; min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 14px/20px var(--sans); }
.note { margin: 0 16px 12px; color: var(--muted); }
.ind { display: inline-flex; width: 14px; height: 16px; align-items: center; justify-content: center; color: var(--muted); }
.ind::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.ind > svg { display: none; }
[data-state="running"] .ind { color: var(--success); }
[data-state="completed"] .ind::before, [data-state="failed"] .ind::before { display: none; }
[data-state="completed"] .ind .ok { display: block; color: var(--success); }
[data-state="failed"] .ind .bad { display: block; color: var(--danger); }
.offline .ind { color: var(--danger); }
.offline .ind::before { display: block; }
.offline .ind > svg { display: none; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.icon-button { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--icon); cursor: pointer; text-decoration: none; }
.pr[hidden] { display: none; }
.icon-button:active { background: var(--pressed); color: var(--text); }
@media (hover: hover) and (pointer: fine) { .icon-button:hover:not(:disabled) { background: var(--hover); color: var(--text); } }

/* Only the transcript scrolls. The composer stays above the phone's safe area. */
.panel { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 0 env(safe-area-inset-right) 0 env(safe-area-inset-left); }
.scroll:focus-visible { outline-offset: -2px; }
.scroll, pre.code, .shell > *, pre.out, .diff { overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }

main { max-width: var(--session); margin: 0 auto; padding: 24px var(--pad) 28px; }
.feed { display: flex; flex-direction: column; align-items: flex-start; }
.feed > * { min-width: 0; max-width: 100%; margin-top: 16px; }
.feed > :first-child { margin-top: 0; }
.feed > .you, .feed > .you + * { margin-top: 28px; }
.feed > .you:first-child { margin-top: 0; }
.feed:empty::before { content: "Waiting for the agent…"; color: var(--faint); }

/* Quiet proportional answers; mono for everything the user types or runs. */
.prose { width: 100%; font: 400 15px/1.6 var(--sans); overflow-wrap: anywhere; color: var(--text); }
.prose > :first-child { margin-top: 0; }
.prose > :last-child { margin-bottom: 0; }
.prose p { margin: 0 0 14px; white-space: pre-wrap; }
.prose strong { font-weight: 670; }
.prose a { color: var(--accent); text-decoration: none; }
@media (hover: hover) and (pointer: fine) { .prose a:hover { text-decoration: underline; text-underline-offset: 2px; } }
.prose h1, .prose h2, .prose h3 { color: var(--text); line-height: 150%; }
.prose h1 { margin: 28px 0 14px; font-size: 20px; font-weight: 400; }
.prose h2 { margin: 24px 0 12px; font-size: 18px; font-weight: 400; }
.prose h3 { margin: 20px 0 10px; font-size: 16px; font-weight: 400; }
.prose ul, .prose ol { margin: 8px 0 14px; padding-inline-start: 22px; }
.prose ul { list-style: disc; }
.prose ol { list-style: decimal; padding-inline-start: 2.25rem; }
.prose li { margin-bottom: 4px; }
.prose li::marker { color: var(--muted); }
.prose :not(pre) > code { padding: 1px 4px; border: 1px solid var(--border); border-radius: 3px; background: var(--base); font: 400 0.9em/1.5 var(--mono); }
pre.code { margin: 14px 0 20px; padding: 12px; overflow: auto; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--base); color: var(--text); font: 400 14px/1.6 var(--mono); }
.response-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
.copy { color: var(--faint); }

/* Full-width prompts, like the reference, rather than right-aligned bubbles. */
.you { width: 100%; margin: 0; padding: 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--base); color: var(--text); font: 400 14px/1.6 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.you.pending { color: var(--muted); border-style: dashed; }

/* Tool calls keep their existing folding behavior, with visible affordances. */
.group { width: 100%; }
.gtrig { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; min-height: 44px; padding: 0 8px 0 2px; border: 0; border-radius: 4px; background: transparent; color: var(--muted); font: 400 13px/18px var(--sans); text-align: start; cursor: pointer; user-select: none; -webkit-user-select: none; }
.chev { display: grid; place-items: center; width: 16px; height: 16px; color: var(--faint); transform: rotate(-90deg); }
.group.open > .gtrig .chev { transform: none; }
.rows { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; padding: 0 0 4px 12px; border-left: 1px solid var(--border); }
.rows[hidden] { display: none; }
.tool { display: flex; flex-direction: column; min-width: 0; }
.trig { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px; padding: 4px 0; border: 0; background: none; font: 400 13px/18px var(--sans); text-align: start; cursor: default; user-select: none; -webkit-user-select: none; }
.tool.has-detail .trig { cursor: pointer; }
.gtrig:active, .tool.has-detail .trig:active { background: var(--pressed); }
@media (hover: hover) and (pointer: fine) { .gtrig:hover, .tool.has-detail .trig:hover { background: var(--hover); } }
.tool:not(.has-detail) .chev { visibility: hidden; }
.label { flex: none; display: inline-flex; color: var(--icon); }
.sub { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.arg { flex: none; white-space: nowrap; color: var(--faint); font-feature-settings: "tnum"; }
.arg .add { color: var(--success); }
.arg .del { color: var(--danger); }
.tool.open .chev { transform: none; }
.tool[data-state="error"] .label, .tool[data-state="error"] .sub { color: var(--danger); }
.tool[data-state="running"] .label { color: var(--text); }
.detail { margin-top: 4px; }
.detail[hidden] { display: none; }

/* Tool output: shell block, plain output, diff, todos. */
.shell { border: 1px solid var(--border-strong); border-radius: 6px; overflow: hidden; background: var(--base); font: 400 13px/20px var(--mono); }
.shell > * { display: block; margin: 0; padding: 12px; max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.shell .cmd { color: var(--text); }
.shell .res { border-top: 1px solid var(--border); background: var(--deep); color: var(--muted); }
pre.out { margin: 0; max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--muted); font: 440 13px/150% var(--mono); letter-spacing: -0.04px; }
.tool[data-state="error"] pre.out { color: var(--danger); }
.diff { border: 1px solid var(--border-strong); border-radius: 6px; overflow: hidden; font: 400 13px/20px var(--mono); max-height: 320px; overflow-y: auto; }
.dl { display: flex; gap: 8px; padding: 0 12px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text); }
.dl i { flex: none; width: 1ch; font-style: normal; }
.dl.add { background: rgba(107, 213, 134, 0.1); }
.dl.add i { color: var(--success); }
.dl.del { background: rgba(241, 116, 113, 0.1); }
.dl.del i { color: var(--danger); }
.todos, .paths { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 4px 0; list-style: none; }
.todos li { display: flex; gap: 8px; font: 440 13px/130% var(--sans); color: var(--text); }
.todos .box { flex: none; width: 16px; height: 16px; margin-top: -1.5px; border-radius: 4px; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.2); color: var(--base); display: grid; place-items: center; }
.todos .done { color: var(--faint); text-decoration: line-through; }
.todos .done .box { background: var(--icon); box-shadow: none; }
.paths li { font: 440 13px/16px var(--mono); letter-spacing: -0.04px; color: var(--muted); overflow-wrap: anywhere; }

.event { font: 440 13px/16px var(--sans); letter-spacing: -0.04px; color: var(--faint); overflow-wrap: anywhere; }
.event.good { color: var(--success); }
.event.bad { color: var(--danger); }
.event a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.feed > pre.out { width: 100%; margin-top: 8px; padding: 12px; border: 1px solid var(--border); border-radius: 6px; }

/* Flush, bordered composer with the same top-right expand and bottom-right send
   arrangement as the reference. No decorative or unsupported model controls. */
footer { position: relative; flex: none; display: flex; flex-direction: column; align-items: center; padding: 0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); border-top: 1px solid var(--border); background: var(--base); }
.hint:empty { display: none; }
.hint { width: 100%; max-width: var(--session); margin: 0; padding: 8px var(--pad) 0; font: 400 12px/18px var(--sans); color: var(--muted); }
.offline .hint { color: var(--danger); }
form { position: relative; width: 100%; max-width: var(--session); margin: 0; }
textarea { display: block; width: 100%; min-height: 88px; max-height: min(180px, 40dvh); margin: 0; padding: 16px 52px 8px var(--pad); resize: none; border: 0; border-radius: 0; background: transparent; color: var(--text); font: 400 16px/1.6 var(--mono); }
textarea::placeholder { color: var(--faint); }
textarea:focus-visible { outline: none; }
form:focus-within { box-shadow: inset 0 2px 0 var(--focus); }
.expand { position: absolute; top: 2px; right: 4px; }
.actions { display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 0 6px 4px var(--pad); color: var(--muted); font: 400 12px/18px var(--sans); }
.agent-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-state { display: inline-flex; align-items: center; gap: 4px; padding-left: 8px; border-left: 1px solid var(--border-strong); white-space: nowrap; }
.send { position: relative; margin-left: auto; background: transparent; }
.send::before { content: ""; position: absolute; width: 26px; height: 26px; border: 1px solid var(--border-strong); border-radius: 4px; background: var(--pressed); }
.send svg { position: relative; }
.send:not(:disabled) { color: var(--text); }
.send:disabled { color: #666; cursor: not-allowed; }
.send:disabled::before { background: var(--raised); border-color: var(--border); }
.panel.composing form { display: flex; flex: 1; flex-direction: column; min-height: 0; }
.panel.composing footer { flex: 1; min-height: 0; }
.panel.composing .scroll, .panel.composing .latest { display: none; }
.panel.composing textarea { flex: 1; height: auto !important; max-height: none; min-height: 0; }
.latest { position: absolute; left: 50%; bottom: calc(var(--dock, 0px) + 12px); z-index: 1; border: 1px solid var(--border-strong); background: var(--base); opacity: 0; visibility: hidden; transform: translate(-50%, 6px); pointer-events: none; transition: opacity 0.15s var(--ease-out), transform 0.15s var(--ease-out), visibility 0.15s; }
.latest.show { opacity: 1; visibility: visible; transform: translate(-50%, 0); pointer-events: auto; }

@media (prefers-reduced-motion: reduce) {
  .latest { transition: none; transform: translate(-50%, 0); }
}
</style>
</head>
<body data-state="warming">
<header id="header">
  <div class="bar"><h1 id="title">${name} is getting ready</h1><a class="icon-button pr" id="pr" target="_blank" rel="noopener" aria-label="Open pull request" title="Open pull request" hidden><svg data-icon="git-pull-request"></svg></a></div>
  ${opencodeNote}
</header>
<div class="panel">
<div class="scroll" id="scroll" role="region" aria-label="Agent transcript" tabindex="0"><main><div class="feed" id="feed"></div></main></div>
<p class="sr" id="activity" role="status" aria-atomic="true"></p>
<button class="icon-button latest" id="latest" type="button" aria-label="Jump to latest" title="Jump to latest"><svg data-icon="arrow-down"></svg></button>
<footer id="footer">
  <p class="hint" id="hint" role="status"></p>
  <form id="send">
    <textarea id="text" rows="1" placeholder="Message ${name}…" aria-label="Message ${name}" enterkeyhint="send"></textarea>
    <button class="icon-button expand" id="expand" type="button" aria-label="Expand composer" aria-expanded="false" title="Expand composer"><svg data-icon="expand"></svg></button>
    <div class="actions">
      <span class="agent-label">${name}</span>
      <span class="run-state"><span class="ind" id="indicator" aria-hidden="true"><svg class="ok" data-icon="circle-check"></svg><svg class="bad" data-icon="warning"></svg></span><span id="state" role="status">Connecting</span></span>
      <button class="icon-button send" id="go" type="submit" aria-label="Send message" title="Send message"><svg data-icon="send"></svg></button>
    </div>
  </form>
</footer>
</div>
<script>(${client})()</script>
</body>
</html>`;
}

// The page's script. It runs in the browser, inserted into the page as source.
function client() {
  const feed = document.getElementById("feed");
  const latest = document.getElementById("latest");
  const hint = document.getElementById("hint");
  const activity = document.getElementById("activity");
  const states = { warming: "Getting ready", waiting_for_idle: "Getting ready", running: "Working", completed: "Done", failed: "Failed" };

  // Tool artwork from OpenCode (MIT); original chrome icons use the same 20px
  // view box. A 1.5px stroke renders at Zed's 1.2px weight in a 16px icon.
  const ICONS = {
    "git-pull-request": '<g stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="4" r="2"/><circle cx="5" cy="16" r="2"/><circle cx="15" cy="16" r="2"/><path d="M5 6v8m10 0V7a3 3 0 0 0-3-3H9m3-3L9 4l3 3"/></g>',
    send: '<path d="m4 4 12 6-12 6 2-6zm2 6h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    expand: '<path d="M12 3h5v5m0-5-6 6M8 17H3v-5m0 5 6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    collapse: '<path d="m17 3-6 6m0-5v5h5M3 17l6-6m-5 0h5v5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    copy: '<rect x="7" y="7" width="10" height="10" rx="1" stroke="currentColor" stroke-width="1.5"/><path d="M12 4V3H3v9h1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    "arrow-down": '<path d="M10 3v14m-5-5 5 5 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
    console: '<path d="M3.75 5.4165L8.33333 9.99984L3.75 14.5832M10.4167 14.5832H16.25" stroke="currentColor" stroke-linecap="square"/>',
    glasses: '<path d="M0.416626 7.91667H1.66663M19.5833 7.91667H18.3333M11.866 7.57987C11.3165 7.26398 10.6793 7.08333 9.99996 7.08333C9.32061 7.08333 8.68344 7.26398 8.13389 7.57987M8.74996 10C8.74996 12.0711 7.07103 13.75 4.99996 13.75C2.92889 13.75 1.24996 12.0711 1.24996 10C1.24996 7.92893 2.92889 6.25 4.99996 6.25C7.07103 6.25 8.74996 7.92893 8.74996 10ZM18.75 10C18.75 12.0711 17.071 13.75 15 13.75C12.9289 13.75 11.25 12.0711 11.25 10C11.25 7.92893 12.9289 6.25 15 6.25C17.071 6.25 18.75 7.92893 18.75 10Z" stroke="currentColor" stroke-linecap="square"/>',
    "code-lines": '<path d="M2.08325 3.75H11.2499M14.5833 3.75H17.9166M2.08325 10L7.08325 10M10.4166 10L17.9166 10M2.08325 16.25L8.74992 16.25M12.0833 16.25L17.9166 16.25" stroke="currentColor" stroke-linecap="square" stroke-linejoin="round"/>',
    "magnifying-glass-menu": '<path d="M2.08325 10.0002H4.58325M2.08325 5.41683H5.41659M2.08325 14.5835H5.41659M16.4583 13.9585L18.7499 16.2502M17.9166 10.0002C17.9166 12.9917 15.4915 15.4168 12.4999 15.4168C9.50838 15.4168 7.08325 12.9917 7.08325 10.0002C7.08325 7.00862 9.50838 4.5835 12.4999 4.5835C15.4915 4.5835 17.9166 7.00862 17.9166 10.0002Z" stroke="currentColor" stroke-linecap="square"/>',
    "window-cursor": '<path d="M17.5 10.4167V3.75H2.5V17.0833H10.4166M17.9166 13.5897L11.6666 11.6667L13.5897 17.9167L15.032 15.0321L17.9166 13.5897Z" stroke="currentColor" stroke-linecap="square"/><path d="M5.41675 6.125C5.71576 6.12518 5.95777 6.36795 5.95777 6.66699C5.95759 6.96589 5.71565 7.20783 5.41675 7.20801C5.11771 7.20801 4.87494 6.966 4.87476 6.66699C4.87476 6.36784 5.1176 6.125 5.41675 6.125ZM8.33276 6.125C8.63191 6.125 8.87476 6.36784 8.87476 6.66699C8.87458 6.966 8.63181 7.20801 8.33276 7.20801C8.03386 7.20783 7.79192 6.96589 7.79175 6.66699C7.79175 6.36795 8.03376 6.12518 8.33276 6.125ZM11.2498 6.125C11.5489 6.125 11.7917 6.36784 11.7917 6.66699C11.7916 6.966 11.5488 7.20801 11.2498 7.20801C10.9507 7.20801 10.7079 6.966 10.7078 6.66699C10.7078 6.36784 10.9506 6.125 11.2498 6.125Z" fill="currentColor" stroke="currentColor" stroke-width="0.25" stroke-linecap="square"/>',
    task: '<path d="M9.99992 2.0835V17.9168M7.08325 3.75016H2.08325V16.2502H7.08325M12.9166 16.2502H17.9166V3.75016H12.9166" stroke="currentColor" stroke-linecap="square"/>',
    checklist: '<path d="M9.58342 13.7498H17.0834M9.58342 6.24984H17.0834M2.91675 6.6665L4.58341 7.9165L7.08341 4.1665M2.91675 14.1665L4.58341 15.4165L7.08341 11.6665" stroke="currentColor" stroke-linecap="square"/>',
    mcp: '<g><path d="M0.972656 9.37176L9.5214 1.60019C10.7018 0.527151 12.6155 0.527151 13.7957 1.60019C14.9761 2.67321 14.9761 4.41295 13.7957 5.48599L7.3397 11.3552" stroke="currentColor" stroke-linecap="round"/><path d="M7.42871 11.2747L13.7957 5.48643C14.9761 4.41338 16.8898 4.41338 18.0702 5.48643L18.1147 5.52688C19.2951 6.59993 19.2951 8.33966 18.1147 9.4127L10.3831 16.4414C9.98966 16.7991 9.98966 17.379 10.3831 17.7366L11.9707 19.1799" stroke="currentColor" stroke-linecap="round"/><path d="M11.6587 3.54346L5.33619 9.29119C4.15584 10.3642 4.15584 12.1039 5.33619 13.177C6.51649 14.25 8.43019 14.25 9.61054 13.177L15.9331 7.42923" stroke="currentColor" stroke-linecap="round"/></g>',
    check: '<path d="M6.5 11.4412L8.97059 13.5L13.5 6.5" stroke="currentColor" stroke-linecap="square"/>',
    "circle-check": '<path d="M12.4987 7.91732L8.7487 12.5007L7.08203 10.834M17.9154 10.0007C17.9154 14.3729 14.371 17.9173 9.9987 17.9173C5.62644 17.9173 2.08203 14.3729 2.08203 10.0007C2.08203 5.6284 5.62644 2.08398 9.9987 2.08398C14.371 2.08398 17.9154 5.6284 17.9154 10.0007Z" stroke="currentColor" stroke-linecap="square"/>',
    warning: '<path d="M10 7.91667V11.6667M10 13.7417V13.75M10 2.5L1.875 16.25H18.125L10 2.5Z" stroke="currentColor" stroke-linecap="square"/>',
  };
  const TOOL_ICON = { run: "console", read: "glasses", edit: "code-lines", search: "magnifying-glass-menu", web: "window-cursor", agent: "task", plan: "checklist", tool: "mcp" };
  const CHEV = '<span class="chev"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 6.5L8 9.5L11 6.5" stroke="currentColor"/></svg></span>';
  const svg = (name, size) => '<svg width="' + (size || 16) + '" height="' + (size || 16) + '" viewBox="0 0 20 20" fill="none" aria-hidden="true">' + (ICONS[name] || "") + "</svg>";
  document.querySelectorAll("svg[data-icon]").forEach((node) => {
    node.setAttribute("width", "16"); node.setAttribute("height", "16"); node.setAttribute("viewBox", "0 0 20 20"); node.setAttribute("fill", "none");
    node.innerHTML = ICONS[node.dataset.icon];
  });
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // Keeps the jump button above the composer as it grows.
  const fit = () => document.body.style.setProperty("--dock", document.getElementById("footer").offsetHeight + "px");
  new ResizeObserver(fit).observe(document.getElementById("footer"));

  // The transcript scrolls inside the session panel, not the window.
  const scroller = document.getElementById("scroll");
  const atBottom = () => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 80;
  let pinned = true;
  scroller.addEventListener("scroll", () => { pinned = atBottom(); latest.classList.toggle("show", !pinned); }, { passive: true });
  latest.addEventListener("click", () => { pinned = true; scroller.scrollTo({ top: scroller.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }); });
  const follow = () => { if (pinned) scroller.scrollTop = scroller.scrollHeight; };

  let phase = "";
  let group = null; // the run of tool rows that new calls join
  let rows = new Map();
  let recent = []; // the agent's last raw output lines, shown if the run fails

  // Only a truncated log starts over. Reconnects append from the last event ID.
  function reset() {
    feed.replaceChildren();
    phase = ""; group = null; rows = new Map(); recent = [];
    pinned = true;
  }

  function add(node) {
    group = null;
    feed.append(node);
    return node;
  }

  function event(text, tone, lines) {
    const p = el("p", "event" + (tone ? " " + tone : ""));
    const link = /\s*(https:\/\/\S+)/.exec(text);
    if (link) {
      const a = el("a", "", text.slice(0, link.index));
      a.href = link[1]; a.target = "_blank"; a.rel = "noopener";
      p.append(a);
    } else p.textContent = text;
    add(p);
    if (lines && lines.length) add(el("pre", "out", lines.join("\n")));
  }

  // Diff lines carry their own sign; each row is tinted by it.
  function diffBlock(lines) {
    const box = el("div", "diff");
    for (const line of lines) {
      const row = el("div", "dl " + (line[0] === "+" ? "add" : "del"));
      row.append(el("i", "", line[0]), line.slice(1));
      box.append(row);
    }
    return box;
  }

  // Inline code, bold, and links; the rest stays as the agent wrote it.
  function inline(parent, text) {
    for (const part of text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/)) {
      if (!part) continue;
      let match;
      if (/^`.+`$/.test(part)) parent.append(el("code", "", part.slice(1, -1)));
      else if (/^\*\*.+\*\*$/.test(part)) parent.append(el("strong", "", part.slice(2, -2)));
      else if ((match = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part))) {
        const a = el("a", "", match[1]);
        a.href = match[2]; a.target = "_blank"; a.rel = "noopener";
        parent.append(a);
      } else parent.append(part);
    }
  }

  function prose(text) {
    const div = el("div", "prose");
    text.split(/```[\w-]*\n([\s\S]*?)```/).forEach((chunk, index) => {
      if (index % 2) { div.append(el("pre", "code", chunk.replace(/\n$/, ""))); return; }
      for (const para of chunk.split(/\n{2,}/)) {
        const lines = para.split("\n").filter((l) => l.trim());
        if (!lines.length) continue;
        const bullet = lines.every((l) => /^\s*[-*] /.test(l));
        const numbered = lines.every((l) => /^\s*\d+[.)] /.test(l));
        if (bullet || numbered) {
          const list = el(bullet ? "ul" : "ol");
          for (const l of lines) { const li = el("li"); inline(li, l.replace(/^\s*(?:[-*]|\d+[.)]) /, "")); list.append(li); }
          div.append(list);
          continue;
        }
        const heading = /^(#{1,3}) (.*)$/.exec(lines[0]);
        if (heading) {
          const h = el("h" + heading[1].length);
          inline(h, heading[2]);
          div.append(h);
          lines.shift();
          if (!lines.length) continue;
        }
        const p = el("p");
        inline(p, lines.join("\n").replace(/^#{1,6} /gm, ""));
        div.append(p);
      }
    });
    const actions = el("div", "response-actions");
    const copy = el("button", "icon-button copy");
    copy.type = "button";
    copy.title = "Copy response";
    copy.setAttribute("aria-label", "Copy response");
    copy.innerHTML = svg("copy");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.innerHTML = svg("check");
        copy.setAttribute("aria-label", "Copied response");
        activity.textContent = "Response copied.";
        setTimeout(() => { copy.innerHTML = svg("copy"); copy.setAttribute("aria-label", "Copy response"); }, 1600);
      } catch {
        hint.textContent = "Couldn't copy. Select the response text to copy it.";
      }
    });
    actions.append(copy);
    div.append(actions);
    add(div);
  }

  function summarize(g) {
    const calls = [...g.querySelectorAll(".tool")];
    const title = calls.length + (calls.length === 1 ? " tool call" : " tool calls");
    g.querySelector(".gtrig .n").textContent = title;
    const working = calls.some((call) => call.dataset.state === "running");
    g.querySelector(".gtrig").setAttribute("aria-label", title + (working ? ", working" : ""));
  }

  function tool(item) {
    let row = rows.get(item.id);
    if (!row) {
      if (!group) {
        const g = add(el("div", "group"));
        g.innerHTML = '<button class="gtrig" type="button" aria-expanded="false"><span class="n"></span>' + CHEV + '</button><div class="rows" hidden></div>';
        group = g;
      }
      row = el("div", "tool");
      row.innerHTML = '<button class="trig" type="button" aria-expanded="false"><span class="label"></span><span class="sub"></span><span class="arg"></span>' + CHEV + '</button><div class="detail" hidden></div>';
      group.querySelector(".rows").append(row);
      rows.set(item.id, row);
    }
    if (item.icon) { row.dataset.icon = item.icon; row.querySelector(".label").innerHTML = svg(TOOL_ICON[item.icon] || "mcp"); }
    if (item.title !== undefined) { row.dataset.title = item.title; row.querySelector(".sub").textContent = item.title; row.querySelector(".sub").title = item.title; }
    if (item.meta) {
      const arg = row.querySelector(".arg");
      arg.replaceChildren();
      item.meta.split(" ").forEach((part, index) => {
        arg.append(el("span", part[0] === "+" ? "add" : part[0] === "-" ? "del" : "", (index ? " " : "") + part.replace(/^-/, "−")));
      });
    }
    const detail = row.querySelector(".detail");
    if (item.state) row.dataset.state = item.state;
    if (row.dataset.icon === "run") {
      // A shell call opens as its command above its result.
      const box = el("div", "shell");
      if (row.dataset.title) box.append(el("span", "cmd", row.dataset.title));
      if (item.output !== undefined && item.output !== "") box.append(el("span", "res", item.output));
      if (box.childElementCount) detail.replaceChildren(box);
    } else {
      if (item.detail) {
        detail.replaceChildren();
        if (item.detail.diff) detail.append(diffBlock(item.detail.diff));
        const list = item.detail.checklist || item.detail.list;
        if (list) {
          const ul = el("ul", item.detail.checklist ? "todos" : "paths");
          for (const entry of list) {
            const li = el("li", entry.done ? "done" : "");
            if (item.detail.checklist) { const box = el("span", "box"); if (entry.done) box.innerHTML = svg("check"); li.append(box); }
            li.append(typeof entry === "string" ? entry : entry.text);
            ul.append(li);
          }
          detail.append(ul);
        }
      }
      // A diff or a plan says more than the tool's own reply, unless the call failed.
      if (item.output && (!detail.childElementCount || item.state === "error")) detail.append(el("pre", "out", item.output));
    }
    row.classList.toggle("has-detail", detail.childElementCount > 0);
    row.querySelector(".trig").setAttribute("aria-label", (row.dataset.title || "Tool call") + ", " + (row.dataset.state || "running"));
    detail.hidden = !row.classList.contains("open");
    summarize(row.closest(".group"));
  }

  function line(raw) {
    const text = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").split("\r").pop();
    const runner = /^\d{4}-\d\d-\d\dT[\d:]+Z \[([\w-]+)\] (.*)$/.exec(text);
    if (!runner) {
      if (text.trim()) { recent.push(text); if (recent.length > 30) recent.shift(); }
      return;
    }
    phase = runner[1];
    const body = runner[2];
    if (body.startsWith("message: ")) {
      document.querySelector(".you.pending")?.remove();
      add(el("p", "you", body.slice(9)));
    } else if (body.startsWith("GitHub refused the push")) event(body, "bad");
    else if (body.startsWith("state failed:push")) return;
    else if (body.startsWith("state failed")) event("Stopped with an error", "bad", recent);
    else if (body.startsWith("state ")) return;
    else if (/^(opened|updated)( the)? draft pull request/.test(body)) event(body.replace(/^opened/, "Opened").replace(/^updated/, "Updated"), "good");
    else if (body.startsWith("pushed ")) event("Pushed " + body.slice(7));
    else if (phase !== "run" && phase !== "resume") event(body.charAt(0).toUpperCase() + body.slice(1));
  }

  function entry(item) {
    if (typeof item === "string") line(item);
    else if (item.kind === "text") prose(item.text);
    else if (item.kind === "tool") tool(item);
    else if (item.kind === "note") event(item.text, item.tone);
  }

  // A tap on "Used N ..." lists the calls; a tap on a call with something to show opens it.
  feed.addEventListener("click", (e) => {
    const trigger = e.target.closest(".gtrig, .trig");
    if (!trigger) return;
    const box = trigger.parentElement;
    if (trigger.classList.contains("trig") && !box.classList.contains("has-detail")) return;
    const open = box.classList.toggle("open");
    trigger.setAttribute("aria-expanded", open);
    box.querySelector(trigger.classList.contains("gtrig") ? ".rows" : ".detail").hidden = !open;
  });

  const events = new EventSource("/_handoff/events");
  events.addEventListener("reset", reset);
  events.addEventListener("log", (e) => {
    const items = JSON.parse(e.data);
    items.forEach(entry);
    if (items.some((item) => item.kind === "text")) {
      activity.textContent = feed.querySelectorAll(".prose").length + " agent responses. Latest response available.";
    }
    follow();
  });
  events.addEventListener("status", (e) => {
    const { state, pr, title } = JSON.parse(e.data);
    const kind = state.startsWith("failed") ? "failed" : state;
    document.body.dataset.state = kind;
    document.getElementById("state").textContent = states[kind] || kind;
    document.getElementById("indicator").title = states[kind] || kind;
    if (title) { document.getElementById("title").textContent = title; document.title = title; }
    const link = document.getElementById("pr");
    if (pr) { link.href = pr; link.hidden = false; }
  });
  events.onopen = () => { document.body.classList.remove("offline"); hint.textContent = ""; };
  events.onerror = () => { document.body.classList.add("offline"); hint.textContent = "Reconnecting…"; };

  const text = document.getElementById("text");
  const go = document.getElementById("go");
  const expand = document.getElementById("expand");
  const panel = document.querySelector(".panel");
  const setExpanded = (open) => {
    panel.classList.toggle("composing", open);
    expand.setAttribute("aria-expanded", open);
    expand.setAttribute("aria-label", open ? "Collapse composer" : "Expand composer");
    expand.title = open ? "Collapse composer" : "Expand composer";
    expand.innerHTML = svg(open ? "collapse" : "expand");
    text.focus();
    if (!open) { grow(); follow(); }
  };
  expand.addEventListener("click", () => setExpanded(!panel.classList.contains("composing")));
  text.addEventListener("keydown", (e) => { if (e.key === "Escape" && panel.classList.contains("composing")) setExpanded(false); });
  const grow = () => { text.style.height = "auto"; text.style.height = Math.min(Math.max(text.scrollHeight, 88), 180) + "px"; };
  const ready = () => { go.disabled = !text.value.trim(); };
  text.addEventListener("input", grow);
  text.addEventListener("input", ready);
  ready();
  text.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) { e.preventDefault(); go.click(); } });
  document.getElementById("send").addEventListener("submit", async (e) => {
    e.preventDefault();
    const message = text.value.trim();
    if (!message) return;
    go.disabled = true;
    // Shows the message at once; the log confirms it when the agent picks it up.
    const bubble = add(el("p", "you pending", message));
    pinned = true; follow();
    try {
      const response = await fetch("/_handoff/message", { method: "POST", body: message });
      if (!response.ok) throw new Error((await response.json()).error);
      text.value = ""; grow(); hint.textContent = "";
      activity.textContent = "Message queued for the agent.";
      if (panel.classList.contains("composing")) setExpanded(false);
    } catch (error) {
      bubble.remove();
      hint.textContent = "Not sent: " + error.message;
    }
    ready();
  });
}

// Inter (variable, weights 400 to 670) and IBM Plex Mono, both Latin subsets, so the page needs no network.
const INTER_WOFF2 = "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";
const PLEX_WOFF2 = "d09GMgABAAAAAEN0ABEAAAAAxTgAAEMSAAIBBgAAAAAAAAAAAAAAAAAAAAAAAAAAGkAbIByNHAZgAIQcCEYJgnMREAqCv0yCnGcBNgIkA4lAC4RiAAQgBZM8B4tYDINWG0uwFxi3F4RvKxUAEm88GhnDxoF4PNh4ZKB2UFJK2f//nxPUGMPnzQOs5dyEkpAiJKpS10IVKuNd8anPatUHlqp4lUpM0+qBcq10W7gOXPwNi9g6y+RR6g5VcYX2GXBYruhZz7tdRgbBb+JtGOzxZ9qftjgBJZaAAcME52UbbOH6ydESY20KT2LQUxn+9vwn7oE1yRngTo3IsczzX/uBnvv2hwkVkXDRqFkmkorCZSpUZXVVKxwr2iM6q6ruCScLQXPPFQ8ikwGaW1M2QEcJvWaRrFjC8naxW9+2WzBijJEhrf2i8mL+v43BG/1lwOP/ox+lXxH6KWQyWcnnsywo3IwEIWv9Zv21Bj/cT3Ofa7tx6WUApCi/Q8q5AQtPOk5l7upqxRxqbSNR8t/2Q3hG6kaTxmYBBARAAwJkCfx/qmldWh+2n5fV1iGXOrUiX2tTPsWYGIECyG2cMoWnzwsfYMQPFilglVxbEN/xL5j/nVb1ZcmSLFmSY6wqV3J1u2PcHNgleGyGHUqAzR1AM4Dt4s2ATT9+CbA7wHaqzVy+7OR3JlpXCHehlqGddCbPvr7ngljiSMJJLeKIfem+fE9w0D1TG52dOnIIzAOi22+tXCWXVc6BpHQmSAwAISBGwP+vU3/Vs8o4fuCxPfsr85xu3T88XcmybFkGBW0HHDg9gYId+k7q9lhxwXKcEqJL7J985gkYpq4faKZ9xvn7/+51NunrlV2ktsJ4zs1lpoWtPpGMNRUWIREOI8ZWKA4aqXAOITTCCvC/TM3Seb/RHEoeBVKIUbNzxgchBFLWpxtdEAOfnzMaNj57iwVZLuQc5N2gB7sgAFLOUMrPB/kpvVDROZtfkLk4USjf9mbuA4xz4FOeCA0hMivTfPW/tdqrvhe5pHQXrPjJGOMLQgRJF5mU+v1mUOrPmNp/0vZ27/5OvdXhCEEwIBAeshVvLGPTTj5/CSPfBa8qAcYDUIQYCpASb2iW2Yg5VkKr7YL2OwOddxd64AmEwFi69OHxk7GpkI4BdBkQYKzltVyK6fj5wg+PTpcGHwymlNOQZsGFxyiHywjEMqVGb2Fla8+B44kelQvNCIonlMhVWjODtdG+Qyf4NllsnKT5IqlCrTO3tLEzOXLqTDSiDtFkPghubBZd+H7KhE6iu0FoU2TRCxNmcdFvGKxOvUYUx02k4Smo08hFVWYdHQbmSWxnJ2rvnTMN9s6FJvbOlWb3zo2W9upO6wfSVtyCO6nGVvbDA7ATPJoMPI+kDMEzamJjTGTElBsC/EHJUcy9nMXLW3kFa17RBq8kDyY0/kdZKizl+zOKNbPm68MGFF3aAtvcVteG/fGz7Vq72l5Cu68mNInwDFhksSWWWma5vZAIo98cc80z3wIL7UEt/proH2S6jDnzFswpIKZBu36LScgR8OUnAsrhn/CAivZv+EDF+C8CoGL9HyFQce7gCVR8AMcClRBEFqjEEJQAlRSKckAlh0F5ICgWC+zjA/kLt7ghA2IqOnUxvMJQwwT7zdIslbLN7kY3zsmVw5h16O8Zs86wiWYmG6hWlijKYI1yAKIabNEMYLQDFJ0AxyAhtuDAgQMHDhw4x92JSEyZNuMoeTe1ZCuCc9ybUslTp8+cPfeohAh1002wDhw4x9l12WLb2GgQjRoGX8+SVhNpPREuajilraRvkPQ1aNFb9RcgEMAG6p6veiyxX377Q0qGwiBBioyRqv1Kw0M+ClCIIhQjixKUQ/kBFf2Veua5F1565bU33nrn/QBZ3pYPPvrksy+++ua7H34OILQcCYJEEQ2qRYaa/XP9CPaezwpsmlAlwHu4XEQQDIIgC50wQBjIqsFUjYhAEKVF2JS2JwvsD6O+LnZOEn4PYMTOnuXzIA7HVGbG44F6IRkIzslnWe4wxm20iLA8EY9QIK0TrDqsCGMBcOZonCEGYv1TVCIzje2AqHJPLXoHqIHsBBajQAF5yXQUEgMJn3/bGWKocuQlUEyLMavcwV9S6mjdrNuLVdGNKnowgCmswGD1EvQUv0smYzEn3oJUazXucJRJtrimCjpRBqou0/lNMgH0+9CXKqB3IPx/V5pKR/dBIMAv2+9H3pfed7736qPau6O8mZArcBXBLQSPjCBkOwCyMc5xd/HKbGrETZhhlKA63XqsNyxXSJXlDHLU2m6cCergeg3qs0lmTDH4BIRExFjNRg3YHJlq95luipn+MR5j/1uj0j2Ra4+RbqOj/1kcE0/9Z2cEnutSFeUooIpazznqmFOOO+m0My4574KLrrnsiqvOue62G26665Yx7njsgYceeeK+PeZHTP2F5r08V1hpndXWWGuzDTbaZJUtdthqm122G2unQ/Y74KDD9jnint0KJTRqkNTkLn0m0eArlEY2myH9YJPMRZmWLIxgfPckSZTU1BBKoJquUgxIaid6TGk+K7+ATupdUYX7+ST6Wei/D2UqDYVGv3dckIH82Xi6OiKwoNLjIjTqPuyvn9hehlvsztw51PF0feejfsmcHuTe8SS8U/ucbnxmtT/Mpeti98wr4yJyQUekk7hYvFjTL0zQ/15IiL3rIm0DR/bY+g9T8ocNl7RG7ptHlsiHTTN3mJMgGU56fe4MF6XWpIIxcyCcRmE1ZGDnCs5e7Z/HwSW3jE9nJ5qjzkZVXo0WzvKG/bnQx9Fm4QOGUkZeZLRwaX+WmXFR8O6pzU1Jax5HDRAlJKZI0GWTANkMqHsIuYEw62eAhXsUDO9B/QguzAQCQA0lPEfUTAucoElrUUcqFfWjYzGcol1mDkR/iPrRKe05O34KkxJWo+cRngUD+c0LwpB8cw3qwlAaeE5C6RecSVcoNadaQqjoIOQy6KAMgQvLD5/jSPUvlODJOqkoeALDMGVm2g82YT5UrFHxldJdcKpVroXUWgx5tOVxjE+iXHhBIDgJhJg7whVb10009d0okaJItNjxQgSBK6JER0q53ZUkm0Y7QNqWRNFVQvpZo8oq61IeaTIjrSFOxqgeUJ0rTTm/uVFlV0+ZUUx3cLkKgigp57CKc7+Xro5c4/rcbkV44ZIxEEj7V681rXTJN3trxqJQ++RMOzdLLSrH0c44v/IDj9wpXSjlCyVKV2tZjZL0mXYKoTO9VkuLqnkXdCIW1Q5lka6K5QMvmaFebge2NjYlW1DeRJONbA6kbmU0mUO37BqZDMwWGOUg/9MkRM8KgdYcBdohMk5lhZBj2zI2UY1uz7K+siBsFnDN3Q1BzM50FRtN4TifW1Ai3mTbJRgcim38poN2/f+67AwkUrBz0dGbZbOSNpdKB2SdBWRubPSUJ9ipWTCZJhxQ1s8mEKKKRHPfWn6mMYtciAtVMKhloYIwz6K0m+GNOuizY6QXNWtnZ1tgjUBmC9vyKH4AStDlOJ5cQTizFoESqRItA1f+UTrMiNZAdwuBrVKbOvj3v4XTEOCNQNWMLqFC1WoowH36U5IW67o4lK2eVWBJbH9zDmZGpn+2h8Fy4PSsjWyyWk0UD20HJ+FipGvROUHjFQTmMgnHpPApA+ZEMzws+KCCgfqS28FfCCXcZVATskru/YOPnlak9wX6kmOw9R3X3Q7hSyNQGSeMtyvfuTVhwex47lxc9Lgv/qZvvCaU21q+bYNV/+52atvnkW78/E/qGjBdyUbKGZo5RLnn5J7wOB8Po9ocFqsFPcM+ms19es9YnmHHlv3Ue0CHBuzDZmjNCoQA5xYOj/N0GIUydscHo85Grdxtxf7qjR2P34uGOx7sU/JnMbhooub+lAXpc0FQXhq5GNnKXde7HVFVOSBqZE2TGvGtq6xZSjwK2/wVaytGprqVWNQN/ffvzH6dg7aHh7LAbArULGyzRd0/rILRulR/JYghn1zu+ITARDpTpX128gY4QDUE1VjlnhVNB8EBnCKw7VCV+sdZj4aiRBduXxe6yaMpe0WPVH8iMbakYcgY6Z+sfnf63GAC7yTcgb6TyOMAfU18cOeXKuMsu8N3XxiDQnHcv+1djc1Uwv23D7hWnf4K9eSxJ7titQIp2DMhR0GAaQ4IDlVyn23LvufQiF5DpHhn3FOLJPSdoqQ0tvycXewZXZRjOt1juaImzNnvKdKXjgX2q32i/ekm56Dmu2BJs7m7I3LYntH4+zWaPhZ2b83FUHpX6Ko451zzLec6WJ1hfjmKrP/vkvNUIgCUwZlPNrwdqyl/uL5kuciq0fnoAjmwJRbT8L3CeZX9q0RWTtm+QF6+c5FZ85bSdkyiJ1jRnmTDxQiExnhN2f5Sf/qfm+s5PpPUADX5jeGXmJxzKDir3HmCu+SwGCtCVGP91BTHSTs9Y4QQJ+Tr5ErD58H/nGpPHNrwnUmRd+un3semqTMWg8oS7ooo3nwxvlUwpIVjxHicr3uzaxQyAsglF80557KPJYt6nqGUbBDvLGqxTEaw5swgssWcsTaHtfBdBxrMfp74lWOQVVLccwVOQ5XFd+0lIn9KEeqxnfyye6JtQejHcT7ntBLg8b01Vx2OBjxPPHEwxF17MEij0KB4XAfW4RFmuxqOxlgukCEbiKKS6Cr7mlQr/2SVuieebWNKGuB4GUyq40oWKvymKMUGc8liYfhHM4UNGk/H8BjDmTjAJrVnK1/OvWmqU0rjHpu9gho6q1D+cTCpTqffiyUMTSb0f1EmtYVDuODkM5kpOaORlD7SOS44l6Haq9EnJWQAFuJsd6j8ckb8sBUcoiyHjPIwVCD5Dne5Wm5XWzn3njOwwe4cjFCPggoK9YwA1uIj+VMC+L4tHghlIZ5rb4uuoremEUNx/9n968z2Pl0i6jk6xQZW9OWtPNXvysgmDe5KiEL9Q7x/fJAPCBO5ifqkigXd+RbR7UaGkq+17UbFaTr5I71AAptO/7baknyfX4dFqz7A6/8nOqnhN2newzw03/qB0qZVzur4kReuZFIwF5At/+SG/4wHfcQFP875y9h0pLIZucfX/2tMX41iubfyixte7aGvgNLz61/p5m4p2MvkIRwGlTZZnPgPWV7xaJKoRExhaG74uh110qTy1hqf86Yv2fnAl7Ms8NFxJ2cslVEEOMRTgr0DiEbL65ShWS/MFvhBEIzkEghL+lG3qIBGuAAvvsQ2oFtZNJUjHCJD4nV3Nrmw9BBRQooDWeFNiLPsPFM6GUS2kJExAOzA7iU9yJUAnARP4pYYolfK4e38TWGsoQwV5Wpkylx+y4KjPj7Yf1rkgIWOggA8JzqkQwz0/XDouUNzQ892SvmRd+2DA7vmf14e750EfN/pvNo0KR2FBQ3Ft5q7DuXuiOFOH293/rY2tYMItecbOEB/wtT0tsUrxKQHOsq36bolFSpTFVSSi1QpXyj0fVjA3sS/kO1juNV/DPM88dr9CbzzN4UPoJkDR1FfNSOUcqLhmw7yM0WsMHozb2LiMZb8uPzGDGslLI5T/Rvc2qF+bPA5NSjCZ7WT9dAq31Rxq54AT4D1iKergEvG/+wHd35qPS5P9uZ48tA16Yl0+3InxATdX0u4flP8sZXd8u+CgaIUO0/V2Iw/sekTy9XaCiUSLcWLMuWVwCtmn3BTN9X0puqSFpMbdowOkLGpxS45rvH5Fq/74sUncGQ+yBp3GI2jrCz4xAeuIyR/Ep2GnVR9KaNbtNJ0GE1qzd11BuZLZGNneghzTfS7N+6Uy9THHz4xaN9xdwjVXuC50k18kpiZSB1Tzo5i/4L9cRkTLODpOgYc2TG9mUyuDFxMy0qCCJH4z0LbaRhJ54z5sTWFGIZEUBmVduNgLeRYcTDj650MhUZT8FqqnArWLFmZ7p6ePHIr/FFGXnGm5yKtilIHFpJAhcLF6KedkJSJdhbZf1a/37Bc0qwyTPFcqclAa9AyLeOUZKUxvXG3cDf5dbz5NtOzHteT/6q5IF96wJ7vpGGFSbl0yoe+pFDjDSTkPJF40RRpJV+zWCNYSRNbYeI0RAFDG5E2quabMK/nXSOVpTvFv7zKbDS+ZVBqhl73YhdkSWJiOlyy9iRY32iu8CFH7wKRnKjd8gOXbivQBFteXWdjhCxrh68Ykp/Seuu66RxdAl315MExeYzbQi/jWV2uq/6kfuMOHWSP4DGumUsuUvIDSwVKiO7FZHgCsuKMZgJZFf/5ca+yXdAKRqixZiseGwfBFtyxwS0Mtq1tT1NrbFn622mXEVWBbTkqeWQmeFd26tCqD4WoIJJbE0giqbd29LHgIbCJosVDl2NVTAUEc8o38AOoYQs2XC/70B0OWFmKNedmH6eGQxXuJI3B8wf0jeJQiaXRO3Rr9EI6q/OCoktK/YB3FI1QLboXmOOIcgeJo5xZgjB36eTvTqeQUJlLyISrb0oQ7fjwigoj2iq2p7E1VDuN7e6t4mv/Y7tCF39Say6iT/tZ1Z2MpVOpPo+E9+hl7fKW/tWK2cVL5fDfEP0u+usWf54bu4DwJzX4zyVxGsxKCrEoT8cnKAvmBfmJoFsAQvMvxDgNZRknj8bby/hTi5VRnPGe4fA9hyt/kq8GSRnOcos/HnSgrZ7BblXFbYMaEJZHdhXQfhZUt1cHaCjC1TJlUVt+qBsFBPwC4abJk0GiMt4Vb59as4YrkUzKTSXiGBFbX0n9rxKhzFGQyv+oiBtHotka1tZ9hqk7xr1WWRuA9PjeWWsi68N8A8xImkzMpAEJ8XSuWgD/5S2rRMFprhKxo2xR1RBXDcorJpL1ILgJfaPGPn8Kqcn6KM+MlDaYzOykCQnzNGqcZ7Axq3X8VcXsqs3HuWqXvOJEst3mf6d0eHMrO01IZttRuCMAnl9xBbrSrtYChnPQSwdeIgZ/2l/qV1R61zrXrewEzOKrYxmxPorQPkr8Xe3XCaiA11EirXxkCeMyO44s51ymAyIBDTA7S6SZfQ8+uKfutcyiD3n9jVVOp42Zb35YrWRjFi/iEc8HjBtldNmE0TgUlmv46dvfOwZHuywx/k9f7gNp0p37wk31lDu5KpBabzJ5wqRI8oMpzu1x1bPIOZcby17buL0gkVy01nGI9M3apMW71rnh6rZMelu4pfK1RKfe/f5+0R3D2xPNdS7MZDdBxuL3dKGSZqzDNciZL8wpnOegchGVcyvmoKVPnIeuJJvW/w2lQMEwm4u+ncsxt3rSI62fYa8Rq/AzBxveeO7HiuSz5Cj2KJb0gY/UPAIRDz8CXbFriU4j8eqsRDoPprxqklnEkUCzs8p2lMsaEY8v63FYm9bmRAMRwzftBB0SsjbMMyLMBrOJmWRSjFo8IWkya4CHBgL9PtyJH2YQFluXguEX2xJp2GuLr2K/dwf1YhsXP23c4O4Vu6Gv1pH+jUIwiiVg3Ad89Cx0oV9J9i/XTtUhEZHZ6BbL8r89dDsXI8/8YOaIBV8PuXKlSLMEUUwebzCwTVaRsKla+uLqD38QqWco2AEbtIDaeRZaQ4EoGz2XvoO+W0FzbDwWPCAnxCnNGBFr++tKit/xlu9r4oNBYa+kQPQUe+XVJZGrUQhL8uMPe1Na/RfSgxdax0yPk+b+q/d0mkJEQ8jdWTP/70JqfXik0k/U+4Mjw6+mYHfCBuz1fXQ3NFIx9dJfN+G33NeJKBINedz9Nmiv7RqBgp9UPv0HmkXemO15vJfUL0lgNxojsz/EmhIBi9H+f8o5l9shpjp4EENI/gWtBFRakQZQV07/tw3QPKYQKB7XbP+yy0Zes2L2wgWKaI0CLqEWvmBnTYxkLbCC2Mq2/rYhwiBrIWtkws56sYAKl4B1s9fXrLxw7hzCrLn+GIrjA+2d7Xj64h1CV2zuvCP2ndfh/T3miMTmrjgav0MciMnzaA1p/aBbye3vvnz2kdHZ1Up7iaTwjJ010Zr1ChP3rmzr1GSHfUclkMsPoLvAT6q8Qw8bc0z4HK7OUestrMHB8+rz4AOPv+ujWVIZ3Z5wUaRYSyDb6cuBiM8foleYrfC5fx2WjFBy8GN8Du9MqR64cUv8zvtnV0NyZA7vczk0T9d+kL6zefZM/6DOM9c5pkodjtg65+k76kpzu+eGf0AnSEjI1mqFoZq6IRyiTjApohUnsITCGsSpLKh4e3UOrulX54Sqt4sPrhRS92tycE8wNvd/oqktHqdTJ04L+05q7leqlfdrToa+nRncj3aXh7i1yljRKu+4197BxFxbZmT3YwcSE+dx/dihSFMw7UFp3SlRzwlk9KckIbci1w1DTQvrYkqL2wdbVHvsZE+GEOLspJXWr0x04P069tGn/HLA7jIY5ZOODGeGEOYcobMTq7qSod4+vO8bB99hmpmdUZF8e7qUyq49HF41g2/zZg3IPGG+3U4EpJzAuw357eZsVUONM43kTHsI4Wd4KKadddG2Zb2aXn22bhfSM3GC49M5ih9O9/fnsCUemKzeTazbHZms+Sz5ZiiOTYS3EENbghM1b+HDi3N/PlGfvIhPE8PTL6HOf55zY8LbrknemONN1928g8ET0eAB17Jmy0KuBxgZQBRx3qLPOWfyC/PPcFAZ49NIm/oeZVkOg2XIsClUlpF54v/fcMjxrCrtwgzxytn1fVcc1SWvhr9+RQrUazMsAARYISvJSZ0W17qpKjVGb6I5yoSF8LYt0munxoOZOxyoVZWmR3QVekgR+enJqNyWJ5F6Cg+wADEbtlMvEZ+K7dsikLKdn0fpWhmSl9j850+vv9JKL3V6QUu62Q16gmj72OaoU/rl2PetcOvmmhuZZ4jx33v1eUvTdt7Wy9y0YaZXpWLi70dK9WVQHjD650+vL0T/Y6FuD5wOezyO8kQrsqR49YpIGVkX4RohVtLslW1Ce6vCpzs3RT0gLq3/Hpj06wGZiz7M8ClVpfiL4VINgno99nS714PC/dJyLqevfJ3r+Ved5B67hGyqZjzFcEhQT/Dn9H4rbsQG69rbyYIZS/n703/2BFEJw/FGjGFEnEHAWGgMAC5XQJDp0I4QhFRos7Rohc2GgmBXa4pmvbJNjt7oBlXfhx3ETW9heMtVLPx9SbvxU/ju9IZ5S96kTOaT8++moLdWsp/Vf9+kqFk0eV8/axmOiWgiPIud02KzEWFSZtaoozjBvDRJyI0xKmSsXbDGUpchF9lHsAUwIKmc85loDyLPT6Zd7K54aUXi1UsIHMGOd1/TjnYUZ6if1FO3U/rXPXNFmvKFINlcF+S/JACVLd1gBJmL5J4qs+UpR/+cf/0V+w9M1Iua041uwOVDHfaou5IO1uu1YPirT6JMa56ozFV4N8v6owk1u9i6d/+fDEudb4QZseGD01Gn6MaqV1uR1unIZ+k7iEnuKQmQp2j7Y/4kpDTbnRicbvd4UDkQgZYUD/cisjxSWp9VoJK5aEMMn1rFxB8Nczovr+Yo6nGRQwdfz6lHDt6x9Ltczz+K/t3llpCNUcZF+vUVpa+utbWPGEUuRhkGCMVscrbP5nD4Mg/MZo/YQKMGF8EVVissaKrkATFnyz49d9kE0l0VnexsqfJZA2Xxd6+z4EPyP/ult8kyhE4sgYWUy68TbjZxXVL+jQygiFfacPCpBqD0pl4gRSTpOSsJxwRV3WgVqTklyZwCXYKq4T0To9vi4WbSayGzDJEAHPm5V97noZJsrd1y6amecXdzubmZsrd1OeOAIR4VGow4TwMUx9TL7RWkve+WmezNPT32FlMheeCWm1QcQhJYlXvT7rWV2Y1ip1NsHPfOcU/w9/JPcMUnQRN4cmIfCWfjRYalzo+dRWRn1JlpOHlNUn7RIkouZZEIuXPbUzjzhfQPSE4OdRorbyNh49r+fLCAdLPAXcDQfAaq89cy8j5TJQY7c1h34xy2J2zadSDYC57uXYibKNeCO1syVBLLz/qCRD+7rZz6NUMfrZk0+xfmtxkULyjcFIwOS+SliB9i8Jp8B0MpCRuUpbfpKo124FUndXtlh7OEBg2ZC+OPb3YJphhrUs5HSoT+F7UO1oR+wFVzyP+AO1zZXDpkDVsPksnb0R7wT7tq9QOsiYLJFlFqp/2HPQQ5h/2HXDXyUT/evK7Y/Frqa2bR0K3i2cAzbxZPcyzUE3faKeXFHD7MhrxmLwSz+Tkvpkzq/z9JtXCmxQ+YH/eIxn8nfcgSz/CJ/Bkx60PS7+Miz+Nme/GtoV0++X833VnmVrW54Po6NI0vuKgU+28WPSRBzyROXYInk7ZAdCVesi28AQ13QVGuWOBqE40wW07DAbJ2tNnJbYDD7fWgHpvqDSjZbq6C62armZLRhQvK3e14qQX1eOoKWcAECYBKm4SA1CLHJ63Vv2Mn+Th98zpkXUH69hakBaZkPxJ5Xy7mPudwFEhl0RLpVwNv8iv+F/E7pb8ECh2YSlHhwEktXFBYfyzxe5JdL3+ckvq5lgPhxjL/kGOl77EDSiUJ70mE8m99aHYsG1VLllk6pVhINupxy8aYTKIFJ7C4PRpEuC9VYZ7ZxqlSGVUHyeQtqIq4H3UJB1bvD/jjqOKFFPcJKk1wVFQh3ilimN5mLLZKuyRVfBuVSbUJBCQwRc/HqmfTiBOy8Zai9MVKHyOf4VMuplv/CQShEqL9SBG4pS4pH6YbKcVpxRSu7oemo9+EZR/Lwt+sKQKsG1KsG8xFitWEAOPd791PJAQ6xs42lj5aTDzeJNdukGq9StRB83o43x/f0bkp71GaFQVMp/n6C/eILxctVZqEDzFE+yQ17mA8hONxlwuP4yE87lRL35QYJG9K0fFDkh7uOz9Mc7nTP7zDLfJaZF1SaZfMORF43r55/NTTQD7wtOVt59uBAQH4OPjmFWeWpT+z5br1+sfIx6plS2wGKXZSuiKCVbveusu2vXDDets23luOsVlH+a7ikfqDtamWbcV3ZwQCchcH85JJy3eFtTAIl3NfM+ZDxL3Zh6+MxyJl7HiS71zYMZhH78p238iphpMGfsUDD7sKEPTi5o2CdjvuIJleeRZ69hV3eBCBKQt6Hyoi7X7Gi37GLVvzdpMuoOTOwhPCrDTF846T/vDuR+qk7PVlG2gaaLa+90wWRoSnY+duBxueTY8ZoQK8AYhi7FkLJN8+wY5QJJkFO8poZR0girDgSc/CRuhFUpFkSL0LGrzmWFnb1lYbhGtl8rvUlJvKprVabXGcVQsJqwv7jO/UjMap3t6mqZqMNnOLlei3Wn65Vtm4/f5zpAlfCACJLaftBl0gNhnTBQwDP5T1YObGE3zCQn21S7HP4a9qvoI/d+RtBJT1SdbIRpj5Y/nXMuFq284F5ZkCagL2HskHxTKm55kwQ4u1mhd/f8VZVmFzAx5RLnDhOfgSJ4/56ciNt0lrsGTh0gCxy6ZcMPqUECmph7k7GexQZ31darO5GSI26gPfz0CS/D9eF8Kco0xOtLOtKa3ZPDai3GjL/P7i35Urtc/A5L+/BIETTmh2bhaeWhisvTxI3IVqL0/BSt5rQx2PIxAivHpH+qBdByqJ2BPfPoElhDMBUy0yx6GDBw4SSb//VXyGfY5t3UKucLic3pg3YtGA9/P5Z161DhzzLGJI3yKlVFrZAq9vaFC7uMSuqJLn/diaje0bOpvkMVUOA5zyrk2bWaxY8UgBrtY9I8sW/aeYkSkhlP0EG1VCN4zZvL1HqKHa5ly0nc3LpydYBczPRgtF356LTr5cmLc1J+ueex/OBKszG6d6BIS3o//562Hjj5WeslpKL7BlfHOHPsIxgsw6g8E/anrQw5GbfLph5ZQtvrsBrqm2LLFL8VVLUUutdeQy6Hd5Ea/fBUJKvA0UUo1i/wIK9pfEtOKh/GX2kqfN7gUGxyXi5eiXfvU2Vv7xtwzAsmPleeiCXFiGhNvDh0kIHuN/slEZVFZGTybKrikXA5LWFAEeFN7LR3IbzKbcJB+5V1hmlTFSgqBI7HIODWpvl6CKqCz3MfQjbF/zFhXpXHN3F73ONsNn9kd8Zz9uTl0ej6u5PlBTTzXaIFssbLGXgDX65hzowmdZT0w1Pe6EnCQ1JeRysRT1TSvbTHLjH1LulGEYKbRZLZ6Y06/zcm5Je2Z50i/EtAtbNl4BV23jIVUOz6J0f4XLsuJgjm+aizvmvK8E3bN79m8qfmPWC5/85QB84O+T8G3Gyuaeid4tthVcma33AmmpjfLymvO8uRlge1bLxSPcnVH6m3yYFRPP83I6mr98qxo/mbJOpfVIyNU9Mt/DhqaDxav9v8zxsdWkNjzCu3J2bOTWYZ6dw6+I3RcVYWhZrodK14xfOHeO4tdk74rHLUiRFwoNds7kCBtqic3hO04nmtpranzFE6f3f35aM6NQK2Y0p5OJZ17ETFuGi18QQMK1yHDi+oYlNxmuh4mpwQPrJDYX3FBTPQB6F1errvF2lktESkApkgxbFnctu7qUvPTqsr/5+AW0vGtJm/bulVbI0lBefRHNqVjb+kwWNZWSxeKUDgf9vvQPGWbAqChTWw/VO29ESkr57iJiiZhBH379SPr18gpUKeW+8+erAqpQ6a606d4SffLGOIffQ0/VeaSqbh+KXlXP/B76S6/QowYdce3jEx3TGx9eehfxjUq2GjZq9U4Y0jxTsvBFNYcfZJFYQT7lk9PazBufR6Q20OEGhSXwPtlWnF81frhL8eQFvgo0avRu6M6vjUNyHG535GN0l3k/pB3KUW8zmiQ2xGGUcV8UEt9xsiSgymKBp4TlfIeon+fKmrnh92D1EjV87A2d4XdRM6hd/OxwAxflwhJ4UrYVL6yKulhPbTMVcUGAzeHe0j/oU4nL5mNcQmpn9QND8dKwK7Mp7e3tKTRiw2n9zjwUytGeSPpP0AjUDrYDSS3nNZ53hnHi2tuXLo2wORYMkB7maoGgN6TkfSIxST7hDa3cOo+WcPivXjd/oO7LaNl4hw6iB8t/rn7o/t6qmJyUd5pC+X4vfOSapmKTUOxzuysfKf8zwm1U7/vn40tSFn1pUVqRtpRTzmF9tSwt/y2KfNOOkniZ9n9h6cSTxN8vc6SQZgQ5PWOYei3wkVwht5p6T6f0neoQNZaPvrvwVCadWUpNoZhoRQ+O2DPmX1YdTl9OOvYXS/ZGuQoEgmWNRtBu5PaoZ2sjfwgi+6PYzDaO9IRCBQEX6GYqmWqmD+63SNuGtVbd8j+0K4utFkmj2aoVs4dvEa9o6PxXKipe4dM1V4i3htnilrfpGfrXBWkFX9PRMm03k1K0pIjC3NjAm+3fetwPVWE2VD7p4mPe5l9cQmrb3sTnlW1d0f5IbbC0O6n9kKpSBpBJQhovbw0/zvIkxX9rxdLMZQe/T3vtZc4/mWsPPVEMbd4325h787Py9zIX6v2FcNJyVIefQtmcua8SyUV0nNp/u7feXL4K59ndJrEUH/6xBCk/Hi7OvXqp31MKKd9TF7Px6G4+762UW1+ejT0rLp26KJgV3NK2ZvyWf8saRcp/TSQ/vHM0U8FnJ0b9ViH55lTJYCF8cAC1UhaCUXNrXlWt5lbL/4701Mi/Lhe+PalR+JQuoovk0k/ki0rtAHL5h6x+uQ25Vqno/yHVqLhvYLKeYvIb3tLCgSc+6KDjjviFCwee+KCDLnTEABcOOmnfEYELB510a40I6baOqHDhwJMOutQR/3DhoJOudURFg9Z44cYXvvGDpqO3s6D7J6oYuPFF78Bhz/gwPowP0xP0DJy0wyfxSXwSn8Tn8Xl8Hp83L1M9Lhrxu9cg0Ihb06gIYOrkX4AVdvgTplnRDCnCsOL5f7C2tIMs7LLGvksA4Wy+BFZuTeklBzqQcAb57OLfYQBmbG8CYFQf937+zi/952MgkC6D3f1zGdZRD/utcCUHp/vA7sqEtXkpq+pzyYxvUf2ppbLcW15sUDR9qacuQgCF7w3un8u8sWfUnxmXdWc087Ov813OD8EZ5I+/DEHNvNcbhSyXmqAHgb+se7waoZaiZwn85Swqvjf/kuu+VT0UVQ8R6uWs1xPlLueryB4E/rLucbfuWSbo4bkGoPa2LbDLZrXDnq93U28trp2yi9GWCLvMtwuk+gF2mW+HS6T0u7uwB5F2WRdlXQ9IhFAyu8y3i4eVQJ0ClM8+WTsv3H+6/cAZwcz9phxeISujkstKlL/mDwwh0ZSpy4KZ/AX8ZDs4cW072DSvAUw6eF1gPn4MYBTEA93F5pt8lWwcOMQmVlTWS6WsEXOsnIDb38RWZvitwpSujqlos2kRM5sbb1cnuXqdCLoCQMtBJL65BfwYk2pX5Ew7a4SbmCGv5o2claoiYPjd2EIqfldakq8KVB5LQk2kJbvdJtkuydQMbJPFchXLoDplWaUkDhfK9obwfguel4r0DaG1HldkHMGqr1qt+EljtEMDMVkzdpOWC2Gawlf9pgFRjnklKqIUvu0XzazHkhmqT9wSaRIlRf3InwEQj2ulrsr3Aq6x+C2Ad/x6a2FfC4sebwH7d2tIeXtO/ZyeYfKL3ruuqckIy3/fMR7PCL3eP5B4TsLavYWN5uj2j9iXt765ZR3Pk26hnXMyxvHmbYxi3kWOTxhJ58gxulhQ02yUVKAY64zqEJoKzywTgee6BoWO9uDGDqwl31cbdQnAZ/x6ymH/MR2U2CQsVII+cBG5KZI5gKQ2X5qDYzjJOwgwr72Dd5beMe+YCXNzisTcAOzHLV+uqAYSxNs5pe0puTXXc2hoWXzp0x6sXGSGRqYde41JU7BIcPYfCVYA2L2bobfde0DLBzHlkV5Eip04cgWcz6QrAyJxjYIP4iQ5BIyzIJg2HCJYGCwpOe0OKVLMl7pN9cIGQPOnFiLIcczObs8WQKJ0juL42cJgOZeB5S9DuUUNg7MgqtorCmshmHau4HgHZjvCLJFu06RHhFTVF2owP9C4gOjCDJVZzl2jBhS0B3J9NmbmBxCBeByhrLygElwdQBkAmtgnuaBEsWX1V9CnWMh3hjFYN7BEVTOlE4EgXq/IW0rNVURLqDV34nQh2XACAoFoM2955kAATpnfVvewriQjpniiMTdOrBmJc/n4GhFdhI4LCpsbcbexLbzle2+UvYqoKJ6OEdF2SlktAzWmBWAIpkhg6jML0qiIr4c7W+xHKx6fgCA092GMuecYUnqB/h2rLoEhK/NUeNSjtUBI1j4txsOO6Lm1WcCQdjm3GSE2/QHICZKxKZ0eGGEsC+I64PDNnS7u2ATQ12GtXZ6bM5V1DnexRR+JovIUNt0G+KfYFezMquUTTnPYGtdthG+ZuwN5VdY5NI8qS6uWotID1OPMwObFNfl9fwquvKqHA4ifMJhiyAwLs4Pg10gP0UJZ5+fXyFArNRs+YkIRAlvQYVEkJnhiALeBOrwdc+1UYQQIhCWyQsBykjPnHZw3uCAl7D1ka9TUBWvYoE1tA1dT+aymqPDVdc8dARh0PY2l6PHVu1SAs7NqtxM2f9ZsQ1gML/W8QNDJ9DO2ecGXEB47V/aw+1akzcLFiH6vdes0E2ludzvWjOdUc0qsERMqA8FqQiBnLSeMPEUFhUG/AoxiusJYhaUU8wVhGmTEkCmEIyNVFvpGzmfjgaN2rCjQ9rWR6pDlfHqaszpUBS0PhW3rqa1stGTiiiVwwScTJk9KkclBwuldfrP0fZFtQgFTdnhxTbaxb8tKU9HL+0irn6YojPiB4WYmjzVZ7RahRZB5JSkLGqWJAuDEkVKwbJIwO3vltDXM4dMYEtTdmGg1gH6laucS7BHmunCDn5lzTJcsskpG62Dg0aFCSTnlYftXTk/eBB/7IhaY2CIMkh1hQj0/odrpJCEnT1p2wMPKALCCQD9GAA5qPCUkw2YdVjtiYAE1YVxDAwX4dQeToMKSLACfZRs3Weu2CGaA78UzLSGEt/0tj+UQVIUyrYy9BOWsqnWCi0Z5lolpXLi00YFvLUY3JlsteGybHGYAfhpg34T7PPeCVfADTP9YTeiTkKxJtiLQGgFEQZdHfP3ccnErFkmMUnKBCdbpS+ZSRfxouLuGBc0nwhVxGUBybVz5yjV57R4N/YEr8MCe2QueAefWRSCw+19duH1csqW989JFKGIORH3hiaF8UN2QQDz/GtybuILyNCwQ3TTq6NLGllZYBZfJwWrx/bHOeH7zYBbQkSmilLxyc2evE1RhuDEQ4qUBTAM/yy8LZ2zU4hxiUo6ISRmrRQBYvIyLujeuXNsm3pFZj4GJj00zHBwz2h/kawazKzi7Qe81aQKCorwM/WEXq7kL5aErObvIf7lcUHDRWOMXoKEL/2PvQp1ov7mvp0V/QQr79RwHmMUOTOtSjCPKZvLv4TIy6OjY7acvRUmJzVZdSWoAXbIWEXduCNjwie+0N1E06nxHKlvqBRlABxm0PsQWYYway7EclZQ2jaN1Dm5cuB331Nd61xyeC09F4hlzsa2x3PZtw7tcBV6ox9V9AO69kG5sxQaSiWerd37IfLUmgbiKbXkXk/v5vQ+mhlyvka/FlOwLiNGJY2V92Coi8SvKjZPUYrBVG0+9Vfey+Vu3w3hFyN7hF7KTAzpx9Gui+P33yCvCt/gFT1t2xLbyH0Xb7YP528aGBfKjfO5jvuWZ8RwWpjmIjYOtd3FybVPvHd6KzTJ81QaicGAnx3ZlNA13jOIt72KGlmOwYzUSkMosXTURb++mAGgAYAfJH88BkPXDQ4eDLcwx86KXaz/XP892/yr/2eIl4Rv8jNf4zxYfsvSkHsfjxg6rjeGxwVvg5fXTuFyXqezJ0ok96T1xydbUBkWgTTm8VdqsRFi4dcs+jIo9AURsZ7vNn/ZOjiyd6s2BGU6kBwAk3b7XY3zw4tHYQXOxd0qPrnI5rR6Z1GpKZsw3Qke8nDcuHS3LVV/hQP4A1OuE/TR9j8ivF3ueGte+CBqWZxeCkZdzRvTarkMPZA+fr60SjvCaTt9brAZx7bbO47VN2sSZ3YJzSeHVwmALwRKcP1ZO6oiN4QU+MdABGao0hy8x0zxrheT/Esq5wdjtPRsS7HApyKnh1vZQJ+DqoXun4EAImhruxwEPTf3TZEMnrslv+mqqt2rS3C2LhVC7BV5UUjA4nsp4AtsEU/IJ+IZO2ZG4QwLNCo4ZPMDuXboQAbvZyvYNmNIORy7cuNX+TOh1URJfWYDtbNBhH0bGsZdTAw5cY4Zrc5UErswQwPTMfM2ntc8I+DCFVQjIwDx4IheAhPyzsNmE02jGXWeA1a5bxeQWEvZzEB04PVpja7Q5yAYL3vlW1+w6NMq/o1l/RlEC0KMDmMINSfYQcmCohdgG6wjM7bdi7U/lt/u5wL1eUM1Ha2xpmwU/QdQ0G4am7YnF41SzgyqCwL0u2qKHFrjh6K/hukHjTh8/sXTjNFw/tmmKj/xUOVLctN/PB539UL2ZvLBD0nfXhi3xKPARTwcE9A7skvi36xjKuzppNq3Ahs1+pc5Wn/zD46QwefDvt9x55n0t9n7G59P9hGqZAQzgn+Ch6hIPeRuSAXHictnueJzn4GYrevHuoeVjB/Mw59ji7raeKHeH69hJqvhRHw3qk/ceCOnpcd65d8njObFL6HgrUoBofImPV6NvKfqF/Z2953fFk7uF7N1EvUz/57DyewFGntEdPMO+1Dmj+/o8jNAJkLU7Cebc7ePkzq0Rd+YsOXLnbDQuToTq+b4ScNjlcjbqSUvuA7yk5bDnqiItAIADBl7L7Eg03IrNwkko6tGNsxHP8bzqwr3sgTrxBdEN6eadQUzbxNGtmo3ZiFZdC4xHXCm0UVyxVgYM1ejhAmxT7nWXPqJKGVr5FeqvgCk5TQCAm13/GcZGpz93RMIK/4fhJYXWAqmO3La12M2HjaPQHrtwZRYIEDecVpS2jRV5EKHde9XXq/lGrE8NtnN+z/N04CpzUqrjRjUjm8CnqwRI4ZQIVs2O54fQjivWiyEnFzjJBwidsSSWUwTfYNFfjSlrdvrzq6JyveVaZacSMqMOTUYh2ozKm/NSuhjamuAW5yn5RpDeoji1GTA+75910B0sxsldWSuhhNEdJbkSChZYBivWqNgqJw6Gy1NDj29qvXNgWF2BgssvNyzqvWE6a9gIwrvDZHm8cqeX49uDUiVC3JFjOkqzy0VQIQ852NKwrsAGKQekXNxXa+ndg54AKSdHxfeY6URN0i+GBsVyUY3ZVqRqoDPUb/nmdWDprZ2Wam1/esgXFW6/qZx79XVV7MFD6ItTUQzSlgiacwtCZcEH80pS29Cf46miUncueq2olCL3BsnRFTXyCvnsE73LAg1rcr3h8+1LvJPEPT1h7cT1pffmyM0H1XJnHhiWDU9ye/YnzS+4AFvGALbigmvbjZVZcG23qN1MrAlz5hxMx3R2kePoKryxCT8vSm8i5+s0HyXUwc6XmLtdSSVyDNDBuuysJtgZ+lgWw5cZF+VOo5osSCwiVjQBUiWgoR0sVTqAqGvrYDxsIrYcvVnmYYwD5JntNj3KkpSq5BMKDA9Ll3EsFsLS7sKqWlt4tTEPNTMyALThKrBcfrPbrZjQ7kPZ5vYoZYUQM4b0qBQ7ynzMi5ANrnv8lPd6NpRVfriEoB1oqk2IhhJS5PoZlFDS2TGayqYSv9QXUFEK3upi1Fp4q6Vo+5JjZySouUWL93kiepSEBiv4wkU7sF6jJzYQ8MDJ71mPmVFr1SY1vDkadpPB4+J4zJ5gOctZawjXMXOJTbuF4Ykw2duJapatxJ5l1d3R52fp0zVc8Ujk+GlDVT8b9jtaiCOV8qlsnJvBm0aL9tKOWj9rqc9VfBOPukNMWzJ6A4gRGGOc0Kp9Rfvz9lkN5Y5YJEBYOdZg3wRIcc5a1QicLx/HJY8fKwGsNqiHTE2p1gvYmPmoHPZSiDBQwJC5AmM1X+VmWSH+41K77uwTO4OeUXxamsXK9oMOZx+a8psRXXa8xKHRvvx5sccih2abb3dqpewP4HT/+Nev/aNdeZPphFks2CrPLXqoKoensGLTe1JjB9o1ViUKaTg0FNuoLJr9ydGd+3mi48OP1cuMO3YqkAiUNV30E3uEBIlJMGJAI110r05NS48M8l1V69XCtcNPABBuQc1gEBePT/jNMYRzU08jPcCg9q2zVqXoKt6OV7tDVi2gdiMQ7VYtiaGsfHBIaisqafQgPtBDJHvXmqXKwOTBIEIJcAtVPPx8pBfhGYrMlSZCKoM4AL3vzmIprT4hASBtMmoaV62pfRHVat1JWhlWbYJpMC2KKY6yWb4+jtgxXGTYfXh7izgBWNuoO8/7K0QZhWOzHjwjKxRMpbjysy2Su/JeBZ9BYAY3CCwq6+yWAkF5Rd3nrdS1PxS6YuDAav1PewHcnqte09grbgci+yjkvPSqVr7E+0DoM3qu9QYAQ4eUopIYwFos7jxcAxS7RNYgFCYWAAJLVS5M1WNPqxZEZJAiqiv3ZtS2t+SSK36YzAVcEyZUK3wbTZnKw0772VlxJCxhZGzyd3LZaohrHzeM9oTV/7SFzKiSODH70UotFHpfC9slSBdq3FQWbnzcYgoji1AasXTa8iCOB/HiQ/XKbEbcLZ82CzZfYxL+FC4fUHuNdszXYa4PAFoF38lHHfML3nTMzz8z6ZWZ62FYMHJYy+5st9txUF6Dmp8HTGhWAbALDomtEcA+j3lYrjm6fjM8iG9y1GldhS1TFGuYAmvbr6710gg6H/Y65h3NDdiiHev9xO6TV37qn6J8ofd/KvxasNaMvt0otIo3mS6hCcswMmIMxkowiyiwMwRg2C+s5QpXSFk/w4s42/VW1+LS8ldEvCf7BQUBZQ+KKBs61BrB1DSyepkO8JrPslUeNCKndMGnPTZn4FgRnoeFxShBMAFk9JZ13ECwgcCBrSIdsHqVp5eUQkxLIlmseIIX2vMpJjbpT8FQXBAASTwh91c9c37e1hTH63gdT/EUT7ZPEgsDkn0rUjLY1YeEqQGYSX5MRKI+f1IbTnatdkoFnXzUMb3ATZgDX30k2hkSlhzWJp0JyPrdatMTdAMw4cGnS2911DFtM4yAJ/8QZitHN/Saqk5qLLq2APU2Xtl0f67JecAzbdJvv35YMkuf0gGO+eww6Doo6AOKfVdE17LL9VpbWM1XfhEevhYmlD1sP38anlR1OFs8iVSpISM/2/4bAmvnYDPjnUDvgOlSjQmyQ5O8HOO8BnGLoBWDbB084Ji/yc9QgjB/gEGCv5hiz8Td2ZPYtRPyoJxg/k21D4ymVJTwqBei0hgiRCZaVgUDlOZdCNf3xU+/BLDu3zqQblgyPFZ+1o094iAw0Vyb8t0i8ntfTpwMz+PT+p6WJvf0MPncBS4G7dJEiBXwYWkeAkU/qs7oH6QQqPBfXIzYflfB9+/RIvoc8Ov3d78XS/7W51/8/1u6cJuGOIIxCEDAEOkbqGtG9JuV0sW3Z3NlYun6fIoNaYMRccVXANUhrBENaEct2oCpVqc2WxitBwLUwAoGTNAgBCaiithobAo9MODqpGFEIZ3qkUlItUQPLjigYBkU0/opNArowIZDrarqVtOGDEYN2YEFj1qlmoASmHU/VQkCn9qy/ovT5UWppxDO4zo+QgDd+iJwGs/ACVA/BWLw4Aba8Qnits3GbG5EOH3RkpsIfn5AwCByMIktWAuJIrA5kELdbp6OrjQEfKoPqXADV8QO5ShUvliPbT1GLFXcPAvEWu3zGtyqXCILzaAhPqtGWM16mMgHYgs7xTrhwDrpVQ7l0WdhAsvQgP3YhyPYjV16uIj7ceCgDlJwEqdxTk/o9SGRyYM6k+0nd7rfbLPeFSbuwx08irtxRd8whfTZ4xcffmlK5TtYq5IKAcaCQr9Fi8vrSpEYbdhcpSHHLi0C3mmjL2h6MBcjYAvSkVi16ShJhtPRWMfTMVxcSsfRCj8dTzkG6QTjo0wm0s6B2wT0FhD7Ji1QiSxtoFTK6QDaZZKOALXye+pI0KxkKfNzRQBuVDVSpF2HU0K+7qaUb72eZrKUR7tZpnzqLTgVWNiihbBlf6Yi5YNiynIeuFTCdFieysVwOJ3Kcx3x+oiK1pGGz0GA5SMnC6DdnhIwH3k7pWA8iqQMuI4yTXlgPSqTfzgfHBQZte7zUEA6sJDAme/PIqz924yYU5P/XfTAMPKVFgdYWWO/yGmuakxIvXcMMxAwlCrQpnTKEnxPeSd5/oHygH04h69nwPv3+ZJY2p5IKlPX9UkzHr4CB9wmO8djH6Fz9ylVZlv+JHuWHSZiOx2kmJlPSf3QvuzEfmN9rx0l0+9OSLMRkmkUMxeQvqLvRruimcKm2giJM/PfYS+fLKhPGo3223n6ifLYHbXfJgvPhiWJNxFK0tqp4Of1orBg/xowdCEE7XelKPgONsXHubycpFquf4xsUu2QBGdwVBKk1/fEjeC9X4beCrIpSirWdKk5+t7IInyzoxC4XSEFd/6rjjgNDI+vdK0V66e7vL9TacjKHTmKtBGAKiLRAuYGVoBQuPE/jYE+TQOy84VCMESxi3dysd2/8oomHIAVy7BuCFJBQ05VjCDqevQsz0Q+nlWBe/C26ynTNLgJ244PZ/QfqNAfRiD42xCHyxwX23SYteZAy4110rII4ILjjmDYtm4cR38UHOG5nMKEMNmf2zu6TePilM9RbMAqGVNfjkNHK8qWAPoo6qFbo7x7BZnoCnbs1/FARiCFihC6HkK0GWl0w/JhMhPOdONTg1zX+Wb2wxgNZjobdxtgi2TkQo0+Mw/vbPh1E2uOruJWsHZ7jiHE6DQ/HIZ6LlFkjdkNNrQvujWXApfyQdnp3tQa5bHxgYSnCkEFfObxsMGSU3HmKD8OOolDkGgZTfRdr7oa3TFc7Hqs213+8HCx/10t7vBCWr/6SxMpvZjVu3sQq+6kL6iMmK1KtO1m8vh4qgTWHIxUBmh+iHLMsHN+YDJ5+FfBeTe1jjLG+SDMT3YpHDjtHYLdCWP7RTOk0wXdeHEmVKXd607SWXuH4VcyAiWaOcDFgjcIpjPDIZQdCxOF1G7wgHIyNlUxpsOnSNWxwry2LCdbiT7ArjJIvZXxLdv5D66c3RkCVGgohEF6WvlTcYZBHsRw8/DywfgFBOFCwiKiqsRUq1GLy4w5C5asWLNhy449B46cOHPhyo07D568ePPhy49K+CgAVWrUadCkRZsO3V46/spRARWjFOWoEDGhaKNNgi2zih4F+sR4ttpmsy0OO2KvfVZYaRHGQsZYEv4C1amXK8BuQkcV+Fq/QSOGjTbHXD3kdDuIH1VBErK8M8l72xkyYOSQAYvt0ZsCfQSm2u+AKh06tevWFfVoRDNa0Y6O+Rp8q1G/AX3e0mrIsEEjRo1bYcwR/3vQUGjeardGlw7f2+mEY4qdU+K88Uqj54UyzzrplNPOOOucci+7oMJrJlhnvTcuu6LSm14559M2PZX812ayStkcLo8vEIrEkjKpTK5QlqvUGq1OX1FpMJrMFmugzedgyBdfw5H2aEdnV3dPb1/MDTeNNQW87o67rwcG40PDI6Ol9q4wihAyeocx6kCSd1KOVT++YYjnlkhjH1aD9etvuXa4qLhYfW+NGE69D3td+vi54KQOfugvbE8+qXaUpleH2DtaHcdkZ3XcNMq0v79F4VDV1l+Pi62fEVkRhHL1B/4IGL0/tmrPbbuOXIkf7Ugn3Vdb0uFu7BP2wLZ3YysozUe+y/5tGRpO9eHc2xFz1mTLTVfJk1pEoo4GmmihXe5U2gQJqqihjgaaaKHd7twVTMSVba0lQQjxVGAuEERcCjoVCIG53DNFWEJLghDiqcBcIIi4FHQqEALz2JScNGoSdTTQRAttdNAHwQBDjDCeSD52L98AD6uYYCGJPUhn3DuEyyaSWEzOvsJcD6DJPpGPjTI3MPoOcVnPK3cpljc+8xadUSsEwJ+/9kBjoxEob+hn5DdcDLaSHe6yfA6ktpRhHvuj0JjLNJgn7hz1506E07bP2KgMLuapyao7p1zcxRxamot5yjz3Ces0vLC4y7E1UwhJ5S7hH39Sy0ao3Cx9yOxAFK75/5ooPAK36jtDYA/Q+8k9fZAH/bnkuR/u8YDneNXxqJ175AcFNgJe4hVe43l4pqj+ByXu658Rgwbuj2f2kkillPRaAAAA";
