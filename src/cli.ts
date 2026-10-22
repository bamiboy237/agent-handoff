// `agent-handoff <command>`: check in on a handoff from your own terminal.
//   status [id]          progress, recent remote log, pull request, SSH details
//   work [id] [--diff]   the cloud agent's commits and changed files so far
//   logs [id] [-f]       the remote log; -f keeps following it
//   send [id] <message>  new instructions for the cloud agent
//   ssh [id]             a shell in the sandbox, in the project folder
//   attach [id]          OpenCode's live session in your terminal, to watch and steer
//   stop [id]            stop the cloud agent and its sandbox; pushed branches stay
// Without an id, each command uses the newest handoff for the current repository.
import { execFileSync, spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { TERMINAL_STATES } from "./contract.js";
import {
  describe,
  findHandoff,
  openCodeServer,
  refreshFromSandbox,
  remoteLog,
  remoteWork,
  sendMessage,
  sshDetails,
  stopHandoff,
} from "./checkin.js";

export const CHECK_IN_COMMANDS = new Set(["status", "work", "logs", "send", "ssh", "attach"]);

const FOLLOW_INTERVAL_MS = 2000;

// Accepts a sandbox's host key on first use. Each sandbox is new, so there is no
// earlier key to compare, and a prompt would stall the background tunnel.
const SSH_OPTIONS = "-o StrictHostKeyChecking=accept-new";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function currentRepo(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

// Handoff IDs look like "h" plus base-36 time and hex, such as hmh4q2zc9f1a.
function splitId(args: string[]): { id?: string; rest: string[] } {
  return args[0] && /^h[0-9a-z]{8,}$/.test(args[0]) ? { id: args[0], rest: args.slice(1) } : { rest: args };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs a command in your terminal and resolves with its exit code.
function interactive(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return true;
    await sleep(250);
  }
  return false;
}

async function status(id?: string): Promise<void> {
  let record = findHandoff(id, currentRepo());
  let lines: string[] = [];
  if (record.sandboxId && !TERMINAL_STATES.has(record.state)) ({ record, lines } = await refreshFromSandbox(record));
  console.log(describe(record, lines));
}

async function logs(id: string | undefined, follow: boolean): Promise<void> {
  let record = findHandoff(id, currentRepo());
  let { text, size } = await remoteLog(record);
  process.stdout.write(text);
  if (!follow) return;
  for (let tick = 1; ; tick++) {
    await sleep(FOLLOW_INTERVAL_MS);
    ({ text, size } = await remoteLog(record, size).then((next) => ({ text: next.text, size: next.size })));
    process.stdout.write(text);
    // Checks the run's state every few polls and stops once it is over.
    if (tick % 5 === 0) {
      ({ record } = await refreshFromSandbox(record));
      if (TERMINAL_STATES.has(record.state)) {
        console.log(`\nHandoff ${record.id} is ${record.state}.${record.prUrl ? ` Draft pull request: ${record.prUrl}` : ""}`);
        return;
      }
    }
  }
}

async function ssh(id?: string): Promise<number> {
  const record = findHandoff(id, currentRepo());
  const details = await sshDetails(record);
  const remote = `cd ${shellQuote(record.remoteDir!)} && exec bash -l`;
  return interactive("/bin/sh", ["-c", `${details.command} ${SSH_OPTIONS} -t ${shellQuote(remote)}`]);
}

// Tunnels the sandbox's OpenCode server over SSH and opens the OpenCode TUI on
// the cloud session. You see the agent work live and can type into the session.
async function attach(id?: string): Promise<number> {
  const record = findHandoff(id, currentRepo());
  const server = await openCodeServer(record);
  const details = await sshDetails(record);
  const localPort = await freePort();
  const tunnel = spawn(
    "/bin/sh",
    ["-c", `${details.command} ${SSH_OPTIONS} -N -o ExitOnForwardFailure=yes -L ${localPort}:127.0.0.1:${server.port}`],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  try {
    if (!(await waitForPort(localPort, 20_000))) throw new Error("The SSH tunnel to the sandbox did not open.");
    console.error(`Attached to ${record.id} on ${record.sandboxProvider}. Quitting OpenCode leaves the cloud agent running.`);
    // The password goes to OpenCode through its environment, never onto a command line.
    return await interactive("opencode", ["--server", `http://127.0.0.1:${localPort}`, "--session", server.sessionId], {
      ...process.env,
      ...(server.password ? { OPENCODE_PASSWORD: server.password } : {}),
    });
  } finally {
    tunnel.kill();
  }
}

export async function runCheckIn(command: string, args: string[]): Promise<void> {
  const flags = new Set(args.filter((arg) => arg.startsWith("-")));
  const { id, rest } = splitId(args.filter((arg) => !arg.startsWith("-")));
  try {
    if (command === "status") await status(id);
    else if (command === "work") console.log(await remoteWork(findHandoff(id, currentRepo()), flags.has("--diff")));
    else if (command === "logs") await logs(id, flags.has("-f") || flags.has("--follow"));
    else if (command === "send") {
      const message = rest.join(" ").trim();
      if (!message) throw new Error('usage: agent-handoff send [id] "your instructions"');
      console.log(await sendMessage(findHandoff(id, currentRepo()), message));
    } else if (command === "ssh") process.exitCode = await ssh(id);
    else if (command === "attach") process.exitCode = await attach(id);
    else if (command === "stop") console.log(describe(await stopHandoff(findHandoff(id, currentRepo()))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
