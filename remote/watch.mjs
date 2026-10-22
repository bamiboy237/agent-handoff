// The handoff's watch link, served from inside the sandbox. One stable URL:
//   OpenCode  each visit makes a fresh one-time pairing link, and every request
//             outside /_handoff/ is passed to OpenCode's server, so its own web
//             UI runs on this same address.
//   others    a live page of the agent's output, with a box for messages.
// runner.sh starts it. Every request needs the handoff's key: from ?key= on the
// first visit, then from a cookie. No dependencies, so any Node works.
import { execFile, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.HANDOFF_HOME;
const PORT = Number(process.env.WATCH_PORT);
const KEY = process.env.WATCH_KEY ?? "";
const AGENT = process.env.TARGET_AGENT ?? "";
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT || 49374);
const LOG = join(HOME, "runner.log");
const COOKIE = "handoff_key";
const BACKLOG_BYTES = 200_000; // how much earlier output a new viewer gets
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
    return buffer.toString("utf8");
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

function streamEvents(req, res) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let offset = Math.max(0, size(LOG) - BACKLOG_BYTES);
  let lastStatus = "";
  const tick = () => {
    const end = size(LOG);
    if (end < offset) offset = 0;
    if (end > offset) {
      send("log", readRange(LOG, offset, end));
      offset = end;
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

server.listen(PORT, "0.0.0.0");

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
<meta name="theme-color" content="#0a0c10">
<title>${name} handoff</title>
<style>
:root {
  --ground: #0a0c10; --panel: #12151c; --panel-2: #181c25; --rule: rgba(152, 172, 206, 0.12);
  --ink: #eef1f6; --ink-2: #aeb7c5; --ink-3: #7c8698;
  --accent: #6aa4ff; --good: #5ac47a; --bad: #ef7b85;
  --sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --bar: rgba(10, 12, 16, 0.72);
}
* { box-sizing: border-box; }
html { background: var(--ground); color-scheme: dark; }
body { margin: 0; color: var(--ink); font: 400 1rem/1.5 var(--sans); -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent; }
::selection { background: rgba(106, 164, 255, 0.32); }

/* Floating chrome: translucent bars the output scrolls under. */
header, footer { position: fixed; left: 0; right: 0; z-index: 2; background: var(--bar); -webkit-backdrop-filter: blur(20px) saturate(180%); backdrop-filter: blur(20px) saturate(180%); }
header { top: 0; padding: calc(12px + env(safe-area-inset-top)) 18px 12px; }
footer { bottom: 0; padding: 10px 14px calc(10px + env(safe-area-inset-bottom)); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06); }
.top { display: flex; align-items: center; gap: 10px; }
.state { display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 10px; border-radius: 999px; background: rgba(255, 255, 255, 0.06); font: 500 0.8125rem/1 var(--sans); color: var(--ink-2); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-3); }
[data-state="running"] .dot { background: var(--accent); animation: breathe 2.4s ease-in-out infinite; }
[data-state="completed"] .dot { background: var(--good); }
[data-state="failed"] .dot { background: var(--bad); }
@keyframes breathe { 50% { opacity: 0.35; } }
.pr { margin-left: auto; display: inline-flex; align-items: center; height: 30px; padding: 0 12px; border-radius: 999px; background: var(--ink); color: var(--ground); font: 600 0.8125rem/1 var(--sans); text-decoration: none; transition: transform 100ms var(--ease-out); }
.pr:active { transform: scale(0.97); }
.pr[hidden] { display: none; }
h1 { margin: 10px 0 0; font-size: 1.25rem; font-weight: 650; line-height: 1.2; letter-spacing: -0.015em; text-wrap: balance; }
.note { margin: 8px 0 0; font-size: 0.8125rem; color: var(--ink-2); }

