import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, message, user } from "./watch-fixture.mjs";

const home = await mkdtemp(join(tmpdir(), "handoff-preview-"));
const port = process.env.PORT || "4173";
const host = process.env.HOST || "127.0.0.1";
await mkdir(join(home, "inbox"));
await Promise.all([
  writeFile(join(home, "runner.log"), fixture.join("\n") + "\n"),
  writeFile(join(home, "state"), "running"),
  writeFile(join(home, "title.txt"), "Mobile viewer preview"),
]);
const server = spawn(process.execPath, ["remote/watch.mjs"], {
  env: { ...process.env, HANDOFF_HOME: home, WATCH_HOST: host, WATCH_PORT: port, WATCH_KEY: "watch-preview", TARGET_AGENT: "claude", WORKDIR: "/workspace" },
  stdio: "inherit",
});
const seen = new Set();
// Only this synthetic inbox is read. No agent or sandbox is started.
let polling = false;
const timer = setInterval(async () => {
  if (polling) return;
  polling = true;
  try {
    for (const file of await readdir(join(home, "inbox"))) {
      if (seen.has(file)) continue;
      const text = await readFile(join(home, "inbox", file), "utf8");
      await appendFile(join(home, "runner.log"), [
        user(text.replaceAll("\n", " ")),
        message("Preview message received. This is synthetic data; no coding agent is running."),
        "",
      ].join("\n"));
      seen.add(file);
    }
  } catch (error) {
    console.error("Preview inbox:", error.message);
  } finally {
    polling = false;
  }
}, 500);
const stop = () => { clearInterval(timer); server.kill(); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("error", async (error) => {
  clearInterval(timer);
  console.error(error.message);
  await rm(home, { recursive: true, force: true });
  process.exitCode = 1;
});
server.on("exit", async (code, signal) => {
  clearInterval(timer);
  await rm(home, { recursive: true, force: true });
  process.exitCode = signal ? 0 : code ?? 1;
});
console.log(`Synthetic viewer only. Open http://localhost:${port}/?key=watch-preview`);
console.log(`Listening on ${host}. Press Ctrl+C to stop.`);
