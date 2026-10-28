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
import { renderWatchPage } from "./watch-page.mjs";

const HOME = process.env.HANDOFF_HOME;
const PORT = Number(process.env.WATCH_PORT);
const KEY = process.env.WATCH_KEY ?? "";
const AGENT = process.env.TARGET_AGENT ?? "";
const WORKDIR = process.env.WORKDIR ?? "";
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT || 49374);
const LOG = join(HOME, "runner.log");
const COOKIE = "handoff_key";
const BACKLOG_BYTES = 4_000_000; // how much earlier output a new viewer gets; agent events are verbose JSON

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://sandbox");
  if (url.pathname === "/health") return reply(res, 200, { ok: true });
  if (!authorized(req, url)) {
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("This link needs its key. Open the full link from your agent.");
  }
  // The first visit trades the key in the URL for a cookie, then drops it from the address.
  // The Secure flag is only set when the browser-facing scheme is HTTPS: WebKit
  // will not store or send a Secure cookie from a plain HTTP origin, while
  // Chromium allows it on localhost, so an unconditional flag breaks WebKit.
  if (url.searchParams.has("key")) {
    url.searchParams.delete("key");
    const forwardedProto = (req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
    const secureCookie = req.socket.encrypted || forwardedProto === "https" ? "; Secure" : "";
    res.writeHead(303, {
      "set-cookie": `${COOKIE}=${encodeURIComponent(KEY)}; Path=/; HttpOnly${secureCookie}; SameSite=Lax; Max-Age=2592000`,
      location: `${url.pathname}${url.search}`,
    });
    return res.end();
  }
  if (url.pathname === "/_handoff/events") return streamEvents(req, res);
  if (url.pathname === "/_handoff/message" && req.method === "POST") return receiveMessage(req, res);
  const showPage = () => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(renderWatchPage({ agent: AGENT }));
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