/* The transcript. */
main { padding: var(--top, 120px) 18px var(--bottom, 110px); }
.feed { display: flex; flex-direction: column; gap: 10px; max-width: 46rem; margin: 0 auto; }
.empty { color: var(--ink-3); font-size: 0.9375rem; }
.prose { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.9375rem; line-height: 1.55; color: var(--ink); }
.thinking { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.875rem; line-height: 1.5; color: var(--ink-3); font-style: italic; }
.code { margin: 0; padding: 10px 12px; border-radius: 12px; background: var(--panel); font: 400 0.78rem/1.55 var(--mono); color: var(--ink-2); white-space: pre-wrap; overflow-wrap: anywhere; }
.code .cmd { display: block; margin-bottom: 4px; color: var(--ink); font-weight: 600; }
.code .add { color: var(--good); }
.code .del { color: var(--bad); }
.code .meta { color: var(--ink-3); }
.event { display: flex; align-items: center; gap: 8px; font-size: 0.8125rem; color: var(--ink-3); }
.event::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: 0.7; }
.event.good { color: var(--good); }
.event.bad { color: var(--bad); }
.event a { color: inherit; }
.you { align-self: flex-end; max-width: 85%; padding: 9px 13px; border-radius: 18px 18px 6px 18px; background: var(--accent); color: #06101f; font-size: 0.9375rem; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
.you.pending { opacity: 0.6; }

/* Composer. */
form { display: flex; gap: 8px; align-items: flex-end; max-width: 46rem; margin: 0 auto; }
textarea { flex: 1; min-height: 44px; max-height: 9.5rem; padding: 11px 14px; resize: none; border: 0; border-radius: 22px; background: var(--panel-2); color: var(--ink); font: 400 1rem/1.4 var(--sans); box-shadow: inset 0 0 0 1px var(--rule); }
textarea::placeholder { color: var(--ink-3); }
textarea:focus { outline: none; box-shadow: inset 0 0 0 1.5px var(--accent); }
.send { flex: none; width: 44px; height: 44px; display: grid; place-items: center; border: 0; border-radius: 50%; background: var(--accent); color: #06101f; transition: transform 100ms var(--ease-out), opacity 150ms ease; }
.send:active { transform: scale(0.94); }
.send:disabled { opacity: 0.4; }
.hint { max-width: 46rem; margin: 6px auto 0; padding: 0 6px; font-size: 0.75rem; color: var(--ink-3); }
.offline .hint { color: var(--bad); }
.latest { position: fixed; left: 50%; bottom: calc(var(--bottom, 110px) + 10px); z-index: 2; padding: 8px 14px; border: 0; border-radius: 999px; background: var(--panel-2); color: var(--ink); font: 500 0.8125rem/1 var(--sans); box-shadow: 0 6px 20px -6px rgba(0, 0, 0, 0.6), inset 0 0 0 1px var(--rule);
  opacity: 0; transform: translate(-50%, 6px); pointer-events: none; transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out); }
.latest.show { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }

@media (prefers-reduced-motion: reduce) { [data-state="running"] .dot { animation: none; } .latest { transition: opacity 150ms ease; } }
@media (prefers-reduced-transparency: reduce) { header, footer { background: var(--ground); -webkit-backdrop-filter: none; backdrop-filter: none; } }
</style>
</head>
<body data-state="warming">
<header id="header">
  <div class="top"><span class="state"><span class="dot" aria-hidden="true"></span><span id="state">Connecting</span></span><a class="pr" id="pr" target="_blank" rel="noopener" hidden>Pull request</a></div>
  <h1 id="title">${name} is getting ready</h1>
  ${opencodeNote}
</header>
<main><div class="feed" id="feed" aria-live="polite"><p class="empty" id="empty">Waiting for ${name} to start…</p></div></main>
<button class="latest" id="latest" type="button">Jump to latest</button>
<footer id="footer">
  <form id="send"><textarea id="text" rows="1" placeholder="Message ${name}" aria-label="Message ${name}" enterkeyhint="send"></textarea><button class="send" id="go" type="submit" aria-label="Send"><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 14.5V3.5M9 3.5L4.5 8M9 3.5L13.5 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></form>
  <p class="hint" id="hint">${name} reads messages when its current turn ends.</p>
</footer>
<script>
const NAME = ${JSON.stringify(label)};
const feed = document.getElementById("feed");
const latest = document.getElementById("latest");
const states = { warming: "Getting ready", waiting_for_idle: "Getting ready", running: "Working", completed: "Done", failed: "Failed" };
// Codex marks each block of its output with a line like "exec" or "codex".
const BLOCK_HEADS = { codex: "prose", thinking: "thinking", exec: "exec", apply_patch: "patch", "tokens used": "skip", user: "skip" };

// Keeps the transcript clear of the floating bars as their height changes.
const fit = () => {
  document.body.style.setProperty("--top", document.getElementById("header").offsetHeight + 16 + "px");
  document.body.style.setProperty("--bottom", document.getElementById("footer").offsetHeight + 16 + "px");
};
new ResizeObserver(fit).observe(document.getElementById("header"));
new ResizeObserver(fit).observe(document.getElementById("footer"));

const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
let pinned = true;
addEventListener("scroll", () => { pinned = atBottom(); latest.classList.toggle("show", !pinned); }, { passive: true });
latest.addEventListener("click", () => { pinned = true; scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }); });
const follow = () => { if (pinned) scrollTo(0, document.documentElement.scrollHeight); };

// Turns the raw log into a readable transcript as it streams in.
let partial = "";
let phase = "";
let block = "prose";
let current = null;

function clean(line) {
  return line.replace(/\\x1b\\[[0-9;?]*[a-zA-Z]/g, "").replace(/\\x1b\\][^\\x07]*\\x07/g, "").split("\\r").pop();
}

function add(node) {
  document.getElementById("empty")?.remove();
  feed.append(node);
  return node;
}

