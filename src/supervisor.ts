// What agents launch for the stdio MCP server. It runs the real server as a child
// process and passes messages through. When the install on disk changes, as after
// `agent-handoff update`, the next request goes to a fresh child running the new
// code, so every running agent updates without a restart.
//
// A swap waits until no request is in flight. The new child gets the agent's
// original initialize handshake replayed, its reply is dropped, and the agent is
// told the tool list may have changed.
import { type ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

type Id = string | number;
interface Message {
  id?: Id;
  method?: string;
}

const REPLAY_PREFIX = "agent-handoff-replay-";

export function supervise(entry: string): void {
  // The server module is replaced whenever the install or the build changes.
  const serverFile = join(dirname(entry), "server.js");
  const versionOf = () => {
    try {
      const stat = statSync(serverFile);
      return `${stat.ino}:${stat.mtimeMs}`;
    } catch {
      return "";
    }
  };

  let version = versionOf();
  let handshake: string | undefined; // the agent's initialize request
  let initialized: string | undefined; // and its notifications/initialized
  let replays = 0;
  const inFlight = new Set<Id>(); // agent requests the child has not answered
  const dropReplies = new Set<Id>();
  let child = start();
  let stdinClosed = false;

  function start(): ChildProcess {
    const next = spawn(process.execPath, [entry, "--stdio-child"], { stdio: ["pipe", "pipe", "inherit"] });
    createInterface({ input: next.stdout! }).on("line", (line) => {
      const message = parse(line);
      if (message?.id !== undefined && message.method === undefined) {
        if (dropReplies.delete(message.id)) return;
        inFlight.delete(message.id);
      }
      process.stdout.write(`${line}\n`);
    });
    next.on("exit", (code) => {
      // A child replaced by a newer one exits on purpose; any other exit ends the server.
      if (next === child) process.exit(stdinClosed ? 0 : (code ?? 1));
    });
    return next;
  }

  function swap(): void {
    const old = child;
    child = start();
    old.stdin!.end();
    if (handshake) {
      const id = `${REPLAY_PREFIX}${++replays}`;
      dropReplies.add(id);
      child.stdin!.write(`${JSON.stringify({ ...JSON.parse(handshake), id })}\n`);
      if (initialized) child.stdin!.write(`${initialized}\n`);
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`);
    }
  }

  createInterface({ input: process.stdin })
    .on("line", (line) => {
      const message = parse(line);
      if (message?.method === "initialize") handshake = line;
      else if (message?.method === "notifications/initialized") initialized = line;
      else if (message?.method !== undefined && message.id !== undefined && inFlight.size === 0) {
        const current = versionOf();
        if (current && current !== version) {
          version = current;
          swap();
        }
      }
      if (message?.method !== undefined && message.id !== undefined) inFlight.add(message.id);
      child.stdin!.write(`${line}\n`);
    })
    .on("close", () => {
      stdinClosed = true;
      child.stdin!.end();
    });
}

function parse(line: string): Message | undefined {
  try {
    return JSON.parse(line) as Message;
  } catch {
    return undefined;
  }
}