function event(text, tone) {
  const p = document.createElement("p");
  p.className = "event" + (tone ? " " + tone : "");
  const link = /(https:\\/\\/\\S+)/.exec(text);
  if (link) {
    p.append(text.slice(0, link.index));
    const a = document.createElement("a");
    a.href = link[1]; a.textContent = link[1].replace(/^https:\\/\\/(www\\.)?/, ""); a.target = "_blank"; a.rel = "noopener";
    p.append(a);
  } else p.textContent = text;
  add(p);
  current = null;
}

function handle(raw) {
  const line = clean(raw);
  const runner = /^\\d{4}-\\d\\d-\\d\\dT[\\d:]+Z \\[([\\w-]+)\\] (.*)$/.exec(line);
  if (runner) {
    phase = runner[1];
    const text = runner[2];
    if (text.startsWith("message: ")) {
      document.querySelector(".you.pending")?.remove();
      const bubble = document.createElement("p"); bubble.className = "you"; bubble.textContent = text.slice(9);
      add(bubble); current = null; block = "prose";
    } else if (text.startsWith("state failed")) event("The run stopped with an error. The log above says why.", "bad");
    else if (text.startsWith("state ")) return;
    else if (/^(opened|updated)( the)? draft pull request/.test(text)) event(text.replace(/^opened/, "Opened").replace(/^updated/, "Updated"), "good");
    else if (text.startsWith("pushed ")) event("Pushed " + text.slice(7));
    else if (phase !== "run" && phase !== "resume") event(text.charAt(0).toUpperCase() + text.slice(1));
    return;
  }
  // Before the agent starts, raw command output is setup noise.
  if (phase !== "run" && phase !== "resume") return;
  const head = BLOCK_HEADS[line.trim()];
  if (head) { block = head; current = null; return; }
  if (block === "skip") return;
  if (!current || current.dataset.kind !== block) {
    current = document.createElement(block === "exec" || block === "patch" ? "pre" : "p");
    current.className = block === "exec" || block === "patch" ? "code" : block === "thinking" ? "thinking" : "prose";
    current.dataset.kind = block;
    if (block === "prose" || block === "thinking") current.dataset.blank = "1";
    add(current);
  }
  if (current.tagName === "P") {
    if (!line.trim() && current.dataset.blank === "1") return;
    current.dataset.blank = line.trim() ? "0" : "1";
    current.append((current.textContent ? "\\n" : "") + line);
    return;
  }
  const span = document.createElement("span");
  const first = !current.childElementCount;
  span.className = first && block === "exec" ? "cmd" : /^\\+(?!\\+\\+)/.test(line) ? "add" : /^-(?!--)/.test(line) ? "del" : /^ (succeeded|exited|failed) in /.test(line) ? "meta" : "";
  span.textContent = (first && block === "exec" ? line.replace(/^\\/bin\\/(ba)?sh -lc '?(.*?)'? in \\S+$/, "$ $2") : line) + "\\n";
  current.append(span);
}

const events = new EventSource("/_handoff/events");
events.addEventListener("log", (e) => {
  const text = partial + JSON.parse(e.data);
  const lines = text.split("\\n");
  partial = lines.pop();
  lines.forEach(handle);
  follow();
});
events.addEventListener("status", (e) => {
  const { state, pr, title } = JSON.parse(e.data);
  const kind = state.startsWith("failed") ? "failed" : state;
  document.body.dataset.state = kind;
  document.getElementById("state").textContent = states[kind] ?? kind;
  if (title) { document.getElementById("title").textContent = title; document.title = title; }
  const link = document.getElementById("pr");
  if (pr) { link.href = pr; link.hidden = false; }
  document.getElementById("hint").textContent = kind === "completed" || state === "failed:agent"
    ? NAME + " starts on a new message right away, then updates the pull request."
    : NAME + " reads messages when its current turn ends.";
});
events.onopen = () => document.body.classList.remove("offline");
events.onerror = () => { document.body.classList.add("offline"); document.getElementById("hint").textContent = "Reconnecting…"; };

const text = document.getElementById("text");
const go = document.getElementById("go");
const grow = () => { text.style.height = "auto"; text.style.height = Math.min(text.scrollHeight, 152) + "px"; };
text.addEventListener("input", grow);
text.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(pointer: fine)").matches) { e.preventDefault(); go.click(); } });
document.getElementById("send").addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = text.value.trim();
  if (!message) return;
  go.disabled = true;
  // Shows the message at once; the log confirms it when the agent picks it up.
  const bubble = document.createElement("p"); bubble.className = "you pending"; bubble.textContent = message;
  add(bubble); pinned = true; follow();
  try {
    const response = await fetch("/_handoff/message", { method: "POST", body: message });
    if (!response.ok) throw new Error((await response.json()).error);
    text.value = ""; grow();
  } catch (error) {
    bubble.remove();
    document.getElementById("hint").textContent = "Not sent: " + error.message;
  } finally {
    go.disabled = false;
  }
});
</script>
</body>
</html>`;
}
